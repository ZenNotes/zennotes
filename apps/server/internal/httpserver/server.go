package httpserver

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"log"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/ZenNotes/zennotes/apps/server/internal/config"
	"github.com/ZenNotes/zennotes/apps/server/internal/vault"
	"github.com/ZenNotes/zennotes/apps/server/internal/watcher"
	"github.com/coder/websocket"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

// Per-request body envelope allowances applied on top of the
// configured note/asset size limits. They cover JSON keys + structural
// overhead (writeNote) and multipart boundaries + form fields
// (uploadAsset). Generous enough to never reject a payload that's
// within the configured limit.
const (
	jsonEnvelopeBytes      int64 = 64 << 10  // 64 KiB
	multipartOverheadBytes int64 = 256 << 10 // 256 KiB
)

type Server struct {
	mu              sync.RWMutex
	Config          config.Config
	Vault           *vault.Vault
	Watcher         *watcher.Watcher
	Static          fs.FS // embedded web bundle, may be nil in dev
	sessions        *sessionStore
	loginLimiter    *attemptLimiter
	wsRejectLimiter *attemptLimiter
	loggedOrigins   sync.Map // origin -> struct{}; dedupes CORS-rejection logs
}

func init() {
	// Go's builtin MIME table lacks web-font types, and static assets are served
	// with X-Content-Type-Options: nosniff, so register them explicitly. The web
	// bundle self-hosts Excalidraw's woff2 fonts under /excalidraw-assets/.
	_ = mime.AddExtensionType(".woff2", "font/woff2")
	_ = mime.AddExtensionType(".woff", "font/woff")
	_ = mime.AddExtensionType(".ttf", "font/ttf")
	_ = mime.AddExtensionType(".otf", "font/otf")
}

func New(v *vault.Vault, w *watcher.Watcher, static fs.FS, cfg config.Config) *Server {
	// Opt-in: persist browser sessions next to the host config so they survive a
	// restart. Off by default — an empty path keeps the store purely in-memory.
	sessionsPath := ""
	if cfg.PersistSessions {
		sessionsPath = config.SessionsPath()
	}
	return &Server{
		Vault:           v,
		Watcher:         w,
		Static:          static,
		Config:          cfg,
		sessions:        newSessionStore(sessionsPath),
		loginLimiter:    newAttemptLimiter(10*time.Minute, 10),
		wsRejectLimiter: newAttemptLimiter(1*time.Minute, 20),
	}
}

func (s *Server) currentVault() *vault.Vault {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.Vault
}

func (s *Server) currentWatcher() *watcher.Watcher {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.Watcher
}

func (s *Server) currentConfig() config.Config {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.Config
}

func (s *Server) switchVaultRoot(nextPath string) (*vault.Vault, error) {
	cfg := s.currentConfig()
	nextVault, err := vault.New(nextPath, vault.Options{
		FileMode:      cfg.VaultFileMode,
		DirMode:       cfg.VaultDirMode,
		MaxAssetBytes: cfg.MaxAssetBytes,
	})
	if err != nil {
		return nil, err
	}
	// Non-fatal: a vault switch must not fail just because inotify is
	// unavailable; fall back to a no-op watcher in that case. (#179)
	nextWatcher := watcher.StartOrDisabled(nextVault.Root(), cfg.DisableWatcher)

	s.mu.Lock()
	prevWatcher := s.Watcher
	s.Vault = nextVault
	s.Watcher = nextWatcher
	s.Config.VaultPath = nextVault.Root()
	cfg = s.Config
	s.mu.Unlock()

	if prevWatcher != nil {
		prevWatcher.Close()
	}
	_ = config.SaveHost(cfg)
	return nextVault, nil
}

func (s *Server) Router() http.Handler {
	inner := chi.NewRouter()
	inner.Route("/api", func(r chi.Router) {
		r.Get("/healthz", s.healthz)
		r.Get("/version", s.version)
		r.Get("/capabilities", s.capabilities)
		r.Get("/platform", s.platform)
		r.Get("/session", s.sessionStatus)
		r.Post("/session/login", s.sessionLogin)
		r.Post("/session/logout", s.sessionLogout)

		r.Group(func(r chi.Router) {
			r.Use(s.requireAuth)
			s.registerProtectedRoutes(r)
		})
	})

	// Legacy root-level API compatibility. Keep this around so the web client
	// still works during partial restarts or when an older bundle is cached.
	inner.Get("/healthz", s.healthz)
	inner.Get("/version", s.version)
	inner.Get("/capabilities", s.capabilities)
	inner.Get("/platform", s.platform)
	inner.Get("/session", s.sessionStatus)
	inner.Post("/session/login", s.sessionLogin)
	inner.Post("/session/logout", s.sessionLogout)
	inner.Group(func(r chi.Router) {
		r.Use(s.requireAuth)
		s.registerProtectedRoutes(r)
	})

	// Static / PWA fallback.
	if s.Static != nil {
		inner.Get("/*", s.serveStatic)
	}

	outer := chi.NewRouter()
	outer.Use(middleware.RequestID)
	// Intentionally not using middleware.RealIP: it rewrites
	// r.RemoteAddr from X-Forwarded-For unconditionally, which would
	// let any client spoof the rate-limit and audit identity.
	// clientAddressKey() does trust-aware extraction instead.
	outer.Use(s.securityHeadersMiddleware)
	outer.Use(s.corsMiddleware)
	outer.Use(middleware.Recoverer)

	basePath := s.currentConfig().BasePath
	if basePath != "" {
		outer.Mount(basePath, inner)
		return outer
	}
	outer.Mount("/", inner)
	return outer
}

func (s *Server) registerProtectedRoutes(r chi.Router) {
	r.Post("/session/rotate-token", s.sessionRotateToken)

	r.Get("/vault", s.vaultInfo)
	r.Get("/vault/settings", s.vaultSettings)
	r.Post("/vault/settings", s.setVaultSettings)
	r.Post("/vault/select", s.selectVault)
	r.Get("/fs/browse", s.browseDirectories)

	r.Get("/notes", s.listNotes)
	r.Get("/folders", s.listFolders)
	r.Get("/assets", s.listAssets)
	r.Get("/assets/exists", s.assetsExists)
	r.Get("/assets/raw", s.rawAsset)
	r.Post("/assets/upload", s.uploadAsset)
	r.Post("/assets/rename", s.renameAsset)
	r.Post("/assets/move", s.moveAsset)

	r.Get("/notes/read", s.readNote)
	r.Get("/comments/read", s.readComments)
	r.Post("/comments/write", s.writeComments)
	r.Post("/notes/write", s.writeNote)
	r.Post("/notes/create", s.createNote)
	r.Post("/excalidraw/create", s.createExcalidraw)
	r.Post("/notes/rename", s.renameNote)
	r.Post("/notes/delete", s.deleteNote)
	r.Post("/notes/trash", s.trashNote)
	r.Post("/notes/restore", s.restoreNote)
	r.Post("/notes/empty-trash", s.emptyTrash)
	r.Post("/notes/archive", s.archiveNote)
	r.Post("/notes/unarchive", s.unarchiveNote)
	r.Post("/notes/duplicate", s.duplicateNote)
	r.Post("/notes/move", s.moveNote)

	r.Post("/folders/create", s.createFolder)
	r.Post("/folders/rename", s.renameFolder)
	r.Post("/folders/delete", s.deleteFolder)
	r.Post("/folders/duplicate", s.duplicateFolder)

	r.Get("/search/capabilities", s.searchCapabilities)
	r.Get("/search/text", s.searchText)

	r.Get("/tasks", s.allTasks)
	r.Get("/tasks/for", s.tasksFor)

	r.Post("/demo/generate", s.demoGenerate)
	r.Post("/demo/remove", s.demoRemove)

	r.Get("/watch", s.watchWS)
}

func platformName() string {
	switch runtime.GOOS {
	case "darwin":
		return "darwin"
	case "windows":
		return "win32"
	default:
		return "linux"
	}
}

func (s *Server) requireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cfg := s.currentConfig()
		expected := strings.TrimSpace(cfg.AuthToken)
		if expected == "" {
			next.ServeHTTP(w, r)
			return
		}

		provided := strings.TrimSpace(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
		if subtleCompare(provided, expected) || s.requestAuthenticatedViaSession(r) {
			next.ServeHTTP(w, r)
			return
		}

		if strings.HasSuffix(r.URL.Path, "/watch") || r.URL.Path == "/watch" {
			if !s.wsRejectLimiter.allow(s.clientAddressKey(r)) {
				http.Error(w, "too many unauthorized websocket attempts", http.StatusTooManyRequests)
				return
			}
		}

		w.Header().Set("WWW-Authenticate", `Bearer realm="ZenNotes"`)
		http.Error(w, "unauthorized", http.StatusUnauthorized)
	})
}

// --- Responses ---

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, err error) {
	var statusErr httpStatusError
	if errors.As(err, &statusErr) {
		http.Error(w, statusErr.Error(), statusErr.code)
		return
	}
	if errors.Is(err, vault.ErrPathEscape) {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	log.Printf("handler error: %v", err)
	http.Error(w, "internal server error", http.StatusInternalServerError)
}

func readJSON[T any](r *http.Request, out *T) error {
	return json.NewDecoder(r.Body).Decode(out)
}

// --- Handlers: meta ---

func (s *Server) healthz(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) version(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"version": "0.1.0-web",
		"go":      runtime.Version(),
	})
}

func (s *Server) capabilities(w http.ResponseWriter, _ *http.Request) {
	cfg := s.currentConfig()
	writeJSON(w, http.StatusOK, map[string]any{
		"version":                   "0.1.0-web",
		"platform":                  platformName(),
		"authRequired":              strings.TrimSpace(cfg.AuthToken) != "",
		"supportsSessionLogin":      true,
		"browseRootsEnforced":       !cfg.AllowUnscopedBrowse,
		"supportsVaultSelection":    true,
		"supportsDirectoryBrowsing": true,
		"supportsWatch":             true,
	})
}

func (s *Server) platform(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"platform": platformName()})
}

func (s *Server) vaultInfo(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.currentVault().Info())
}

func (s *Server) vaultSettings(w http.ResponseWriter, _ *http.Request) {
	settings, err := s.currentVault().GetSettings()
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, settings)
}

func (s *Server) setVaultSettings(w http.ResponseWriter, r *http.Request) {
	var req vault.VaultSettings
	if err := readJSON(r, &req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	settings, err := s.currentVault().SetSettings(req)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, settings)
}

func (s *Server) selectVault(w http.ResponseWriter, r *http.Request) {
	if osPath := strings.TrimSpace(os.Getenv("ZENNOTES_VAULT_PATH")); osPath != "" {
		http.Error(w, "vault path is managed by ZENNOTES_VAULT_PATH", http.StatusConflict)
		return
	}
	var req struct {
		Path string `json:"path"`
	}
	if err := readJSON(r, &req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if strings.TrimSpace(req.Path) == "" {
		http.Error(w, "vault path is required", http.StatusBadRequest)
		return
	}
	allowedPath, err := s.ensureBrowsePathAllowed(req.Path)
	if err != nil {
		writeError(w, err)
		return
	}
	nextVault, err := s.switchVaultRoot(allowedPath)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, nextVault.Info())
}

type directoryBrowseEntry struct {
	Name string `json:"name"`
	Path string `json:"path"`
}

type directoryBrowseShortcut struct {
	Label string `json:"label"`
	Path  string `json:"path"`
}

type directoryBrowseResult struct {
	CurrentPath string                    `json:"currentPath"`
	ParentPath  *string                   `json:"parentPath"`
	Entries     []directoryBrowseEntry    `json:"entries"`
	Shortcuts   []directoryBrowseShortcut `json:"shortcuts"`
}

func appendBrowseShortcut(shortcuts []directoryBrowseShortcut, label string, path string) []directoryBrowseShortcut {
	cleaned := strings.TrimSpace(path)
	if cleaned == "" {
		return shortcuts
	}
	for _, shortcut := range shortcuts {
		if shortcut.Path == cleaned {
			return shortcuts
		}
	}
	if info, err := os.Stat(cleaned); err != nil || !info.IsDir() {
		return shortcuts
	}
	return append(shortcuts, directoryBrowseShortcut{Label: label, Path: cleaned})
}

func browseRootLabel(path string, index int) string {
	cleaned := filepath.Clean(path)
	root := filesystemRootForPath(cleaned)
	if cleaned == root {
		return "Mounted Root"
	}
	base := filepath.Base(cleaned)
	if base == "." || base == string(filepath.Separator) || strings.TrimSpace(base) == "" {
		return "Mounted Root"
	}
	if index == 0 {
		return base
	}
	return base
}

func defaultBrowsePath() string {
	if home, err := os.UserHomeDir(); err == nil && strings.TrimSpace(home) != "" {
		return home
	}
	if runtime.GOOS == "windows" {
		return `C:\`
	}
	return string(filepath.Separator)
}

func filesystemRootForPath(p string) string {
	if volume := filepath.VolumeName(p); volume != "" {
		return volume + string(filepath.Separator)
	}
	return string(filepath.Separator)
}

func (s *Server) browseDirectories(w http.ResponseWriter, r *http.Request) {
	requested := strings.TrimSpace(r.URL.Query().Get("path"))
	target := requested
	if target == "" {
		target = s.defaultBrowsePath()
	}
	target, err := s.ensureBrowsePathAllowed(target)
	if err != nil {
		writeError(w, err)
		return
	}

	dirEntries, err := os.ReadDir(target)
	if err != nil {
		writeError(w, err)
		return
	}

	entries := make([]directoryBrowseEntry, 0, len(dirEntries))
	for _, entry := range dirEntries {
		childPath := filepath.Join(target, entry.Name())
		childInfo, err := os.Stat(childPath)
		if err != nil || !childInfo.IsDir() {
			continue
		}
		if _, err := s.ensureBrowsePathAllowed(childPath); err != nil {
			continue
		}
		entries = append(entries, directoryBrowseEntry{
			Name: entry.Name(),
			Path: childPath,
		})
	}
	sort.Slice(entries, func(i, j int) bool {
		left := strings.ToLower(entries[i].Name)
		right := strings.ToLower(entries[j].Name)
		if left == right {
			return entries[i].Name < entries[j].Name
		}
		return left < right
	})

	parentPath := filepath.Dir(target)
	var parent *string
	if parentPath != "" && parentPath != target {
		if allowedParent, err := s.ensureBrowsePathAllowed(parentPath); err == nil {
			parent = &allowedParent
		}
	}

	writeJSON(w, http.StatusOK, directoryBrowseResult{
		CurrentPath: target,
		ParentPath:  parent,
		Entries:     entries,
		Shortcuts:   s.browseShortcuts(),
	})
}

// --- Listing ---

func (s *Server) listNotes(w http.ResponseWriter, _ *http.Request) {
	notes, err := s.currentVault().ListNotes()
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, notes)
}

func (s *Server) listFolders(w http.ResponseWriter, _ *http.Request) {
	folders, err := s.currentVault().ListFolders()
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, folders)
}

func (s *Server) listAssets(w http.ResponseWriter, _ *http.Request) {
	assets, err := s.currentVault().ListAssets()
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, assets)
}

func (s *Server) assetsExists(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]bool{"exists": s.currentVault().HasAssetsDir()})
}

// --- Notes ---

func (s *Server) readNote(w http.ResponseWriter, r *http.Request) {
	rel := r.URL.Query().Get("path")
	note, err := s.currentVault().ReadNote(rel)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, note)
}

func (s *Server) readComments(w http.ResponseWriter, r *http.Request) {
	rel := r.URL.Query().Get("path")
	comments, err := s.currentVault().ReadNoteComments(rel)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, comments)
}

func (s *Server) writeComments(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Path     string              `json:"path"`
		Comments []vault.NoteComment `json:"comments"`
	}
	if err := readJSON(r, &req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	comments, err := s.currentVault().WriteNoteComments(req.Path, req.Comments)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, comments)
}

func (s *Server) writeNote(w http.ResponseWriter, r *http.Request) {
	cfg := s.currentConfig()
	r.Body = http.MaxBytesReader(w, r.Body, cfg.MaxNoteBytes+jsonEnvelopeBytes)
	var req struct {
		Path string `json:"path"`
		Body string `json:"body"`
	}
	if err := readJSON(r, &req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	meta, err := s.currentVault().WriteNote(req.Path, req.Body)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, meta)
}

func (s *Server) createNote(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Folder  vault.NoteFolder `json:"folder"`
		Title   string           `json:"title"`
		Subpath string           `json:"subpath"`
	}
	if err := readJSON(r, &req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	meta, err := s.currentVault().CreateNote(req.Folder, req.Title, req.Subpath)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, meta)
}

func (s *Server) createExcalidraw(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Folder  vault.NoteFolder `json:"folder"`
		Title   string           `json:"title"`
		Subpath string           `json:"subpath"`
	}
	if err := readJSON(r, &req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	meta, err := s.currentVault().CreateExcalidraw(req.Folder, req.Title, req.Subpath)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, meta)
}

func (s *Server) renameNote(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Path  string `json:"path"`
		Title string `json:"title"`
	}
	if err := readJSON(r, &req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	meta, err := s.currentVault().RenameNote(req.Path, req.Title)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, meta)
}

func (s *Server) deleteNote(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Path string `json:"path"`
	}
	if err := readJSON(r, &req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if err := s.currentVault().DeleteNote(req.Path); err != nil {
		writeError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) trashNote(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Path string `json:"path"`
	}
	if err := readJSON(r, &req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	meta, err := s.currentVault().MoveToTrash(req.Path)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, meta)
}

func (s *Server) restoreNote(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Path string `json:"path"`
	}
	if err := readJSON(r, &req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	meta, err := s.currentVault().RestoreFromTrash(req.Path)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, meta)
}

func (s *Server) emptyTrash(w http.ResponseWriter, _ *http.Request) {
	if err := s.currentVault().EmptyTrash(); err != nil {
		writeError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) archiveNote(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Path string `json:"path"`
	}
	if err := readJSON(r, &req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	meta, err := s.currentVault().ArchiveNote(req.Path)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, meta)
}

func (s *Server) unarchiveNote(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Path string `json:"path"`
	}
	if err := readJSON(r, &req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	meta, err := s.currentVault().UnarchiveNote(req.Path)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, meta)
}

func (s *Server) duplicateNote(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Path string `json:"path"`
	}
	if err := readJSON(r, &req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	meta, err := s.currentVault().DuplicateNote(req.Path)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, meta)
}

func (s *Server) moveNote(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Path          string           `json:"path"`
		TargetFolder  vault.NoteFolder `json:"targetFolder"`
		TargetSubpath string           `json:"targetSubpath"`
	}
	if err := readJSON(r, &req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	meta, err := s.currentVault().MoveNote(req.Path, req.TargetFolder, req.TargetSubpath)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, meta)
}

// --- Folders ---

func (s *Server) createFolder(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Folder  vault.NoteFolder `json:"folder"`
		Subpath string           `json:"subpath"`
	}
	if err := readJSON(r, &req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if err := s.currentVault().CreateFolder(req.Folder, req.Subpath); err != nil {
		writeError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) renameFolder(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Folder     vault.NoteFolder `json:"folder"`
		OldSubpath string           `json:"oldSubpath"`
		NewSubpath string           `json:"newSubpath"`
	}
	if err := readJSON(r, &req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	out, err := s.currentVault().RenameFolder(req.Folder, req.OldSubpath, req.NewSubpath)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"subpath": out})
}

func (s *Server) deleteFolder(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Folder  vault.NoteFolder `json:"folder"`
		Subpath string           `json:"subpath"`
	}
	if err := readJSON(r, &req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if err := s.currentVault().DeleteFolder(req.Folder, req.Subpath); err != nil {
		writeError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) duplicateFolder(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Folder  vault.NoteFolder `json:"folder"`
		Subpath string           `json:"subpath"`
	}
	if err := readJSON(r, &req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	out, err := s.currentVault().DuplicateFolder(req.Folder, req.Subpath)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"subpath": out})
}

// --- Tasks + Search ---

func (s *Server) allTasks(w http.ResponseWriter, _ *http.Request) {
	tasks, err := s.currentVault().ScanTasks()
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, tasks)
}

func (s *Server) tasksFor(w http.ResponseWriter, r *http.Request) {
	rel := r.URL.Query().Get("path")
	tasks, err := s.currentVault().ScanTasksForPath(rel)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, tasks)
}

func (s *Server) searchCapabilities(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.currentVault().SearchCapabilities())
}

func (s *Server) searchText(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query().Get("q")
	matches, err := s.currentVault().SearchText(q)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, matches)
}

// --- Demo tour ---

func (s *Server) demoGenerate(w http.ResponseWriter, _ *http.Request) {
	res, err := s.currentVault().GenerateDemoTour()
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (s *Server) demoRemove(w http.ResponseWriter, _ *http.Request) {
	res, err := s.currentVault().RemoveDemoTour()
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// --- Assets ---

func (s *Server) rawAsset(w http.ResponseWriter, r *http.Request) {
	rel := r.URL.Query().Get("path")
	abs, err := s.currentVault().AssetAbsPath(rel)
	if err != nil {
		writeError(w, err)
		return
	}
	ext := strings.ToLower(filepath.Ext(abs))
	if t := mime.TypeByExtension(ext); t != "" {
		w.Header().Set("Content-Type", t)
	}
	w.Header().Set("Cache-Control", "private, max-age=3600")
	http.ServeFile(w, r, abs)
}

func (s *Server) uploadAsset(w http.ResponseWriter, r *http.Request) {
	cfg := s.currentConfig()
	r.Body = http.MaxBytesReader(w, r.Body, cfg.MaxAssetBytes+multipartOverheadBytes)
	if err := r.ParseMultipartForm(8 << 20); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	notePath := r.FormValue("notePath")
	file, header, err := r.FormFile("file")
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	defer file.Close()
	asset, err := s.currentVault().ImportAsset(notePath, header.Filename, file)
	if err != nil {
		if errors.Is(err, vault.ErrAssetTooLarge) {
			http.Error(w, "asset too large", http.StatusRequestEntityTooLarge)
			return
		}
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, asset)
}

func (s *Server) renameAsset(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Path string `json:"path"`
		Name string `json:"name"`
	}
	if err := readJSON(r, &req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	meta, err := s.currentVault().RenameAsset(req.Path, req.Name)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, meta)
}

func (s *Server) moveAsset(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Path      string `json:"path"`
		TargetDir string `json:"targetDir"`
	}
	if err := readJSON(r, &req); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	meta, err := s.currentVault().MoveAsset(req.Path, req.TargetDir)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, meta)
}

// --- WebSocket watcher ---

func (s *Server) watchWS(w http.ResponseWriter, r *http.Request) {
	origin := strings.TrimSpace(r.Header.Get("Origin"))
	if origin != "" && !s.isAllowedOrigin(r, origin) {
		if !s.wsRejectLimiter.allow(s.clientAddressKey(r)) {
			http.Error(w, "too many invalid websocket origins", http.StatusTooManyRequests)
			return
		}
		http.Error(w, "forbidden origin", http.StatusForbidden)
		return
	}
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		InsecureSkipVerify: true,
	})
	if err != nil {
		log.Printf("ws accept failed: %v", err)
		return
	}
	defer ws.Close(websocket.StatusNormalClosure, "")
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	events, unsubscribe := s.currentWatcher().Subscribe()
	defer unsubscribe()

	pingTicker := time.NewTicker(25 * time.Second)
	defer pingTicker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case ev, ok := <-events:
			if !ok {
				return
			}
			payload, _ := json.Marshal(ev)
			if err := ws.Write(ctx, websocket.MessageText, payload); err != nil {
				return
			}
		case <-pingTicker.C:
			if err := ws.Ping(ctx); err != nil {
				return
			}
		}
	}
}

// --- Static / PWA fallback ---

func (s *Server) serveStatic(w http.ResponseWriter, r *http.Request) {
	// chi's Mount routes by a stripped path but leaves r.URL.Path intact,
	// so under a base-path deploy this still carries the prefix (e.g.
	// "/zennotes/assets/app.css"). Trim it before resolving against the
	// embedded bundle, otherwise every asset misses and falls back to
	// index.html with a text/html MIME type (issue #58).
	urlPath := r.URL.Path
	if basePath := s.currentConfig().BasePath; basePath != "" {
		urlPath = strings.TrimPrefix(urlPath, basePath)
	}
	urlPath = strings.TrimPrefix(urlPath, "/")
	if urlPath == "" {
		urlPath = "index.html"
	}
	f, err := s.Static.Open(urlPath)
	if err != nil {
		// SPA fallback: serve index.html for unknown paths.
		s.serveIndexHTML(w)
		return
	}
	defer f.Close()
	if urlPath == "index.html" {
		s.serveIndexHTML(w)
		return
	}
	ext := strings.ToLower(filepath.Ext(urlPath))
	if t := mime.TypeByExtension(ext); t != "" {
		w.Header().Set("Content-Type", t)
	}
	_, _ = copyReadSeeker(w, f)
}

// serveIndexHTML reads the SPA shell from the embedded bundle and
// returns it with a small runtime patch so the JS bundle knows which
// base path to use for API + WebSocket calls.
func (s *Server) serveIndexHTML(w http.ResponseWriter) {
	f, err := s.Static.Open("index.html")
	if err != nil {
		http.NotFound(w, nil)
		return
	}
	defer f.Close()

	body, err := readAll(f)
	if err != nil {
		http.NotFound(w, nil)
		return
	}

	basePath := s.currentConfig().BasePath
	if basePath != "" {
		body = injectBasePathHint(body, basePath)
	}

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	_, _ = w.Write(body)
}

func readAll(f fs.File) ([]byte, error) {
	buf := make([]byte, 0, 4*1024)
	tmp := make([]byte, 4*1024)
	for {
		n, err := f.Read(tmp)
		if n > 0 {
			buf = append(buf, tmp[:n]...)
		}
		if err != nil {
			if err.Error() == "EOF" {
				return buf, nil
			}
			return nil, err
		}
	}
}

// injectBasePathHint splices a `<meta name="zn-base-path" ...>` tag into
// the SPA shell so the bundled JS can route API calls through the
// configured prefix. A meta tag (instead of an inline script) keeps us
// inside the strict CSP — script-src is locked to 'self'.
func injectBasePathHint(body []byte, basePath string) []byte {
	snippet := []byte(`<meta name="zn-base-path" content="` + htmlAttrEscape(basePath) + `">`)
	if idx := indexOfFold(body, []byte("</head>")); idx >= 0 {
		out := make([]byte, 0, len(body)+len(snippet))
		out = append(out, body[:idx]...)
		out = append(out, snippet...)
		out = append(out, body[idx:]...)
		return out
	}
	return append(snippet, body...)
}

// htmlAttrEscape escapes the characters that would let a base-path
// value break out of a double-quoted HTML attribute.
func htmlAttrEscape(value string) string {
	replacer := strings.NewReplacer(
		"&", "&amp;",
		"\"", "&quot;",
		"<", "&lt;",
		">", "&gt;",
	)
	return replacer.Replace(value)
}

func indexOfFold(haystack, needle []byte) int {
	n := len(needle)
	if n == 0 || n > len(haystack) {
		return -1
	}
	for i := 0; i+n <= len(haystack); i++ {
		match := true
		for j := 0; j < n; j++ {
			a := haystack[i+j]
			b := needle[j]
			if a >= 'A' && a <= 'Z' {
				a += 'a' - 'A'
			}
			if b >= 'A' && b <= 'Z' {
				b += 'a' - 'A'
			}
			if a != b {
				match = false
				break
			}
		}
		if match {
			return i
		}
	}
	return -1
}

func copyReadSeeker(w http.ResponseWriter, f fs.File) (int64, error) {
	if rs, ok := f.(interface {
		Read(p []byte) (int, error)
	}); ok {
		buf := make([]byte, 32*1024)
		var total int64
		for {
			n, err := rs.Read(buf)
			if n > 0 {
				if _, werr := w.Write(buf[:n]); werr != nil {
					return total, werr
				}
				total += int64(n)
			}
			if err != nil {
				if err.Error() == "EOF" {
					return total, nil
				}
				return total, err
			}
		}
	}
	return 0, nil
}

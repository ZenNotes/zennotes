package watcher

import (
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/ZenNotes/zennotes/apps/server/internal/vault"
	"github.com/fsnotify/fsnotify"
)

const (
	internalVaultDir      = ".zennotes"
	vaultSettingsFilePath = ".zennotes/vault.json"
	noteCommentsPrefix    = ".zennotes/comments/"
	noteCommentsSuffix    = ".comments.json"
)

// Watcher recursively watches the vault root and fans out change
// events to any subscribed channels. Mirrors the chokidar-based
// watcher in src/main/watcher.ts.
type Watcher struct {
	root   string
	fs     *fsnotify.Watcher
	mu     sync.Mutex
	subs   map[chan vault.ChangeEvent]struct{}
	closed bool
	stopCh chan struct{}
	// dirs tracks the absolute paths we believe are directories, so a
	// remove/rename event (which can't be os.Stat'd) can still be recognized
	// as a folder change. Only touched from the single loop goroutine (and
	// Start, before the loop begins), so it needs no separate lock.
	dirs map[string]struct{}
	// folderPaths holds the systemFolderPaths from vault settings for
	// classifying note paths to folder IDs.
	folderPaths map[string]string
}

func (w *Watcher) SetFolderPaths(paths map[string]string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.folderPaths = paths
}

func (w *Watcher) getFolderPaths() map[string]string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.folderPaths
}

// reloadFolderPaths re-reads the folder overrides after vault.json changes.
// The raw map goes through the vault's normalizer, exactly as the paths seeded
// at startup did (main.go reads them from vault.GetSettings). A value the
// normalizer rejects, `trash: "assets"` say, would otherwise make the watcher
// route assets/ events to Trash while the vault, which classifies against the
// normalized settings, disagrees.
func (w *Watcher) reloadFolderPaths() {
	settingsPath := filepath.Join(w.root, vaultSettingsFilePath)
	raw, err := os.ReadFile(settingsPath)
	if err != nil {
		// A deleted vault.json means no overrides, which is what the vault
		// reports too. Any other read error leaves the last known paths in place.
		if os.IsNotExist(err) {
			w.SetFolderPaths(nil)
		}
		return
	}
	var settings struct {
		SystemFolderPaths map[string]string `json:"systemFolderPaths"`
	}
	if err := json.Unmarshal(raw, &settings); err != nil {
		return
	}
	w.SetFolderPaths(vault.NormalizeSystemFolderPaths(settings.SystemFolderPaths))
}

func Start(root string) (*Watcher, error) {
	fsw, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}
	w := &Watcher{
		root:        root,
		fs:          fsw,
		subs:        map[chan vault.ChangeEvent]struct{}{},
		stopCh:      make(chan struct{}),
		dirs:        map[string]struct{}{},
		folderPaths: nil,
	}
	// Recursively add all existing directories under the vault.
	var addErrs int
	var firstAddErr error
	_ = filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			name := d.Name()
			if path != root && strings.HasPrefix(name, ".") && name != internalVaultDir {
				return filepath.SkipDir
			}
			// Don't discard the error: inotify can be exhausted or restricted
			// (notably in unprivileged LXC containers), and a silent failure
			// leaves clients without live updates for no apparent reason. (#179)
			if addErr := fsw.Add(path); addErr != nil {
				addErrs++
				if firstAddErr == nil {
					firstAddErr = addErr
				}
			}
			w.dirs[path] = struct{}{}
		}
		return nil
	})
	if addErrs > 0 {
		log.Printf("watcher: could not watch %d director(ies) (first error: %v); live updates may be incomplete — set ZENNOTES_DISABLE_WATCHER=1 if this environment restricts inotify (e.g. unprivileged LXC)", addErrs, firstAddErr)
	}
	go w.loop()
	return w, nil
}

// Disabled returns a watcher that does no filesystem watching. It still
// supports Subscribe/Close so the rest of the server can treat it like a real
// watcher; it simply never emits change events. Used where inotify is
// unavailable or explicitly turned off — notably unprivileged LXC containers,
// where inotify operations can wedge the process (unkillable, bind-mount
// locked) instead of returning an error. (#179)
func Disabled(root string) *Watcher {
	w := &Watcher{
		root:   root,
		fs:     nil,
		subs:   map[chan vault.ChangeEvent]struct{}{},
		stopCh: make(chan struct{}),
		dirs:   map[string]struct{}{},
	}
	go w.loop()
	return w
}

// StartOrDisabled starts a real watcher, or falls back to a no-op watcher when
// watching is turned off (disable) or unavailable. It never returns an error,
// so the server can always serve the vault even where inotify is restricted. (#179)
func StartOrDisabled(root string, disable bool) *Watcher {
	if disable {
		log.Printf("watcher: disabled via ZENNOTES_DISABLE_WATCHER; live updates are off")
		return Disabled(root)
	}
	w, err := Start(root)
	if err != nil {
		log.Printf("watcher: unavailable (%v); continuing without live updates — set ZENNOTES_DISABLE_WATCHER=1 to disable watching explicitly", err)
		return Disabled(root)
	}
	return w
}

// Active reports whether this watcher really watches the filesystem. The
// Disabled fallback (inotify unavailable or explicitly off, #179) has no
// fsnotify handle and never emits an event; capabilities must not promise
// live updates it cannot deliver, or clients skip polling AND never hear
// about changes.
func (w *Watcher) Active() bool {
	return w != nil && w.fs != nil
}

func (w *Watcher) Subscribe() (<-chan vault.ChangeEvent, func()) {
	ch := make(chan vault.ChangeEvent, 64)
	w.mu.Lock()
	w.subs[ch] = struct{}{}
	w.mu.Unlock()
	return ch, func() {
		w.mu.Lock()
		if _, ok := w.subs[ch]; ok {
			delete(w.subs, ch)
			close(ch)
		}
		w.mu.Unlock()
	}
}

func (w *Watcher) Close() {
	w.mu.Lock()
	if w.closed {
		w.mu.Unlock()
		return
	}
	w.closed = true
	close(w.stopCh)
	for ch := range w.subs {
		delete(w.subs, ch)
		close(ch)
	}
	w.mu.Unlock()
	if w.fs != nil {
		_ = w.fs.Close()
	}
}

func (w *Watcher) loop() {
	// A disabled (no-op) watcher has no fsnotify handle — just block until close.
	if w.fs == nil {
		<-w.stopCh
		return
	}
	for {
		select {
		case <-w.stopCh:
			return
		case err, ok := <-w.fs.Errors:
			if !ok {
				return
			}
			log.Printf("watcher error: %v", err)
		case ev, ok := <-w.fs.Events:
			if !ok {
				return
			}
			w.handle(ev)
		}
	}
}

func (w *Watcher) relativePath(absPath string) string {
	rel, err := filepath.Rel(w.root, absPath)
	if err != nil {
		return ""
	}
	return filepath.ToSlash(rel)
}

func (w *Watcher) isVaultSettingsPath(absPath string) bool {
	return w.relativePath(absPath) == vaultSettingsFilePath
}

func (w *Watcher) commentsNotePath(absPath string) (string, bool) {
	rel := w.relativePath(absPath)
	if !strings.HasPrefix(rel, noteCommentsPrefix) || !strings.HasSuffix(rel, noteCommentsSuffix) {
		return "", false
	}
	return strings.TrimSuffix(strings.TrimPrefix(rel, noteCommentsPrefix), noteCommentsSuffix), true
}

func (w *Watcher) handle(ev fsnotify.Event) {
	base := filepath.Base(ev.Name)
	// The scratch file every atomic write renames from. Its create/write/rename
	// burst is not a vault change, and since the name does not end in .md a
	// client would answer each one by re-listing the whole asset tree.
	if vault.IsAtomicWriteTempPath(ev.Name) {
		return
	}
	if strings.HasPrefix(base, ".") && !w.isVaultSettingsPath(ev.Name) && base != internalVaultDir {
		return
	}
	info, statErr := os.Stat(ev.Name)
	if statErr == nil && info.IsDir() {
		if ev.Op&fsnotify.Create != 0 {
			if err := w.fs.Add(ev.Name); err != nil {
				log.Printf("watcher: cannot watch new directory %s: %v", ev.Name, err)
			}
			w.dirs[ev.Name] = struct{}{}
			// An empty folder produces no note event, so clients would never
			// learn about it until a manual refresh. Surface it explicitly.
			w.broadcastFolder(ev.Name, "add")
		}
		return
	}
	// A removed/renamed path we had tracked as a directory. We can't os.Stat
	// it anymore, so the tracking set is what tells us it was a folder.
	if statErr != nil {
		if _, ok := w.dirs[ev.Name]; ok {
			delete(w.dirs, ev.Name)
			w.broadcastFolder(ev.Name, "unlink")
			return
		}
	}
	relPosix := w.relativePath(ev.Name)
	if relPosix == "" {
		return
	}
	if relPosix == vaultSettingsFilePath {
		w.reloadFolderPaths()
		kind := eventKind(ev, statErr == nil)
		if kind == "" {
			return
		}
		w.broadcast(vault.ChangeEvent{
			Kind:   kind,
			Path:   relPosix,
			Folder: vault.FolderInbox,
			Scope:  "vault-settings",
		})
		return
	}
	if notePath, ok := w.commentsNotePath(ev.Name); ok {
		kind := eventKind(ev, statErr == nil)
		if kind == "" {
			return
		}
		folder, ok := vault.FolderForRelativePathWithSettings(notePath, w.getFolderPaths())
		if !ok {
			folder = vault.FolderInbox
		}
		w.broadcast(vault.ChangeEvent{
			Kind:   kind,
			Path:   notePath,
			Folder: folder,
			Scope:  "comments",
		})
		return
	}
	if strings.HasPrefix(relPosix, ".") || strings.Contains(relPosix, "/.") {
		return
	}
	folder, ok := vault.FolderForRelativePathWithSettings(relPosix, w.getFolderPaths())
	if !ok {
		if relPosix == vault.AssetsDir ||
			strings.HasPrefix(relPosix, vault.AssetsDir+"/") ||
			relPosix == vault.PrimaryAttachmentsDir ||
			strings.HasPrefix(relPosix, vault.PrimaryAttachmentsDir+"/") ||
			relPosix == "_assets" ||
			strings.HasPrefix(relPosix, "_assets/") {
			folder = vault.FolderInbox
		} else {
			return
		}
	}

	kind := eventKind(ev, statErr == nil)
	if kind == "" {
		return
	}

	change := vault.ChangeEvent{
		Kind:   kind,
		Path:   relPosix,
		Folder: folder,
	}

	w.broadcast(change)
}

// exists says whether the path was still on disk when the event was handled,
// which is what separates a deleted note from a replaced one.
func eventKind(ev fsnotify.Event, exists bool) string {
	switch {
	case ev.Op&fsnotify.Create != 0:
		return "add"
	case ev.Op&fsnotify.Write != 0:
		return "change"
	case ev.Op&fsnotify.Remove != 0, ev.Op&fsnotify.Rename != 0:
		// A rename into place, which is what every atomic save is, drops the
		// old directory entry while the replacement is already sitting there.
		// The kqueue backend (a server hosted on macOS) reports that as a
		// delete of the note itself, and a client told its open note was
		// deleted closes the tab. A path that still exists was replaced.
		if exists {
			return "add"
		}
		return "unlink"
	default:
		return ""
	}
}

func (w *Watcher) broadcastFolder(absPath, kind string) {
	rel := w.relativePath(absPath)
	if rel == "" {
		return
	}
	folder, ok := vault.FolderForRelativePathWithSettings(rel, w.getFolderPaths())
	if !ok {
		return
	}
	w.broadcast(vault.ChangeEvent{
		Kind:   kind,
		Path:   rel,
		Folder: folder,
		Scope:  "folder",
	})
}

func (w *Watcher) broadcast(change vault.ChangeEvent) {
	w.mu.Lock()
	for ch := range w.subs {
		select {
		case ch <- change:
		default:
		}
	}
	w.mu.Unlock()
}

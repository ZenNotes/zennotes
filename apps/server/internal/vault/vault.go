package vault

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	PrimaryAttachmentsDir = "attachements"
	internalVaultDir      = ".zennotes"
	vaultSettingsFile     = "vault.json"
)

var legacyAttachmentsDirs = []string{"_assets"}
var reservedRootNames = map[string]struct{}{
	string(FolderInbox):   {},
	string(FolderQuick):   {},
	string(FolderArchive): {},
	string(FolderTrash):   {},
	PrimaryAttachmentsDir: {},
	internalVaultDir:      {},
}

var hiddenPrimaryRootNames = map[string]struct{}{
	string(FolderQuick):   {},
	string(FolderArchive): {},
	string(FolderTrash):   {},
	PrimaryAttachmentsDir: {},
	internalVaultDir:      {},
}

func init() {
	for _, dir := range legacyAttachmentsDirs {
		reservedRootNames[dir] = struct{}{}
		hiddenPrimaryRootNames[dir] = struct{}{}
	}
}

func shouldHidePrimaryRootName(name string) bool {
	_, hidden := hiddenPrimaryRootNames[name]
	return hidden
}

// Vault encapsulates all operations against a filesystem vault root.
// It is concurrency-safe at the public-method level; internally most
// ops do a short RW-lock dance around mutating operations.
type Vault struct {
	root string
	mu   sync.RWMutex
}

func New(root string) (*Vault, error) {
	abs, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(abs, 0o755); err != nil {
		return nil, err
	}
	v := &Vault{root: abs}
	if err := v.EnsureLayout(); err != nil {
		return nil, err
	}
	return v, nil
}

func (v *Vault) Root() string {
	return v.root
}

func (v *Vault) Info() VaultInfo {
	return VaultInfo{Root: v.root, Name: filepath.Base(v.root)}
}

func cloneSettings(settings VaultSettings) VaultSettings {
	return VaultSettings{
		PrimaryNotesLocation: settings.PrimaryNotesLocation,
		DailyNotes: DailyNotesSettings{
			Enabled:   settings.DailyNotes.Enabled,
			Directory: settings.DailyNotes.Directory,
		},
	}
}

func normalizeDailyNotesDirectory(value string) string {
	trimmed := strings.Trim(value, "/")
	if trimmed == "" {
		return DefaultDailyNotesDirectory
	}
	return trimmed
}

func normalizePrimaryNotesLocation(value PrimaryNotesLocation) PrimaryNotesLocation {
	if value == PrimaryNotesRoot {
		return PrimaryNotesRoot
	}
	return PrimaryNotesInbox
}

func normalizeVaultSettings(value VaultSettings, fallbackPrimary PrimaryNotesLocation) VaultSettings {
	return VaultSettings{
		PrimaryNotesLocation: normalizePrimaryNotesLocation(func() PrimaryNotesLocation {
			if value.PrimaryNotesLocation == "" {
				return fallbackPrimary
			}
			return value.PrimaryNotesLocation
		}()),
		DailyNotes: DailyNotesSettings{
			Enabled:   value.DailyNotes.Enabled,
			Directory: normalizeDailyNotesDirectory(value.DailyNotes.Directory),
		},
	}
}

func (v *Vault) settingsPath() string {
	return filepath.Join(v.root, internalVaultDir, vaultSettingsFile)
}

func (v *Vault) inferPrimaryNotesLocation() PrimaryNotesLocation {
	entries, err := os.ReadDir(v.root)
	if err != nil {
		return PrimaryNotesInbox
	}
	for _, entry := range entries {
		name := entry.Name()
		if strings.HasPrefix(name, ".") {
			continue
		}
		if _, reserved := reservedRootNames[name]; reserved {
			continue
		}
		if entry.IsDir() || strings.EqualFold(filepath.Ext(name), ".md") {
			return PrimaryNotesRoot
		}
	}
	return PrimaryNotesInbox
}

func (v *Vault) vaultLooksEmpty() bool {
	entries, err := os.ReadDir(v.root)
	if err != nil {
		return true
	}
	for _, entry := range entries {
		name := entry.Name()
		if strings.HasPrefix(name, ".") || name == internalVaultDir {
			continue
		}
		return false
	}
	return true
}

func (v *Vault) GetSettings() (VaultSettings, error) {
	fallbackPrimary := v.inferPrimaryNotesLocation()
	raw, err := os.ReadFile(v.settingsPath())
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return normalizeVaultSettings(VaultSettings{}, fallbackPrimary), nil
		}
		return VaultSettings{}, err
	}
	var settings VaultSettings
	if err := json.Unmarshal(raw, &settings); err != nil {
		return VaultSettings{}, err
	}
	return normalizeVaultSettings(settings, fallbackPrimary), nil
}

func (v *Vault) SetSettings(next VaultSettings) (VaultSettings, error) {
	fallbackPrimary := v.inferPrimaryNotesLocation()
	normalized := normalizeVaultSettings(next, fallbackPrimary)
	if err := os.MkdirAll(filepath.Dir(v.settingsPath()), 0o755); err != nil {
		return VaultSettings{}, err
	}
	data, err := json.MarshalIndent(normalized, "", "  ")
	if err != nil {
		return VaultSettings{}, err
	}
	if err := os.WriteFile(v.settingsPath(), data, 0o644); err != nil {
		return VaultSettings{}, err
	}
	if normalized.PrimaryNotesLocation == PrimaryNotesInbox {
		if err := os.MkdirAll(filepath.Join(v.root, string(FolderInbox)), 0o755); err != nil {
			return VaultSettings{}, err
		}
	}
	return cloneSettings(normalized), nil
}

func (v *Vault) primaryNotesRoot() (string, error) {
	settings, err := v.GetSettings()
	if err != nil {
		return "", err
	}
	if settings.PrimaryNotesLocation == PrimaryNotesRoot {
		return v.root, nil
	}
	return filepath.Join(v.root, string(FolderInbox)), nil
}

func (v *Vault) folderRoot(folder NoteFolder) (string, error) {
	if folder == FolderInbox {
		return v.primaryNotesRoot()
	}
	return filepath.Join(v.root, string(folder)), nil
}

// EnsureLayout creates the four top-level folders and seeds a welcome
// note if the vault is empty. Matches src/main/vault.ts ensureVaultLayout.
func (v *Vault) EnsureLayout() error {
	wasEmpty := v.vaultLooksEmpty()
	settings, err := v.GetSettings()
	if err != nil {
		return err
	}
	for _, f := range AllFolders {
		if f == FolderInbox && settings.PrimaryNotesLocation == PrimaryNotesRoot {
			continue
		}
		if err := os.MkdirAll(filepath.Join(v.root, string(f)), 0o755); err != nil {
			return err
		}
	}
	if wasEmpty {
		welcomeDir, err := v.primaryNotesRoot()
		if err != nil {
			return err
		}
		if err := os.MkdirAll(welcomeDir, 0o755); err != nil {
			return err
		}
		welcome := filepath.Join(welcomeDir, "Welcome.md")
		if _, err := os.Stat(welcome); errors.Is(err, os.ErrNotExist) {
			_ = os.WriteFile(welcome, []byte(welcomeNote), 0o644)
		}
	}
	return nil
}

// --- Listing ---

// ListNotes walks every top-level folder and returns metadata for each
// note. Sibling order is the directory-listing order per folder, which
// matches the TS version's behaviour for non-sorted filesystems.
func (v *Vault) ListNotes() ([]NoteMeta, error) {
	v.mu.RLock()
	defer v.mu.RUnlock()

	out := []NoteMeta{}
	for _, folder := range AllFolders {
		folderRoot, err := v.folderRoot(folder)
		if err != nil {
			return nil, err
		}
		isPrimaryRoot := folder == FolderInbox && filepath.Clean(folderRoot) == filepath.Clean(v.root)
		err = filepath.WalkDir(folderRoot, func(path string, d os.DirEntry, err error) error {
			if err != nil {
				if errors.Is(err, os.ErrNotExist) {
					return nil
				}
				return err
			}
			if d.IsDir() {
				if strings.HasPrefix(d.Name(), ".") && path != folderRoot {
					return filepath.SkipDir
				}
				if isPrimaryRoot && path != folderRoot {
					parent := filepath.Dir(path)
					if filepath.Clean(parent) == filepath.Clean(folderRoot) {
						if shouldHidePrimaryRootName(d.Name()) {
							return filepath.SkipDir
						}
					}
				}
				return nil
			}
			if isPrimaryRoot {
				parent := filepath.Dir(path)
				if filepath.Clean(parent) == filepath.Clean(folderRoot) {
					if shouldHidePrimaryRootName(d.Name()) {
						return filepath.SkipDir
					}
				}
			}
			if !strings.EqualFold(filepath.Ext(d.Name()), ".md") {
				return nil
			}
			meta, err := v.readMeta(folder, path)
			if err != nil {
				return nil // skip unreadable files silently
			}
			out = append(out, meta)
			return nil
		})
		if err != nil {
			return nil, err
		}
	}

	// sibling order per directory (by appearance in out for that dir)
	assignSiblingOrder(out, func(m NoteMeta) string {
		return filepath.Dir(m.Path)
	}, func(m *NoteMeta, i int) { m.SiblingOrder = i })
	return out, nil
}

func assignSiblingOrder[T any](list []T, key func(T) string, set func(*T, int)) {
	counts := map[string]int{}
	for i := range list {
		k := key(list[i])
		set(&list[i], counts[k])
		counts[k]++
	}
}

// ListFolders enumerates every non-root subdirectory under each top-level folder.
func (v *Vault) ListFolders() ([]FolderEntry, error) {
	v.mu.RLock()
	defer v.mu.RUnlock()
	out := []FolderEntry{}
	for _, folder := range AllFolders {
		folderRoot, err := v.folderRoot(folder)
		if err != nil {
			return nil, err
		}
		isPrimaryRoot := folder == FolderInbox && filepath.Clean(folderRoot) == filepath.Clean(v.root)
		err = filepath.WalkDir(folderRoot, func(path string, d os.DirEntry, err error) error {
			if err != nil {
				if errors.Is(err, os.ErrNotExist) {
					return nil
				}
				return err
			}
			if !d.IsDir() {
				return nil
			}
			if path == folderRoot {
				return nil
			}
			if strings.HasPrefix(d.Name(), ".") {
				return filepath.SkipDir
			}
			if isPrimaryRoot {
				parent := filepath.Dir(path)
				if filepath.Clean(parent) == filepath.Clean(folderRoot) {
					if shouldHidePrimaryRootName(d.Name()) {
						return filepath.SkipDir
					}
				}
			}
			rel, err := filepath.Rel(folderRoot, path)
			if err != nil {
				return nil
			}
			out = append(out, FolderEntry{
				Folder:  folder,
				Subpath: filepath.ToSlash(rel),
			})
			return nil
		})
		if err != nil {
			return nil, err
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Folder != out[j].Folder {
			return out[i].Folder < out[j].Folder
		}
		return out[i].Subpath < out[j].Subpath
	})
	assignSiblingOrder(out, func(f FolderEntry) string {
		parent := filepath.Dir(f.Subpath)
		return string(f.Folder) + "/" + parent
	}, func(f *FolderEntry, i int) { f.SiblingOrder = i })
	return out, nil
}

// ListAssets walks the attachments directory.
func (v *Vault) ListAssets() ([]AssetMeta, error) {
	v.mu.RLock()
	defer v.mu.RUnlock()
	out := []AssetMeta{}
	isSkippableWalkErr := func(err error) bool {
		return errors.Is(err, os.ErrNotExist) || errors.Is(err, os.ErrPermission)
	}
	var walk func(dir string) error
	walk = func(dir string) error {
		entries, err := os.ReadDir(dir)
		if err != nil {
			if isSkippableWalkErr(err) {
				return nil
			}
			return err
		}
		for index, entry := range entries {
			name := entry.Name()
			if strings.HasPrefix(name, ".") {
				continue
			}
			full := filepath.Join(dir, name)
			if entry.IsDir() {
				if filepath.Clean(dir) == filepath.Clean(v.root) && name == internalVaultDir {
					continue
				}
				if err := walk(full); err != nil {
					if isSkippableWalkErr(err) {
						continue
					}
					return err
				}
				continue
			}
			if !entry.Type().IsRegular() || strings.EqualFold(filepath.Ext(name), ".md") {
				continue
			}
			info, err := entry.Info()
			if err != nil {
				continue
			}
			rel, err := filepath.Rel(v.root, full)
			if err != nil {
				continue
			}
			out = append(out, AssetMeta{
				Path:         filepath.ToSlash(rel),
				Name:         name,
				Kind:         kindForExt(strings.ToLower(filepath.Ext(name))),
				SiblingOrder: index,
				Size:         info.Size(),
				UpdatedAt:    info.ModTime().UnixMilli(),
			})
		}
		return nil
	}
	if err := walk(v.root); err != nil {
		return nil, err
	}
	sort.SliceStable(out, func(i, j int) bool {
		return out[i].UpdatedAt > out[j].UpdatedAt
	})
	return out, nil
}

func (v *Vault) HasAssetsDir() bool {
	v.mu.RLock()
	defer v.mu.RUnlock()
	if assets, err := v.ListAssets(); err == nil && len(assets) > 0 {
		return true
	}
	for _, dir := range append([]string{PrimaryAttachmentsDir}, legacyAttachmentsDirs...) {
		info, err := os.Stat(filepath.Join(v.root, dir))
		if err == nil && info.IsDir() {
			return true
		}
	}
	return false
}

func kindForExt(ext string) string {
	switch ext {
	case ".apng", ".avif", ".gif", ".jpeg", ".jpg", ".png", ".svg", ".webp":
		return "image"
	case ".pdf":
		return "pdf"
	case ".aac", ".flac", ".m4a", ".mp3", ".ogg", ".wav":
		return "audio"
	case ".m4v", ".mov", ".mp4", ".ogv", ".webm":
		return "video"
	}
	return "file"
}

// --- Read / Write ---

func (v *Vault) readMeta(folder NoteFolder, abs string) (NoteMeta, error) {
	info, err := os.Stat(abs)
	if err != nil {
		return NoteMeta{}, err
	}
	body, err := os.ReadFile(abs)
	if err != nil {
		return NoteMeta{}, err
	}
	bodyStr := string(body)

	rel, err := filepath.Rel(v.root, abs)
	if err != nil {
		return NoteMeta{}, err
	}
	relPosix := filepath.ToSlash(rel)
	title := strings.TrimSuffix(filepath.Base(abs), filepath.Ext(abs))

	return NoteMeta{
		Path:           relPosix,
		Title:          title,
		Folder:         folder,
		CreatedAt:      info.ModTime().UnixMilli(),
		UpdatedAt:      info.ModTime().UnixMilli(),
		Size:           info.Size(),
		Tags:           ExtractTags(bodyStr),
		Wikilinks:      ExtractWikilinks(bodyStr),
		HasAttachments: BodyHasLocalAsset(bodyStr),
		Excerpt:        BuildExcerpt(bodyStr),
	}, nil
}

func (v *Vault) ReadNote(rel string) (NoteContent, error) {
	v.mu.RLock()
	defer v.mu.RUnlock()
	abs, err := SafeJoin(v.root, rel)
	if err != nil {
		return NoteContent{}, err
	}
	info, err := os.Stat(abs)
	if err != nil {
		return NoteContent{}, err
	}
	body, err := os.ReadFile(abs)
	if err != nil {
		return NoteContent{}, err
	}
	folder, _ := v.folderOf(abs)
	bodyStr := string(body)
	rel = filepath.ToSlash(rel)
	title := strings.TrimSuffix(filepath.Base(abs), filepath.Ext(abs))
	meta := NoteMeta{
		Path:           rel,
		Title:          title,
		Folder:         folder,
		CreatedAt:      info.ModTime().UnixMilli(),
		UpdatedAt:      info.ModTime().UnixMilli(),
		Size:           info.Size(),
		Tags:           ExtractTags(bodyStr),
		Wikilinks:      ExtractWikilinks(bodyStr),
		HasAttachments: BodyHasLocalAsset(bodyStr),
		Excerpt:        BuildExcerpt(bodyStr),
	}
	return NoteContent{NoteMeta: meta, Body: bodyStr}, nil
}

func (v *Vault) WriteNote(rel, body string) (NoteMeta, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	abs, err := SafeJoin(v.root, rel)
	if err != nil {
		return NoteMeta{}, err
	}
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		return NoteMeta{}, err
	}
	if err := os.WriteFile(abs, []byte(body), 0o644); err != nil {
		return NoteMeta{}, err
	}
	folder, _ := v.folderOf(abs)
	return v.readMeta(folder, abs)
}

func (v *Vault) folderOf(abs string) (NoteFolder, bool) {
	rel, err := filepath.Rel(v.root, abs)
	if err != nil {
		return "", false
	}
	return FolderForRelativePath(rel)
}

// --- Create / Rename / Delete ---

func (v *Vault) CreateNote(folder NoteFolder, title, subpath string) (NoteMeta, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	if !IsValidFolder(folder) {
		return NoteMeta{}, fmt.Errorf("invalid folder: %s", folder)
	}
	if title == "" {
		title = defaultTitle()
	}
	title = sanitizeFileStem(title)
	dir, err := v.folderRoot(folder)
	if err != nil {
		return NoteMeta{}, err
	}
	if subpath != "" {
		sub, err := SafeJoin(dir, subpath)
		if err != nil {
			return NoteMeta{}, err
		}
		dir = sub
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return NoteMeta{}, err
	}
	abs := uniquePath(dir, title, ".md")
	if err := os.WriteFile(abs, []byte(""), 0o644); err != nil {
		return NoteMeta{}, err
	}
	return v.readMeta(folder, abs)
}

func (v *Vault) RenameNote(rel, nextTitle string) (NoteMeta, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	abs, err := SafeJoin(v.root, rel)
	if err != nil {
		return NoteMeta{}, err
	}
	nextTitle = sanitizeFileStem(nextTitle)
	if nextTitle == "" {
		return NoteMeta{}, errors.New("empty title")
	}
	dir := filepath.Dir(abs)
	newAbs := uniquePath(dir, nextTitle, ".md")
	if err := os.Rename(abs, newAbs); err != nil {
		return NoteMeta{}, err
	}
	folder, _ := v.folderOf(newAbs)
	return v.readMeta(folder, newAbs)
}

func (v *Vault) DeleteNote(rel string) error {
	v.mu.Lock()
	defer v.mu.Unlock()
	abs, err := SafeJoin(v.root, rel)
	if err != nil {
		return err
	}
	return os.Remove(abs)
}

// --- Trash / Restore / Archive / Unarchive / Duplicate / Move ---

func (v *Vault) MoveToTrash(rel string) (NoteMeta, error) {
	return v.moveToTop(rel, FolderTrash)
}
func (v *Vault) RestoreFromTrash(rel string) (NoteMeta, error) {
	return v.moveToTop(rel, FolderInbox)
}
func (v *Vault) ArchiveNote(rel string) (NoteMeta, error) {
	return v.moveToTop(rel, FolderArchive)
}
func (v *Vault) UnarchiveNote(rel string) (NoteMeta, error) {
	return v.moveToTop(rel, FolderInbox)
}

func (v *Vault) moveToTop(rel string, target NoteFolder) (NoteMeta, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	abs, err := SafeJoin(v.root, rel)
	if err != nil {
		return NoteMeta{}, err
	}
	title := strings.TrimSuffix(filepath.Base(abs), filepath.Ext(abs))
	destDir, err := v.folderRoot(target)
	if err != nil {
		return NoteMeta{}, err
	}
	if err := os.MkdirAll(destDir, 0o755); err != nil {
		return NoteMeta{}, err
	}
	newAbs := uniquePath(destDir, title, ".md")
	if err := os.Rename(abs, newAbs); err != nil {
		return NoteMeta{}, err
	}
	return v.readMeta(target, newAbs)
}

func (v *Vault) EmptyTrash() error {
	v.mu.Lock()
	defer v.mu.Unlock()
	trashDir := filepath.Join(v.root, string(FolderTrash))
	entries, err := os.ReadDir(trashDir)
	if err != nil {
		return nil
	}
	for _, e := range entries {
		_ = os.RemoveAll(filepath.Join(trashDir, e.Name()))
	}
	return nil
}

func (v *Vault) DuplicateNote(rel string) (NoteMeta, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	abs, err := SafeJoin(v.root, rel)
	if err != nil {
		return NoteMeta{}, err
	}
	folder, _ := v.folderOf(abs)
	title := strings.TrimSuffix(filepath.Base(abs), filepath.Ext(abs)) + " copy"
	newAbs := uniquePath(filepath.Dir(abs), sanitizeFileStem(title), ".md")
	if err := copyFile(abs, newAbs); err != nil {
		return NoteMeta{}, err
	}
	return v.readMeta(folder, newAbs)
}

func (v *Vault) MoveNote(rel string, target NoteFolder, targetSubpath string) (NoteMeta, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	abs, err := SafeJoin(v.root, rel)
	if err != nil {
		return NoteMeta{}, err
	}
	if !IsValidFolder(target) {
		return NoteMeta{}, fmt.Errorf("invalid folder: %s", target)
	}
	destDir, err := v.folderRoot(target)
	if err != nil {
		return NoteMeta{}, err
	}
	if targetSubpath != "" {
		sub, err := SafeJoin(destDir, targetSubpath)
		if err != nil {
			return NoteMeta{}, err
		}
		destDir = sub
	}
	if err := os.MkdirAll(destDir, 0o755); err != nil {
		return NoteMeta{}, err
	}
	title := strings.TrimSuffix(filepath.Base(abs), filepath.Ext(abs))
	newAbs := uniquePath(destDir, title, ".md")
	if err := os.Rename(abs, newAbs); err != nil {
		return NoteMeta{}, err
	}
	return v.readMeta(target, newAbs)
}

// --- Folders ---

func (v *Vault) CreateFolder(folder NoteFolder, subpath string) error {
	v.mu.Lock()
	defer v.mu.Unlock()
	if !IsValidFolder(folder) {
		return fmt.Errorf("invalid folder: %s", folder)
	}
	base, err := v.folderRoot(folder)
	if err != nil {
		return err
	}
	abs, err := SafeJoin(base, subpath)
	if err != nil {
		return err
	}
	return os.MkdirAll(abs, 0o755)
}

func (v *Vault) RenameFolder(folder NoteFolder, oldSub, newSub string) (string, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	base, err := v.folderRoot(folder)
	if err != nil {
		return "", err
	}
	oldAbs, err := SafeJoin(base, oldSub)
	if err != nil {
		return "", err
	}
	newAbs, err := SafeJoin(base, newSub)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(newAbs), 0o755); err != nil {
		return "", err
	}
	if err := os.Rename(oldAbs, newAbs); err != nil {
		return "", err
	}
	rel, _ := filepath.Rel(base, newAbs)
	return filepath.ToSlash(rel), nil
}

func (v *Vault) DeleteFolder(folder NoteFolder, subpath string) error {
	v.mu.Lock()
	defer v.mu.Unlock()
	base, err := v.folderRoot(folder)
	if err != nil {
		return err
	}
	abs, err := SafeJoin(base, subpath)
	if err != nil {
		return err
	}
	if abs == base {
		return errors.New("refusing to delete top-level folder")
	}
	return os.RemoveAll(abs)
}

func (v *Vault) DuplicateFolder(folder NoteFolder, subpath string) (string, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	base, err := v.folderRoot(folder)
	if err != nil {
		return "", err
	}
	src, err := SafeJoin(base, subpath)
	if err != nil {
		return "", err
	}
	parent := filepath.Dir(src)
	baseName := filepath.Base(src) + " copy"
	dst := uniqueDir(parent, baseName)
	if err := copyDir(src, dst); err != nil {
		return "", err
	}
	rel, _ := filepath.Rel(base, dst)
	return filepath.ToSlash(rel), nil
}

// --- Tasks ---

func (v *Vault) ScanTasks() ([]Task, error) {
	v.mu.RLock()
	defer v.mu.RUnlock()
	all := []Task{}
	for _, folder := range []NoteFolder{FolderInbox, FolderQuick, FolderArchive} {
		folderRoot, err := v.folderRoot(folder)
		if err != nil {
			return nil, err
		}
		isPrimaryRoot := folder == FolderInbox && filepath.Clean(folderRoot) == filepath.Clean(v.root)
		_ = filepath.WalkDir(folderRoot, func(path string, d os.DirEntry, err error) error {
			if err != nil {
				return nil
			}
			if d.IsDir() {
				if strings.HasPrefix(d.Name(), ".") && path != folderRoot {
					return filepath.SkipDir
				}
				if isPrimaryRoot && path != folderRoot {
					parent := filepath.Dir(path)
					if filepath.Clean(parent) == filepath.Clean(folderRoot) {
						if shouldHidePrimaryRootName(d.Name()) {
							return filepath.SkipDir
						}
					}
				}
				return nil
			}
			if isPrimaryRoot {
				parent := filepath.Dir(path)
				if filepath.Clean(parent) == filepath.Clean(folderRoot) {
					if shouldHidePrimaryRootName(d.Name()) {
						return nil
					}
				}
			}
			if !strings.EqualFold(filepath.Ext(d.Name()), ".md") {
				return nil
			}
			body, err := os.ReadFile(path)
			if err != nil {
				return nil
			}
			rel, _ := filepath.Rel(v.root, path)
			relPosix := filepath.ToSlash(rel)
			title := strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
			tasks := ParseTasks(relPosix, title, folder, string(body))
			all = append(all, tasks...)
			return nil
		})
	}
	return all, nil
}

func (v *Vault) ScanTasksForPath(rel string) ([]Task, error) {
	v.mu.RLock()
	defer v.mu.RUnlock()
	abs, err := SafeJoin(v.root, rel)
	if err != nil {
		return nil, err
	}
	body, err := os.ReadFile(abs)
	if err != nil {
		return nil, err
	}
	folder, _ := v.folderOf(abs)
	title := strings.TrimSuffix(filepath.Base(abs), filepath.Ext(abs))
	return ParseTasks(filepath.ToSlash(rel), title, folder, string(body)), nil
}

// --- Text search ---

func (v *Vault) SearchCapabilities() TextSearchCapabilities {
	return TextSearchCapabilities{Ripgrep: false, Fzf: false}
}

func (v *Vault) SearchText(query string) ([]TextSearchMatch, error) {
	v.mu.RLock()
	defer v.mu.RUnlock()
	query = strings.TrimSpace(query)
	if query == "" {
		return []TextSearchMatch{}, nil
	}
	needle := strings.ToLower(query)
	out := []TextSearchMatch{}
	for _, folder := range []NoteFolder{FolderInbox, FolderQuick, FolderArchive} {
		folderRoot, err := v.folderRoot(folder)
		if err != nil {
			return nil, err
		}
		isPrimaryRoot := folder == FolderInbox && filepath.Clean(folderRoot) == filepath.Clean(v.root)
		_ = filepath.WalkDir(folderRoot, func(path string, d os.DirEntry, err error) error {
			if err != nil {
				return nil
			}
			if d.IsDir() {
				if strings.HasPrefix(d.Name(), ".") && path != folderRoot {
					return filepath.SkipDir
				}
				if isPrimaryRoot && path != folderRoot {
					parent := filepath.Dir(path)
					if filepath.Clean(parent) == filepath.Clean(folderRoot) {
						if shouldHidePrimaryRootName(d.Name()) {
							return filepath.SkipDir
						}
					}
				}
				return nil
			}
			if isPrimaryRoot {
				parent := filepath.Dir(path)
				if filepath.Clean(parent) == filepath.Clean(folderRoot) {
					if shouldHidePrimaryRootName(d.Name()) {
						return nil
					}
				}
			}
			if !strings.EqualFold(filepath.Ext(d.Name()), ".md") {
				return nil
			}
			body, err := os.ReadFile(path)
			if err != nil {
				return nil
			}
			rel, _ := filepath.Rel(v.root, path)
			relPosix := filepath.ToSlash(rel)
			title := strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
			lines := strings.Split(string(body), "\n")
			offset := 0
			for i, line := range lines {
				if strings.Contains(strings.ToLower(line), needle) {
					collapsed := wsCollapseRe.ReplaceAllString(line, " ")
					collapsed = strings.TrimSpace(collapsed)
					if len(collapsed) > 220 {
						collapsed = collapsed[:220]
					}
					out = append(out, TextSearchMatch{
						Path:       relPosix,
						Title:      title,
						Folder:     folder,
						LineNumber: i + 1,
						Offset:     offset,
						LineText:   collapsed,
					})
				}
				offset += len(line) + 1
			}
			return nil
		})
	}
	if len(out) > 200 {
		out = out[:200]
	}
	return out, nil
}

// --- Assets upload + raw serving ---

// ImportAsset writes raw bytes into the vault root and returns the
// markdown snippet to embed relative to the source note.
func (v *Vault) ImportAsset(notePath, filename string, body io.Reader) (ImportedAsset, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	if err := os.MkdirAll(v.root, 0o755); err != nil {
		return ImportedAsset{}, err
	}
	safeName := sanitizeFileName(filename)
	if safeName == "" {
		safeName = "file"
	}
	ext := filepath.Ext(safeName)
	stem := strings.TrimSuffix(safeName, ext)
	abs := uniquePath(v.root, stem, ext)
	f, err := os.Create(abs)
	if err != nil {
		return ImportedAsset{}, err
	}
	defer f.Close()
	if _, err := io.Copy(f, body); err != nil {
		return ImportedAsset{}, err
	}
	rel := filepath.ToSlash(filepath.Base(abs))
	noteDir := filepath.Dir(filepath.FromSlash(notePath))
	if noteDir == "." {
		noteDir = ""
	}
	markdownPath := rel
	if noteDir != "" {
		if relative, err := filepath.Rel(noteDir, rel); err == nil {
			markdownPath = filepath.ToSlash(relative)
		}
	}
	kind := kindForExt(strings.ToLower(filepath.Ext(abs)))
	markdown := makeAssetMarkdown(markdownPath, kind, filepath.Base(abs))
	return ImportedAsset{
		Name:     filepath.Base(abs),
		Path:     rel,
		Markdown: markdown,
		Kind:     kind,
	}, nil
}

func (v *Vault) AssetAbsPath(rel string) (string, error) {
	v.mu.RLock()
	defer v.mu.RUnlock()
	return SafeJoin(v.root, rel)
}

func makeAssetMarkdown(relPath, kind, name string) string {
	dest := "<" + strings.ReplaceAll(relPath, ">", "%3E") + ">"
	switch kind {
	case "image":
		return "![" + name + "](" + dest + ")"
	default:
		return "[" + name + "](" + dest + ")"
	}
}

// --- Misc helpers ---

var forbiddenFilenameChars = []string{"/", "\\", ":", "*", "?", "\"", "<", ">", "|"}

func sanitizeFileStem(title string) string {
	t := title
	for _, c := range forbiddenFilenameChars {
		t = strings.ReplaceAll(t, c, "")
	}
	t = strings.TrimSpace(t)
	if t == "" {
		t = defaultTitle()
	}
	return t
}

func sanitizeFileName(name string) string {
	ext := filepath.Ext(name)
	stem := strings.TrimSuffix(name, ext)
	return sanitizeFileStem(stem) + ext
}

func defaultTitle() string {
	return "Untitled-" + time.Now().Format("2006-01-02-150405")
}

func uniquePath(dir, stem, ext string) string {
	candidate := filepath.Join(dir, stem+ext)
	if _, err := os.Stat(candidate); errors.Is(err, os.ErrNotExist) {
		return candidate
	}
	for i := 2; ; i++ {
		candidate = filepath.Join(dir, fmt.Sprintf("%s %d%s", stem, i, ext))
		if _, err := os.Stat(candidate); errors.Is(err, os.ErrNotExist) {
			return candidate
		}
	}
}

func uniqueDir(parent, base string) string {
	candidate := filepath.Join(parent, base)
	if _, err := os.Stat(candidate); errors.Is(err, os.ErrNotExist) {
		return candidate
	}
	for i := 2; ; i++ {
		candidate = filepath.Join(parent, fmt.Sprintf("%s %d", base, i))
		if _, err := os.Stat(candidate); errors.Is(err, os.ErrNotExist) {
			return candidate
		}
	}
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, in)
	return err
}

func copyDir(src, dst string) error {
	return filepath.WalkDir(src, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		return copyFile(path, target)
	})
}

const welcomeNote = `# Welcome to ZenNotes

ZenNotes keeps your notes as plain markdown files. Press ` + "`?`" + ` to see the
keybinding cheat sheet, or start typing to begin.

- Notes live in ` + "`inbox/`" + `, ` + "`quick/`" + `, ` + "`archive/`" + `, and ` + "`trash/`" + `.
- Every word you write stays on disk, under your control.
- Vim motions are on by default.
`

package watcher

import (
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
}

func Start(root string) (*Watcher, error) {
	fsw, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}
	w := &Watcher{
		root:   root,
		fs:     fsw,
		subs:   map[chan vault.ChangeEvent]struct{}{},
		stopCh: make(chan struct{}),
		dirs:   map[string]struct{}{},
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
		kind := eventKind(ev)
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
		kind := eventKind(ev)
		if kind == "" {
			return
		}
		folder, ok := vault.FolderForRelativePath(notePath)
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
	folder, ok := vault.FolderForRelativePath(relPosix)
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

	kind := eventKind(ev)
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

func eventKind(ev fsnotify.Event) string {
	switch {
	case ev.Op&fsnotify.Create != 0:
		return "add"
	case ev.Op&fsnotify.Write != 0:
		return "change"
	case ev.Op&fsnotify.Remove != 0, ev.Op&fsnotify.Rename != 0:
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
	folder, ok := vault.FolderForRelativePath(rel)
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

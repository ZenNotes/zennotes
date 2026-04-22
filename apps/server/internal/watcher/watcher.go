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
	}
	// Recursively add all existing directories under the vault.
	_ = filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			name := d.Name()
			if path != root && strings.HasPrefix(name, ".") && name != internalVaultDir {
				return filepath.SkipDir
			}
			_ = fsw.Add(path)
		}
		return nil
	})
	go w.loop()
	return w, nil
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
	_ = w.fs.Close()
}

func (w *Watcher) loop() {
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

func (w *Watcher) handle(ev fsnotify.Event) {
	base := filepath.Base(ev.Name)
	if strings.HasPrefix(base, ".") && !w.isVaultSettingsPath(ev.Name) && base != internalVaultDir {
		return
	}
	info, statErr := os.Stat(ev.Name)
	if statErr == nil && info.IsDir() {
		if ev.Op&fsnotify.Create != 0 {
			_ = w.fs.Add(ev.Name)
		}
		return
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
	if strings.HasPrefix(relPosix, ".") || strings.Contains(relPosix, "/.") {
		return
	}
	folder, ok := vault.FolderForRelativePath(relPosix)
	if !ok {
		if relPosix == vault.PrimaryAttachmentsDir ||
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

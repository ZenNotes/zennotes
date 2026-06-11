package watcher

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/ZenNotes/zennotes/apps/server/internal/vault"
	"github.com/fsnotify/fsnotify"
)

// newTestWatcher builds a Watcher with a real fsnotify handle but without
// starting the event loop, so handle() can be driven deterministically
// (no dependence on real filesystem-event timing).
func newTestWatcher(t *testing.T, root string) *Watcher {
	t.Helper()
	fsw, err := fsnotify.NewWatcher()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = fsw.Close() })
	return &Watcher{
		root:   root,
		fs:     fsw,
		subs:   map[chan vault.ChangeEvent]struct{}{},
		dirs:   map[string]struct{}{},
		stopCh: make(chan struct{}),
	}
}

func recvChange(t *testing.T, ch <-chan vault.ChangeEvent) vault.ChangeEvent {
	t.Helper()
	select {
	case ev := <-ch:
		return ev
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for a change event")
		return vault.ChangeEvent{}
	}
}

func TestWatcherBroadcastsFolderCreateAndRemove(t *testing.T) {
	root := t.TempDir()
	w := newTestWatcher(t, root)
	ch, unsub := w.Subscribe()
	defer unsub()

	dir := filepath.Join(root, "inbox", "Projects")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}

	// Folder create — previously swallowed, so a client sharing this vault
	// never learned of an empty folder until a manual refresh.
	w.handle(fsnotify.Event{Name: dir, Op: fsnotify.Create})
	ev := recvChange(t, ch)
	if ev.Scope != "folder" || ev.Kind != "add" || ev.Path != "inbox/Projects" {
		t.Fatalf("folder create event = %+v, want {add inbox/Projects folder}", ev)
	}
	if _, ok := w.dirs[dir]; !ok {
		t.Error("created dir was not tracked")
	}

	// Folder remove — can't be stat'd once gone, so the tracking set is what
	// identifies it as a directory rather than a file.
	if err := os.RemoveAll(dir); err != nil {
		t.Fatal(err)
	}
	w.handle(fsnotify.Event{Name: dir, Op: fsnotify.Remove})
	ev = recvChange(t, ch)
	if ev.Scope != "folder" || ev.Kind != "unlink" || ev.Path != "inbox/Projects" {
		t.Fatalf("folder remove event = %+v, want {unlink inbox/Projects folder}", ev)
	}
	if _, ok := w.dirs[dir]; ok {
		t.Error("removed dir is still tracked")
	}
}

func TestWatcherDoesNotSurfaceInternalDirAsFolder(t *testing.T) {
	root := t.TempDir()
	w := newTestWatcher(t, root)
	ch, unsub := w.Subscribe()
	defer unsub()

	internal := filepath.Join(root, internalVaultDir)
	if err := os.MkdirAll(internal, 0o700); err != nil {
		t.Fatal(err)
	}
	w.handle(fsnotify.Event{Name: internal, Op: fsnotify.Create})

	select {
	case ev := <-ch:
		t.Fatalf("unexpected folder event for %s: %+v", internalVaultDir, ev)
	case <-time.After(100 * time.Millisecond):
		// Expected: .zennotes is not a user-facing folder.
	}
}

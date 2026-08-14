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
		root:        root,
		fs:          fsw,
		subs:        map[chan vault.ChangeEvent]struct{}{},
		dirs:        map[string]struct{}{},
		stopCh:      make(chan struct{}),
		folderPaths: nil,
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

func TestDisabledWatcherIsNoop(t *testing.T) {
	root := t.TempDir()
	w := Disabled(root)
	if w.fs != nil {
		t.Fatal("disabled watcher should have no fsnotify handle")
	}
	ch, unsub := w.Subscribe()
	defer unsub()

	// Creating a directory must NOT produce an event — nothing is watched.
	if err := os.MkdirAll(filepath.Join(root, "inbox", "Projects"), 0o700); err != nil {
		t.Fatal(err)
	}
	select {
	case ev := <-ch:
		t.Fatalf("disabled watcher emitted an event: %+v", ev)
	case <-time.After(100 * time.Millisecond):
		// Expected: a no-op watcher never emits.
	}

	// Close must be safe even though there is no fsnotify handle to close.
	w.Close()
}

func TestStartOrDisabledFallsBackWhenDisabled(t *testing.T) {
	root := t.TempDir()

	disabled := StartOrDisabled(root, true)
	if disabled.fs != nil {
		t.Error("StartOrDisabled(_, true) should return a no-op watcher")
	}
	disabled.Close()

	enabled := StartOrDisabled(root, false)
	if enabled.fs == nil {
		t.Error("StartOrDisabled(_, false) should start a real watcher")
	}
	enabled.Close()
}

func writeVaultSettings(t *testing.T, root, body string) {
	t.Helper()
	dir := filepath.Join(root, internalVaultDir)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "vault.json"), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestReloadFolderPathsNormalizesLikeTheVault(t *testing.T) {
	root := t.TempDir()
	w := newTestWatcher(t, root)

	// `assets` is a reserved directory name, so the vault's normalizer drops the
	// override. Taking it at face value routed every assets/ event to Trash
	// while the vault kept classifying those paths as assets.
	writeVaultSettings(t, root, `{"systemFolderPaths":{"trash":"assets","quick":"scratch"}}`)
	w.reloadFolderPaths()

	paths := w.getFolderPaths()
	if _, rejected := paths["trash"]; rejected {
		t.Fatalf("reserved override survived normalization: %v", paths)
	}
	if paths["quick"] != "scratch" {
		t.Fatalf("valid override was lost: %v", paths)
	}

	folder, ok := vault.FolderForRelativePathWithSettings("assets/image.png", paths)
	if ok {
		t.Fatalf("assets/image.png classified as %q; it is not a note folder", folder)
	}

	// A deleted vault.json means no overrides, matching what the vault reports.
	if err := os.Remove(filepath.Join(root, vaultSettingsFilePath)); err != nil {
		t.Fatal(err)
	}
	w.reloadFolderPaths()
	if got := w.getFolderPaths(); len(got) != 0 {
		t.Fatalf("folder paths after vault.json removal = %v, want none", got)
	}
}

func TestWatcherClassifiesRemappedFolderEvents(t *testing.T) {
	root := t.TempDir()
	w := newTestWatcher(t, root)
	writeVaultSettings(t, root, `{"systemFolderPaths":{"trash":"deleted"}}`)
	w.reloadFolderPaths()

	ch, unsub := w.Subscribe()
	defer unsub()

	note := filepath.Join(root, "deleted", "Gone.md")
	if err := os.MkdirAll(filepath.Dir(note), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(note, []byte("gone"), 0o600); err != nil {
		t.Fatal(err)
	}
	w.handle(fsnotify.Event{Name: note, Op: fsnotify.Write})
	ev := recvChange(t, ch)
	if ev.Folder != vault.FolderTrash || ev.Path != "deleted/Gone.md" {
		t.Fatalf("event = %+v, want {change deleted/Gone.md trash}", ev)
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

func TestActiveDistinguishesRealFromDisabledWatcher(t *testing.T) {
	root := t.TempDir()

	disabled := Disabled(root)
	defer disabled.Close()
	if disabled.Active() {
		t.Fatal("Disabled watcher reports Active; capabilities would promise live updates it cannot deliver")
	}

	real, err := Start(root)
	if err != nil {
		t.Skipf("fsnotify unavailable here: %v", err)
	}
	defer real.Close()
	if !real.Active() {
		t.Fatal("real watcher reports inactive")
	}

	var nilWatcher *Watcher
	if nilWatcher.Active() {
		t.Fatal("nil watcher reports Active")
	}
}

// Every atomic note save creates a scratch file next to the note and renames it
// into place. The scratch file is not a vault change, and because its name does
// not end in .md a client that heard about it would answer by re-listing the
// whole asset tree, on every save.
func TestWatcherIgnoresAtomicWriteScratchFiles(t *testing.T) {
	root := t.TempDir()
	w := newTestWatcher(t, root)
	ch, unsub := w.Subscribe()
	defer unsub()

	scratch := filepath.Join(root, "inbox", "note.md.4123.1786714355519123456.tmp")
	for _, op := range []fsnotify.Op{fsnotify.Create, fsnotify.Write, fsnotify.Rename} {
		w.handle(fsnotify.Event{Name: scratch, Op: op})
	}

	select {
	case ev := <-ch:
		t.Fatalf("a scratch file reached clients: %+v", ev)
	case <-time.After(100 * time.Millisecond):
	}

	// The note the scratch file was renamed onto still reports normally.
	w.handle(fsnotify.Event{Name: filepath.Join(root, "inbox", "note.md"), Op: fsnotify.Create})
	if ev := recvChange(t, ch); ev.Path != "inbox/note.md" {
		t.Fatalf("note event = %+v, want inbox/note.md", ev)
	}
}

// inotify reports a rename-into-place as IN_MOVED_TO, which fsnotify folds into
// Create, so an atomic write (ours, or git/rsync/vim/Syncthing doing the same
// dance) surfaces as "add" rather than "change". Clients therefore have to treat
// an "add" for a note they hold open as new content to read, and this test is
// what pins that contract down on the server side.
func TestWatcherReportsRenameIntoPlaceAsAdd(t *testing.T) {
	root := t.TempDir()
	w := newTestWatcher(t, root)
	ch, unsub := w.Subscribe()
	defer unsub()

	note := filepath.Join(root, "inbox", "note.md")
	if err := os.MkdirAll(filepath.Dir(note), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(note, []byte("replaced by rename"), 0o600); err != nil {
		t.Fatal(err)
	}

	w.handle(fsnotify.Event{Name: note, Op: fsnotify.Create})
	ev := recvChange(t, ch)
	if ev.Kind != "add" || ev.Path != "inbox/note.md" || ev.Scope != "" {
		t.Fatalf("rename-into-place event = %+v, want {add inbox/note.md}", ev)
	}
}

// The kqueue backend (a server hosted on macOS) reports the rename half of an
// atomic save as a delete of the note itself, arriving just before the add. A
// client that believes it closes the tab of the note being saved, so a path
// that still exists must never be reported as gone.
func TestWatcherDoesNotReportAReplacedNoteAsDeleted(t *testing.T) {
	root := t.TempDir()
	w := newTestWatcher(t, root)
	ch, unsub := w.Subscribe()
	defer unsub()

	note := filepath.Join(root, "inbox", "note.md")
	if err := os.MkdirAll(filepath.Dir(note), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(note, []byte("the replacement is already here"), 0o600); err != nil {
		t.Fatal(err)
	}

	w.handle(fsnotify.Event{Name: note, Op: fsnotify.Remove})
	if ev := recvChange(t, ch); ev.Kind == "unlink" {
		t.Fatalf("a replaced note was reported as deleted: %+v", ev)
	}

	// A note that really is gone still reports as gone.
	if err := os.Remove(note); err != nil {
		t.Fatal(err)
	}
	w.handle(fsnotify.Event{Name: note, Op: fsnotify.Remove})
	if ev := recvChange(t, ch); ev.Kind != "unlink" {
		t.Fatalf("deleted note event = %+v, want unlink", ev)
	}
}

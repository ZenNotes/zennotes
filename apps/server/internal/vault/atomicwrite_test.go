package vault

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

// The #585 property, and the whole reason WriteNote is atomic: the watcher
// echoes every save to every client, and a client that reads the file inside a
// truncate-then-write window gets an empty note and shows it as the truth. No
// reader may ever observe anything but a complete body.
func TestWriteNoteNeverExposesAPartialFile(t *testing.T) {
	root := t.TempDir()
	v, err := New(root, Options{})
	if err != nil {
		t.Fatal(err)
	}
	const rel = "inbox/race.md"
	// Big enough that the write is not a single instantaneous syscall.
	bodyA := strings.Repeat("A", 96*1024)
	bodyB := strings.Repeat("B", 96*1024)
	if _, err := v.WriteNote(rel, bodyA); err != nil {
		t.Fatal(err)
	}
	abs := filepath.Join(v.Root(), "inbox", "race.md")

	stop := make(chan struct{})
	bad := make(chan string, 1)
	var readers sync.WaitGroup
	readers.Add(1)
	go func() {
		defer readers.Done()
		for {
			select {
			case <-stop:
				return
			default:
			}
			data, err := os.ReadFile(abs)
			if err != nil {
				if errors.Is(err, os.ErrNotExist) {
					select {
					case bad <- "the note vanished mid-save":
					default:
					}
					return
				}
				continue
			}
			if body := string(data); body != bodyA && body != bodyB {
				select {
				case bad <- fmt.Sprintf("a reader saw %d bytes, neither the old body nor the new one", len(body)):
				default:
				}
				return
			}
		}
	}()

	for i := range 200 {
		body := bodyA
		if i%2 == 1 {
			body = bodyB
		}
		if _, err := v.WriteNote(rel, body); err != nil {
			t.Fatal(err)
		}
	}
	close(stop)
	readers.Wait()

	select {
	case msg := <-bad:
		t.Fatal(msg)
	default:
	}
}

func TestRenameWithRetryWaitsOutTransientPermissionErrors(t *testing.T) {
	calls := 0
	var delays []time.Duration
	err := renameWithRetry(
		"note.tmp",
		"note.md",
		func(_, _ string) error {
			calls++
			if calls < 3 {
				return fs.ErrPermission
			}
			return nil
		},
		func(delay time.Duration) { delays = append(delays, delay) },
	)

	if err != nil {
		t.Fatal(err)
	}
	if calls != 3 {
		t.Fatalf("rename calls = %d, want 3", calls)
	}
	if len(delays) != 2 || delays[0] <= 0 || delays[1] <= delays[0] {
		t.Fatalf("retry delays = %v, want two increasing delays", delays)
	}
}

// A rename replaces the directory entry, so an atomic write aimed straight at a
// symlinked note would leave a regular file where the link was and detach it
// from its target for good.
func TestWriteNoteFollowsSymlinkInsteadOfReplacingIt(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink semantics differ on windows")
	}
	root := t.TempDir()
	v, err := New(root, Options{})
	if err != nil {
		t.Fatal(err)
	}
	realAbs := filepath.Join(v.Root(), "inbox", "real.md")
	if err := os.WriteFile(realAbs, []byte("original"), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(v.Root(), "inbox", "link.md")
	// Target inside the vault, which is what SafeJoin permits.
	if err := os.Symlink(realAbs, link); err != nil {
		t.Fatal(err)
	}

	if _, err := v.WriteNote("inbox/link.md", "written through the link"); err != nil {
		t.Fatal(err)
	}

	info, err := os.Lstat(link)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode()&os.ModeSymlink == 0 {
		t.Fatal("the symlink was replaced by a regular file")
	}
	got, err := os.ReadFile(realAbs)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "written through the link" {
		t.Fatalf("link target holds %q, want the written body", got)
	}
}

// os.WriteFile only applied its mode when it created the file, so replacing it
// with temp-plus-rename must not quietly re-permission notes the operator (or
// another tool) left with a mode of their own.
func TestWriteNotePreservesModeOfAnExistingNote(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("file modes are not meaningful on windows")
	}
	root := t.TempDir()
	v, err := New(root, Options{})
	if err != nil {
		t.Fatal(err)
	}
	shared := filepath.Join(v.Root(), "inbox", "shared.md")
	if err := os.WriteFile(shared, []byte("x"), 0o640); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(shared, 0o640); err != nil { // defeat the process umask
		t.Fatal(err)
	}

	if _, err := v.WriteNote("inbox/shared.md", "updated"); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(shared)
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o640 {
		t.Fatalf("mode after save = %v, want 0640", perm)
	}

	// A note this call creates still gets the vault's configured mode.
	if _, err := v.WriteNote("inbox/fresh.md", "new"); err != nil {
		t.Fatal(err)
	}
	fresh, err := os.Stat(filepath.Join(v.Root(), "inbox", "fresh.md"))
	if err != nil {
		t.Fatal(err)
	}
	if perm := fresh.Mode().Perm(); perm != 0o600 {
		t.Fatalf("new note mode = %v, want the vault's 0600", perm)
	}
}

func TestWriteNoteLeavesNoScratchFiles(t *testing.T) {
	root := t.TempDir()
	v, err := New(root, Options{})
	if err != nil {
		t.Fatal(err)
	}
	for range 3 {
		if _, err := v.WriteNote("inbox/note.md", "body"); err != nil {
			t.Fatal(err)
		}
	}
	entries, err := os.ReadDir(filepath.Join(v.Root(), "inbox"))
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".tmp") {
			t.Fatalf("a scratch file survived the save: %s", entry.Name())
		}
	}
}

func TestIsAtomicWriteTempPath(t *testing.T) {
	cases := []struct {
		path string
		want bool
	}{
		{"inbox/note.md.4123.1786714355519.tmp", true},       // desktop, millis
		{"inbox/note.md.4123.1786714355519123456.tmp", true}, // server, nanos
		{"inbox/note.md", false},
		{"inbox/note.tmp", false},
		// A file the user named themselves keeps its live updates: the trailing
		// group is too short to be an epoch stamp.
		{"inbox/report.2024.01.tmp", false},
	}
	for _, c := range cases {
		if got := IsAtomicWriteTempPath(c.path); got != c.want {
			t.Errorf("IsAtomicWriteTempPath(%q) = %v, want %v", c.path, got, c.want)
		}
	}
}

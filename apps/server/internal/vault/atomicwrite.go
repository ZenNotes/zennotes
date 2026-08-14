package vault

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"syscall"
	"time"
)

// The scratch file writeFileAtomic renames from: `<target>.<pid>.<nanos>.tmp`.
// The shape is shared with the desktop app's writeFileAtomic, and both watchers
// filter on it, so the two must stay recognizable to each other. The trailing
// number is an epoch stamp (millis on the desktop, nanos here), and requiring
// its length is what keeps a file the user actually named `notes.2024.01.tmp`
// out of the filter: events we drop here are events no client ever hears about.
var atomicWriteTempPattern = regexp.MustCompile(`\.\d+\.\d{13,}\.tmp$`)

// IsAtomicWriteTempPath reports whether p is one of those scratch files. The
// watcher drops them: a temp file appearing and vanishing is not a vault
// change, and a client that heard about it would rebuild its asset list on
// every keystroke-driven note save.
func IsAtomicWriteTempPath(p string) bool {
	return atomicWriteTempPattern.MatchString(filepath.Base(p))
}

// writeFileAtomic writes data to abs by way of a temp file in the same
// directory, fsynced, then renamed over the target. The rename is atomic, so no
// reader can ever observe a truncated or half-written file. That is what keeps
// a save from erasing the note it is saving: the file watcher echoes each save
// back to every client, and with a truncate-then-write the echo of one save
// could read the file inside the next save's empty window and hand clients an
// empty note (#585).
//
// A rename replaces the DIRECTORY ENTRY, which would silently take away two
// properties the plain os.WriteFile this replaced had for free:
//
//   - A symlinked note gets written THROUGH, not over. Pointed straight at a
//     link, the rename would leave a regular file where the link was and detach
//     it from its target for good. SafeJoin has already proved the target
//     resolves inside the vault.
//   - An existing file keeps its own permissions. os.WriteFile only applies its
//     mode when it creates the file, so a note the operator chmod'ed stays as
//     they left it; fileMode applies only to files this call creates.
func writeFileAtomic(abs string, data []byte, fileMode, dirMode fs.FileMode) error {
	target, err := resolveLinkTarget(abs)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(target), dirMode); err != nil {
		return err
	}

	mode := fileMode
	replacing := false
	if info, statErr := os.Stat(target); statErr == nil {
		mode = info.Mode().Perm()
		replacing = true
	} else if !errors.Is(statErr, os.ErrNotExist) {
		return statErr
	}

	temp := fmt.Sprintf("%s.%d.%d.tmp", target, os.Getpid(), time.Now().UnixNano())
	f, err := os.OpenFile(temp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		return err
	}
	if err := writeAndSync(f, data); err != nil {
		_ = f.Close()
		_ = os.Remove(temp)
		return err
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(temp)
		return err
	}
	// O_CREATE runs the mode through the process umask, so reproducing the mode
	// of a file we are replacing takes an explicit chmod (0664 under umask 022,
	// say). A file this call creates is deliberately left umasked, which is what
	// os.WriteFile did with fileMode. On Windows chmod touches nothing but the
	// read-only bit, which is the most it can mean there.
	if replacing {
		if err := os.Chmod(temp, mode); err != nil {
			_ = os.Remove(temp)
			return err
		}
	}
	if err := renameWithRetry(temp, target, os.Rename, time.Sleep); err != nil {
		_ = os.Remove(temp)
		return err
	}
	return nil
}

const atomicRenameAttempts = 20
const windowsSharingViolation syscall.Errno = 32

func transientRenameError(err error) bool {
	if errors.Is(err, fs.ErrPermission) {
		return true
	}
	var errno syscall.Errno
	return runtime.GOOS == "windows" && errors.As(err, &errno) && errno == windowsSharingViolation
}

// Windows refuses a replace while any reader has the destination open without
// delete sharing. Watchers, indexers, and antivirus scanners all create that
// short-lived condition, so wait for the handle instead of failing the save.
func renameWithRetry(
	from, to string,
	rename func(string, string) error,
	sleep func(time.Duration),
) error {
	delay := time.Millisecond
	for attempt := 1; ; attempt++ {
		err := rename(from, to)
		if err == nil {
			return nil
		}
		if attempt >= atomicRenameAttempts || !transientRenameError(err) {
			return err
		}
		sleep(delay)
		delay = min(delay*2, 25*time.Millisecond)
	}
}

func writeAndSync(f *os.File, data []byte) error {
	if _, err := f.Write(data); err != nil {
		return err
	}
	// The bytes have to reach the disk before the rename publishes them, or a
	// crash can leave the entry pointing at a file with nothing in it.
	return f.Sync()
}

// resolveLinkTarget follows a symlink at abs to the file it points at, so the
// atomic write lands on the target rather than replacing the link. A dangling
// link resolves to the path it names, which is where a plain write would have
// created the file.
func resolveLinkTarget(abs string) (string, error) {
	info, err := os.Lstat(abs)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return abs, nil
		}
		return "", err
	}
	if info.Mode()&os.ModeSymlink == 0 {
		return abs, nil
	}
	resolved, err := filepath.EvalSymlinks(abs)
	if err == nil {
		return resolved, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	dest, err := os.Readlink(abs)
	if err != nil {
		return "", err
	}
	if filepath.IsAbs(dest) {
		return dest, nil
	}
	return filepath.Join(filepath.Dir(abs), dest), nil
}

package vault

import (
	"errors"
	"path/filepath"
	"strings"
)

var ErrPathEscape = errors.New("path escapes vault root")

// SafeJoin cleans a user-supplied relative POSIX path and joins it
// onto `root`, refusing anything that resolves outside `root`. Always
// returns an OS-native absolute path.
func SafeJoin(root, rel string) (string, error) {
	if root == "" {
		return "", errors.New("root is empty")
	}
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	cleaned := filepath.Clean("/" + strings.TrimPrefix(rel, "/"))
	joined := filepath.Join(rootAbs, filepath.FromSlash(cleaned))
	relBack, err := filepath.Rel(rootAbs, joined)
	if err != nil {
		return "", err
	}
	if relBack == ".." || strings.HasPrefix(relBack, ".."+string(filepath.Separator)) {
		return "", ErrPathEscape
	}
	return joined, nil
}

// ToPosix converts an OS-native path to forward-slash form.
func ToPosix(p string) string {
	return filepath.ToSlash(p)
}

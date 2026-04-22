package httpserver

import (
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
)

func existingDir(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}

func resolveExistingDir(path string) (string, error) {
	if !filepath.IsAbs(path) {
		abs, err := filepath.Abs(path)
		if err != nil {
			return "", err
		}
		path = abs
	}
	resolved, err := filepath.EvalSymlinks(filepath.Clean(path))
	if err != nil {
		return "", err
	}
	info, err := os.Stat(resolved)
	if err != nil {
		return "", err
	}
	if !info.IsDir() {
		return "", httpStatusError{code: http.StatusBadRequest, msg: "path is not a directory"}
	}
	return resolved, nil
}

func pathWithinRoot(target string, root string) bool {
	cleanTarget := filepath.Clean(target)
	cleanRoot := filepath.Clean(root)
	return cleanTarget == cleanRoot || strings.HasPrefix(cleanTarget, cleanRoot+string(filepath.Separator))
}

func (s *Server) effectiveBrowseRoots() []string {
	cfg := s.currentConfig()
	if cfg.AllowUnscopedBrowse {
		return nil
	}
	candidates := cfg.BrowseRoots
	if len(candidates) == 0 {
		if current := s.currentVault(); current != nil {
			candidates = append(candidates, current.Root())
		}
	}
	if len(candidates) == 0 && strings.TrimSpace(cfg.DefaultVaultPath) != "" {
		candidates = append(candidates, cfg.DefaultVaultPath)
	}
	if len(candidates) == 0 && strings.TrimSpace(cfg.VaultPath) != "" {
		candidates = append(candidates, cfg.VaultPath)
	}
	roots := make([]string, 0, len(candidates))
	for _, candidate := range candidates {
		if resolved, err := resolveExistingDir(candidate); err == nil {
			if !slices.Contains(roots, resolved) {
				roots = append(roots, resolved)
			}
		}
	}
	return roots
}

func (s *Server) ensureBrowsePathAllowed(path string) (string, error) {
	resolved, err := resolveExistingDir(path)
	if err != nil {
		return "", err
	}
	roots := s.effectiveBrowseRoots()
	if len(roots) == 0 {
		return resolved, nil
	}
	for _, root := range roots {
		if pathWithinRoot(resolved, root) {
			return resolved, nil
		}
	}
	return "", httpStatusError{code: http.StatusForbidden, msg: "path is outside the allowed browse roots"}
}

func (s *Server) defaultBrowsePath() string {
	roots := s.effectiveBrowseRoots()
	if len(roots) > 0 {
		return roots[0]
	}
	if home, err := os.UserHomeDir(); err == nil && strings.TrimSpace(home) != "" {
		return home
	}
	if runtime.GOOS == "windows" {
		return `C:\`
	}
	return string(filepath.Separator)
}

func (s *Server) browseShortcuts() []directoryBrowseShortcut {
	shortcuts := make([]directoryBrowseShortcut, 0, 8)
	roots := s.effectiveBrowseRoots()
	for idx, rootPath := range roots {
		shortcuts = appendBrowseShortcut(shortcuts, browseRootLabel(rootPath, idx), rootPath)
	}
	if current := s.currentVault(); current != nil {
		shortcuts = appendBrowseShortcut(shortcuts, "Current Vault", current.Root())
	}
	if len(roots) == 0 {
		root := filesystemRootForPath(s.defaultBrowsePath())
		shortcuts = appendBrowseShortcut(shortcuts, "Root", root)
		if home, err := os.UserHomeDir(); err == nil && strings.TrimSpace(home) != "" {
			shortcuts = appendBrowseShortcut(shortcuts, "Home", home)
			shortcuts = appendBrowseShortcut(shortcuts, "Desktop", filepath.Join(home, "Desktop"))
			shortcuts = appendBrowseShortcut(shortcuts, "Documents", filepath.Join(home, "Documents"))
			shortcuts = appendBrowseShortcut(shortcuts, "Downloads", filepath.Join(home, "Downloads"))
			if runtime.GOOS == "darwin" {
				shortcuts = appendBrowseShortcut(
					shortcuts,
					"iCloud Drive",
					filepath.Join(home, "Library", "Mobile Documents", "com~apple~CloudDocs"),
				)
			}
		}
	}
	return shortcuts
}

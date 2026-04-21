package web

import (
	"embed"
	"io/fs"
)

//go:embed all:dist
var dist embed.FS

// Dist returns the embedded PWA bundle rooted at `dist/`. When the
// client bundle has not been built yet, the subtree is empty and the
// caller should fall back to proxying to Vite dev in development.
func Dist() (fs.FS, error) {
	return fs.Sub(dist, "dist")
}

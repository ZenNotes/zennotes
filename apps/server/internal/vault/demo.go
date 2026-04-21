package vault

import (
	_ "embed"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

//go:embed demo-tour.json
var demoTourJSON []byte

type demoFile struct {
	Path string `json:"path"`
	Body string `json:"body"`
}

type demoTour struct {
	Notes  []demoFile `json:"notes"`
	Assets []demoFile `json:"assets"`
}

// DemoTourResult mirrors shared/ipc.ts VaultDemoTourResult.
type DemoTourResult struct {
	NotePaths  []string `json:"notePaths"`
	AssetPaths []string `json:"assetPaths"`
}

func loadDemoTour() (*demoTour, error) {
	tour := &demoTour{}
	if err := json.Unmarshal(demoTourJSON, tour); err != nil {
		return nil, err
	}
	return tour, nil
}

// GenerateDemoTour seeds the vault with the built-in tour notes and
// the demo attachment. Existing files are overwritten.
func (v *Vault) GenerateDemoTour() (DemoTourResult, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	tour, err := loadDemoTour()
	if err != nil {
		return DemoTourResult{}, err
	}
	result := DemoTourResult{NotePaths: []string{}, AssetPaths: []string{}}
	for _, note := range tour.Notes {
		abs, err := SafeJoin(v.root, note.Path)
		if err != nil {
			return DemoTourResult{}, err
		}
		if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
			return DemoTourResult{}, err
		}
		if err := os.WriteFile(abs, []byte(note.Body), 0o644); err != nil {
			return DemoTourResult{}, err
		}
		result.NotePaths = append(result.NotePaths, filepath.ToSlash(note.Path))
	}
	for _, asset := range tour.Assets {
		abs, err := SafeJoin(v.root, asset.Path)
		if err != nil {
			return DemoTourResult{}, err
		}
		if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
			return DemoTourResult{}, err
		}
		if err := os.WriteFile(abs, []byte(asset.Body), 0o644); err != nil {
			return DemoTourResult{}, err
		}
		result.AssetPaths = append(result.AssetPaths, filepath.ToSlash(asset.Path))
	}
	return result, nil
}

// RemoveDemoTour deletes the demo notes + asset if they exist. Also
// removes empty parent directories under inbox/demo.
func (v *Vault) RemoveDemoTour() (DemoTourResult, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	tour, err := loadDemoTour()
	if err != nil {
		return DemoTourResult{}, err
	}
	result := DemoTourResult{NotePaths: []string{}, AssetPaths: []string{}}
	removedDirs := map[string]bool{}
	for _, note := range tour.Notes {
		abs, err := SafeJoin(v.root, note.Path)
		if err != nil {
			continue
		}
		if err := os.Remove(abs); err == nil {
			result.NotePaths = append(result.NotePaths, filepath.ToSlash(note.Path))
			removedDirs[filepath.Dir(abs)] = true
		}
	}
	for _, asset := range tour.Assets {
		abs, err := SafeJoin(v.root, asset.Path)
		if err != nil {
			continue
		}
		if err := os.Remove(abs); err == nil {
			result.AssetPaths = append(result.AssetPaths, filepath.ToSlash(asset.Path))
		}
	}
	for dir := range removedDirs {
		// Walk up from each removed-note directory and rmdir empties,
		// stopping at the vault root.
		d := dir
		for strings.HasPrefix(d, v.root) && d != v.root {
			if err := os.Remove(d); err != nil {
				break
			}
			d = filepath.Dir(d)
		}
	}
	return result, nil
}

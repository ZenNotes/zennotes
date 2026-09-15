package httpserver

import (
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/ZenNotes/zennotes/apps/server/internal/config"
	"github.com/ZenNotes/zennotes/apps/server/internal/vault"
)

// TestAssetDownloadDisposition covers the `?download=1` flag on
// /api/assets/raw (#716): the asset is served with an attachment
// Content-Disposition naming the original file, so plain browsers can save it.
func TestAssetDownloadDisposition(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "assets"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "assets", "pic.png"), []byte("PNGDATA"), 0o600); err != nil {
		t.Fatal(err)
	}
	server, _ := newTestServer(t, config.Config{
		VaultPath:        root,
		DefaultVaultPath: root,
		Bind:             "127.0.0.1:7878",
		AuthToken:        "secret-token",
	})
	jar := loginAndJar(t, server, "secret-token")
	client := &http.Client{Jar: jar}

	resp, err := client.Get(server.URL + "/api/assets/raw?path=assets/pic.png&download=1")
	if err != nil {
		t.Fatalf("GET raw?download=1: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	disp := resp.Header.Get("Content-Disposition")
	if disp != "attachment; filename*=UTF-8''pic.png" {
		t.Fatalf("Content-Disposition = %q", disp)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "image/png" {
		t.Fatalf("Content-Type = %q, want image/png", ct)
	}

	// Without the flag, the embed-serving behavior is unchanged: inline, no
	// attachment header.
	respInline, err := client.Get(server.URL + "/api/assets/raw?path=assets/pic.png")
	if err != nil {
		t.Fatalf("GET raw: %v", err)
	}
	defer respInline.Body.Close()
	if respInline.StatusCode != http.StatusOK {
		t.Fatalf("inline status = %d, want 200", respInline.StatusCode)
	}
	if disp := respInline.Header.Get("Content-Disposition"); strings.Contains(disp, "attachment") {
		t.Fatalf("inline Content-Disposition = %q, want no attachment", disp)
	}
}

// TestStaticFallback404sAssetLikePaths pins the SPA-fallback guard (#716):
// unknown file-looking paths get a real 404 instead of index.html with HTTP
// 200, while unknown app routes still fall through to the SPA shell.
func TestStaticFallback404sAssetLikePaths(t *testing.T) {
	static := fstest.MapFS{
		"index.html": &fstest.MapFile{
			Data: []byte("<!doctype html><html><head><title>ZenNotes</title></head><body></body></html>"),
		},
	}
	root := t.TempDir()
	cfg := config.Config{
		VaultPath:           root,
		DefaultVaultPath:    root,
		Bind:                "127.0.0.1:7878",
		AllowInsecureNoAuth: true,
	}
	v, err := vault.New(cfg.VaultPath, vault.Options{})
	if err != nil {
		t.Fatalf("vault.New: %v", err)
	}
	server := httptest.NewServer(New(v, nil, fs.FS(static), cfg).Router())
	t.Cleanup(server.Close)

	for _, path := range []string{"/files/assets/image.png", "/assets/missing.png", "/notes/export.pdf"} {
		resp, err := http.Get(server.URL + path)
		if err != nil {
			t.Fatalf("GET %s: %v", path, err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusNotFound {
			t.Fatalf("GET %s status = %d, want 404", path, resp.StatusCode)
		}
		if ct := resp.Header.Get("Content-Type"); strings.Contains(ct, "text/html") {
			t.Fatalf("GET %s Content-Type = %q, want non-HTML", path, ct)
		}
	}

	// Unknown extension-less app routes still hit the SPA fallback.
	resp, err := http.Get(server.URL + "/some/app/route")
	if err != nil {
		t.Fatalf("GET app route: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("app route status = %d, want 200", resp.StatusCode)
	}
}

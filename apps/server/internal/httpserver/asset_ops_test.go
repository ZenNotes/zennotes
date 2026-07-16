package httpserver

import (
	"bytes"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/ZenNotes/zennotes/apps/server/internal/config"
)

// TestAssetRenameAndMoveEndpoints exercises the full HTTP wiring for the asset
// mutation endpoints added for remote vaults (#379): rename in place, then move
// into a folder, asserting the JSON field contract the web bridge relies on.
func TestAssetRenameAndMoveEndpoints(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "assets"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "assets", "pic.png"), []byte("PNG"), 0o600); err != nil {
		t.Fatal(err)
	}
	server, _ := newTestServer(t, config.Config{
		VaultPath:        root,
		DefaultVaultPath: root,
		Bind:             "127.0.0.1:7878",
		AuthToken:        "secret-token",
		BrowseRoots:      []string{root},
	})
	jar := loginAndJar(t, server, "secret-token")
	client := &http.Client{Jar: jar}

	postJSON := func(path string, payload map[string]string) (string, int) {
		t.Helper()
		body, _ := json.Marshal(payload)
		resp, err := client.Post(server.URL+path, "application/json", bytes.NewReader(body))
		if err != nil {
			t.Fatalf("POST %s: %v", path, err)
		}
		defer resp.Body.Close()
		var meta struct {
			Path string `json:"path"`
		}
		if resp.StatusCode == http.StatusOK {
			if err := json.NewDecoder(resp.Body).Decode(&meta); err != nil {
				t.Fatalf("decode %s response: %v", path, err)
			}
		}
		return meta.Path, resp.StatusCode
	}

	gotPath, status := postJSON("/api/assets/rename", map[string]string{"path": "assets/pic.png", "name": "shot.png"})
	if status != http.StatusOK {
		t.Fatalf("rename status = %d, want 200", status)
	}
	if gotPath != "assets/shot.png" {
		t.Fatalf("rename path = %q, want assets/shot.png", gotPath)
	}

	gotPath, status = postJSON("/api/assets/move", map[string]string{"path": "assets/shot.png", "targetDir": "media"})
	if status != http.StatusOK {
		t.Fatalf("move status = %d, want 200", status)
	}
	if gotPath != "media/shot.png" {
		t.Fatalf("move path = %q, want media/shot.png", gotPath)
	}
	if _, err := os.Stat(filepath.Join(root, "media", "shot.png")); err != nil {
		t.Errorf("moved file missing on disk: %v", err)
	}
}

// TestFolderColorsPersistOverHTTP is the reporter's exact scenario (#379): a
// recolor saved from the web client must survive the /vault/settings round-trip
// instead of being silently dropped by the server.
func TestFolderColorsPersistOverHTTP(t *testing.T) {
	root := t.TempDir()
	server, _ := newTestServer(t, config.Config{
		VaultPath:        root,
		DefaultVaultPath: root,
		Bind:             "127.0.0.1:7878",
		AuthToken:        "secret-token",
		BrowseRoots:      []string{root},
	})
	jar := loginAndJar(t, server, "secret-token")
	client := &http.Client{Jar: jar}

	payload := map[string]any{
		"primaryNotesLocation": "inbox",
		"folderColors":         map[string]string{"inbox:Projects": "violet"},
	}
	body, _ := json.Marshal(payload)
	resp, err := client.Post(server.URL+"/api/vault/settings", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("POST /api/vault/settings: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("set settings status = %d, want 200", resp.StatusCode)
	}

	getResp, err := client.Get(server.URL + "/api/vault/settings")
	if err != nil {
		t.Fatalf("GET /api/vault/settings: %v", err)
	}
	defer getResp.Body.Close()
	var got struct {
		FolderColors map[string]string `json:"folderColors"`
	}
	if err := json.NewDecoder(getResp.Body).Decode(&got); err != nil {
		t.Fatalf("decode settings: %v", err)
	}
	if got.FolderColors["inbox:Projects"] != "violet" {
		t.Fatalf("folderColors dropped over HTTP round-trip: %v", got.FolderColors)
	}
}

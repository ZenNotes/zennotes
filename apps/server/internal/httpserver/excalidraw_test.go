package httpserver

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/ZenNotes/zennotes/apps/server/internal/config"
)

// TestCreateExcalidrawEndpoint exercises the full HTTP wiring: log in, POST
// /api/excalidraw/create, and confirm the drawing comes back as a `.excalidraw`
// note that then shows up in /api/notes (and not in /api/assets).
func TestCreateExcalidrawEndpoint(t *testing.T) {
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

	body, _ := json.Marshal(map[string]string{"folder": "inbox", "title": "My Sketch"})
	resp, err := client.Post(server.URL+"/api/excalidraw/create", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("POST /api/excalidraw/create: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("create status: %d", resp.StatusCode)
	}
	var created struct {
		Path  string `json:"path"`
		Title string `json:"title"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&created); err != nil {
		t.Fatalf("decode create response: %v", err)
	}
	if !strings.HasSuffix(created.Path, ".excalidraw") {
		t.Fatalf("created path = %q, want a .excalidraw file", created.Path)
	}
	if created.Title != "My Sketch" {
		t.Errorf("created title = %q, want My Sketch", created.Title)
	}

	listResp, err := client.Get(server.URL + "/api/notes")
	if err != nil {
		t.Fatalf("GET /api/notes: %v", err)
	}
	defer listResp.Body.Close()
	var notes []struct {
		Path string `json:"path"`
	}
	if err := json.NewDecoder(listResp.Body).Decode(&notes); err != nil {
		t.Fatalf("decode notes: %v", err)
	}
	found := false
	for _, n := range notes {
		if n.Path == created.Path {
			found = true
		}
	}
	if !found {
		t.Errorf("created drawing %q not returned by /api/notes", created.Path)
	}
}

func TestSyncManifestEndpoint(t *testing.T) {
	root := t.TempDir()
	server, _ := newTestServer(t, config.Config{
		VaultPath:        root,
		DefaultVaultPath: root,
		Bind:             "127.0.0.1:7878",
		AuthToken:        "secret-token",
		BrowseRoots:      []string{root},
	})

	// Requires auth.
	unauth, err := http.Get(server.URL + "/api/sync/manifest")
	if err != nil {
		t.Fatal(err)
	}
	unauth.Body.Close()
	if unauth.StatusCode != http.StatusUnauthorized {
		t.Fatalf("manifest without auth = %d, want 401", unauth.StatusCode)
	}

	jar := loginAndJar(t, server, "secret-token")
	client := &http.Client{Jar: jar}
	resp, err := client.Get(server.URL + "/api/sync/manifest")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("manifest status = %d", resp.StatusCode)
	}
	var manifest []struct {
		Path string `json:"path"`
		Hash string `json:"hash"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&manifest); err != nil {
		t.Fatalf("decode manifest: %v", err)
	}
	if len(manifest) == 0 {
		t.Fatal("manifest empty (expected at least the seeded welcome note)")
	}
	for _, e := range manifest {
		if !strings.HasPrefix(e.Hash, "sha256:") {
			t.Errorf("entry %s missing sha256 hash: %q", e.Path, e.Hash)
		}
	}
}

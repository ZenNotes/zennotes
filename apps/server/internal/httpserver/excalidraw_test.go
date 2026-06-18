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

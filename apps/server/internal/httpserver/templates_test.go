package httpserver

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ZenNotes/zennotes/apps/server/internal/config"
)

func TestTemplateEndpointsPersistRemoteCRUD(t *testing.T) {
	root := t.TempDir()
	server, _ := newTestServer(t, config.Config{
		VaultPath: root, DefaultVaultPath: root, Bind: "127.0.0.1:7878",
		AuthToken: "secret-token", BrowseRoots: []string{root},
	})
	unauthenticatedResp, err := http.Get(server.URL + "/api/templates")
	if err != nil {
		t.Fatal(err)
	}
	unauthenticatedResp.Body.Close()
	if unauthenticatedResp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unauthenticated list: got %d, want 401", unauthenticatedResp.StatusCode)
	}

	client := &http.Client{Jar: loginAndJar(t, server, "secret-token")}
	capsResp, err := client.Get(server.URL + "/api/capabilities")
	if err != nil {
		t.Fatal(err)
	}
	var caps map[string]any
	if err := json.NewDecoder(capsResp.Body).Decode(&caps); err != nil {
		t.Fatal(err)
	}
	capsResp.Body.Close()
	if caps["supportsCustomTemplates"] != true {
		t.Fatalf("supportsCustomTemplates = %v, want true", caps["supportsCustomTemplates"])
	}

	post := func(path string, payload any) *http.Response {
		t.Helper()
		body, err := json.Marshal(payload)
		if err != nil {
			t.Fatal(err)
		}
		resp, err := client.Post(server.URL+path, "application/json", bytes.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		return resp
	}
	requireOK := func(resp *http.Response) {
		t.Helper()
		if resp.StatusCode != http.StatusOK {
			body, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			t.Fatalf("%s: got %d: %s", resp.Request.URL.Path, resp.StatusCode, body)
		}
	}

	raw := "---\nname: Standup\n---\n# {{date}}\n"
	writeResp := post("/api/templates/write", map[string]string{"slug": "Daily--Standup", "raw": raw})
	requireOK(writeResp)
	var written struct {
		SourcePath string `json:"sourcePath"`
		Raw        string `json:"raw"`
	}
	if err := json.NewDecoder(writeResp.Body).Decode(&written); err != nil {
		t.Fatal(err)
	}
	writeResp.Body.Close()
	if written.SourcePath != ".zennotes/templates/daily--standup.md" || written.Raw != raw {
		t.Fatalf("written template = %+v", written)
	}

	readResp, err := client.Get(server.URL + "/api/templates/read?path=" + url.QueryEscape(written.SourcePath))
	if err != nil {
		t.Fatal(err)
	}
	requireOK(readResp)
	var read map[string]string
	if err := json.NewDecoder(readResp.Body).Decode(&read); err != nil {
		t.Fatal(err)
	}
	readResp.Body.Close()
	if read["raw"] != raw {
		t.Fatalf("read template = %q", read["raw"])
	}

	listResp, err := client.Get(server.URL + "/api/templates")
	if err != nil {
		t.Fatal(err)
	}
	requireOK(listResp)
	var listed []map[string]string
	if err := json.NewDecoder(listResp.Body).Decode(&listed); err != nil {
		t.Fatal(err)
	}
	listResp.Body.Close()
	if len(listed) != 1 || listed[0]["sourcePath"] != written.SourcePath {
		t.Fatalf("listed templates = %#v", listed)
	}
	duplicateResp := post("/api/templates/write", map[string]string{"slug": "Daily--Standup", "raw": raw})
	requireOK(duplicateResp)
	var duplicate map[string]string
	if err := json.NewDecoder(duplicateResp.Body).Decode(&duplicate); err != nil {
		t.Fatal(err)
	}
	duplicateResp.Body.Close()
	if duplicate["sourcePath"] != ".zennotes/templates/daily--standup-2.md" {
		t.Fatalf("duplicate template = %#v", duplicate)
	}
	longSlugResp := post("/api/templates/write", map[string]string{"slug": strings.Repeat("a", 1000), "raw": raw})
	requireOK(longSlugResp)
	var longSlug map[string]string
	if err := json.NewDecoder(longSlugResp.Body).Decode(&longSlug); err != nil {
		t.Fatal(err)
	}
	longSlugResp.Body.Close()
	if longSlug["sourcePath"] != ".zennotes/templates/"+strings.Repeat("a", 64)+".md" {
		t.Fatalf("long-slug template = %#v", longSlug)
	}
	trimmedSlugResp := post("/api/templates/write", map[string]string{"slug": strings.Repeat("-", 100) + "meaningful", "raw": raw})
	requireOK(trimmedSlugResp)
	var trimmedSlug map[string]string
	if err := json.NewDecoder(trimmedSlugResp.Body).Decode(&trimmedSlug); err != nil {
		t.Fatal(err)
	}
	trimmedSlugResp.Body.Close()
	if trimmedSlug["sourcePath"] != ".zennotes/templates/meaningful.md" {
		t.Fatalf("trimmed-slug template = %#v", trimmedSlug)
	}

	renameResp := post("/api/templates/write", map[string]string{
		"slug": "Team Standup", "raw": raw, "previousSourcePath": written.SourcePath,
	})
	requireOK(renameResp)
	var renamed map[string]string
	if err := json.NewDecoder(renameResp.Body).Decode(&renamed); err != nil {
		t.Fatal(err)
	}
	renameResp.Body.Close()
	if renamed["sourcePath"] != ".zennotes/templates/team-standup.md" {
		t.Fatalf("renamed template = %#v", renamed)
	}
	if _, err := os.Stat(filepath.Join(root, ".zennotes", "templates", "daily--standup.md")); !os.IsNotExist(err) {
		t.Fatalf("old template still exists: %v", err)
	}

	badResp := post("/api/templates/delete", map[string]string{"sourcePath": ".zennotes/templates/../../outside.md"})
	if badResp.StatusCode != http.StatusBadRequest {
		t.Fatalf("traversal delete: got %d, want 400", badResp.StatusCode)
	}
	badResp.Body.Close()

	deleteResp := post("/api/templates/delete", map[string]string{"sourcePath": renamed["sourcePath"]})
	requireOK(deleteResp)
	deleteResp.Body.Close()
}

func TestTemplateWriteHonorsMaxNoteBytes(t *testing.T) {
	root := t.TempDir()
	server, _ := newTestServer(t, config.Config{
		VaultPath: root, DefaultVaultPath: root, Bind: "127.0.0.1:7878",
		AuthToken: "secret-token", BrowseRoots: []string{root}, MaxNoteBytes: 8,
	})
	client := &http.Client{Jar: loginAndJar(t, server, "secret-token")}
	body, err := json.Marshal(map[string]string{"slug": "too-large", "raw": "123456789"})
	if err != nil {
		t.Fatal(err)
	}
	resp, err := client.Post(server.URL+"/api/templates/write", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized template: got %d, want 413", resp.StatusCode)
	}
}

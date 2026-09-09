package httpserver

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ZenNotes/zennotes/apps/server/internal/config"
	"github.com/ZenNotes/zennotes/apps/server/internal/vault"
)

const templateTestToken = "template-token"

func templateTestServer(t *testing.T, maxNoteBytes int64) (*httptest.Server, string) {
	t.Helper()
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "inbox"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "inbox", "Note.md"), []byte("# Note\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	server, _ := newTestServer(t, config.Config{
		VaultPath:        root,
		DefaultVaultPath: root,
		Bind:             "127.0.0.1:7878",
		AuthToken:        templateTestToken,
		BrowseRoots:      []string{root},
		MaxNoteBytes:     maxNoteBytes,
	})
	return server, root
}

func templateRequest(t *testing.T, method, url string, body any, token string) *http.Response {
	t.Helper()
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequest(method, url, reader)
	if err != nil {
		t.Fatal(err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, url, err)
	}
	return resp
}

func decodeBody[T any](t *testing.T, resp *http.Response) T {
	t.Helper()
	defer resp.Body.Close()
	var out T
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return out
}

func TestTemplateRoutesRequireAuth(t *testing.T) {
	server, _ := templateTestServer(t, 10<<20)
	for _, route := range []struct{ method, path string }{
		{http.MethodGet, "/api/templates"},
		{http.MethodGet, "/api/templates/read?path=.zennotes/templates/adr.md"},
		{http.MethodPost, "/api/templates/write"},
		{http.MethodPost, "/api/templates/delete"},
	} {
		resp := templateRequest(t, route.method, server.URL+route.path, map[string]string{}, "")
		resp.Body.Close()
		if resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("%s %s without a token: %d, want 401", route.method, route.path, resp.StatusCode)
		}
	}
	resp := templateRequest(t, http.MethodGet, server.URL+"/api/templates", nil, templateTestToken)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("list with a token: %d", resp.StatusCode)
	}
	if files := decodeBody[[]vault.CustomTemplateFile](t, resp); len(files) != 0 {
		t.Fatalf("fresh vault lists %+v", files)
	}
}

func TestTemplateRoutesWriteListReadDelete(t *testing.T) {
	server, root := templateTestServer(t, 10<<20)
	raw := "---\nname: Weekly\n---\n# {{title}}\n"

	resp := templateRequest(t, http.MethodPost, server.URL+"/api/templates/write", map[string]string{
		"slug": "Réunion Hebdo!", "raw": raw,
	}, templateTestToken)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("write: %d", resp.StatusCode)
	}
	written := decodeBody[vault.CustomTemplateFile](t, resp)
	if written.SourcePath != ".zennotes/templates/r-union-hebdo.md" || written.Raw != raw {
		t.Fatalf("written = %+v", written)
	}
	if body, err := os.ReadFile(filepath.Join(root, ".zennotes", "templates", "r-union-hebdo.md")); err != nil || string(body) != raw {
		t.Fatalf("file on disk: %q (%v)", body, err)
	}

	files := decodeBody[[]vault.CustomTemplateFile](t, templateRequest(t, http.MethodGet, server.URL+"/api/templates", nil, templateTestToken))
	if len(files) != 1 || files[0].SourcePath != written.SourcePath || files[0].Raw != raw {
		t.Fatalf("list = %+v", files)
	}

	read := decodeBody[map[string]string](t, templateRequest(t, http.MethodGet, server.URL+"/api/templates/read?path="+written.SourcePath, nil, templateTestToken))
	if read["raw"] != raw {
		t.Fatalf("read = %+v", read)
	}

	renamed := decodeBody[vault.CustomTemplateFile](t, templateRequest(t, http.MethodPost, server.URL+"/api/templates/write", map[string]string{
		"slug": "weekly", "raw": raw + "\nmore", "previousSourcePath": written.SourcePath,
	}, templateTestToken))
	if renamed.SourcePath != ".zennotes/templates/weekly.md" {
		t.Fatalf("renamed = %+v", renamed)
	}
	if _, err := os.Stat(filepath.Join(root, ".zennotes", "templates", "r-union-hebdo.md")); !os.IsNotExist(err) {
		t.Fatalf("rename left the old file: %v", err)
	}

	del := templateRequest(t, http.MethodPost, server.URL+"/api/templates/delete", map[string]string{"sourcePath": renamed.SourcePath}, templateTestToken)
	del.Body.Close()
	if del.StatusCode != http.StatusOK {
		t.Fatalf("delete: %d", del.StatusCode)
	}
	if _, err := os.Stat(filepath.Join(root, ".zennotes", "templates", "weekly.md")); !os.IsNotExist(err) {
		t.Fatalf("delete left the file: %v", err)
	}
	gone := templateRequest(t, http.MethodGet, server.URL+"/api/templates/read?path="+renamed.SourcePath, nil, templateTestToken)
	gone.Body.Close()
	if gone.StatusCode != http.StatusNotFound {
		t.Fatalf("read after delete: %d, want 404", gone.StatusCode)
	}
}

func TestTemplateRoutesRejectUnsafePaths(t *testing.T) {
	server, root := templateTestServer(t, 10<<20)
	for _, path := range []string{
		"../../etc/passwd",
		".zennotes/templates/../../inbox/Note.md",
		".zennotes/templates/sub/dir.md",
		".zennotes/templates/not-markdown.txt",
		"inbox/Note.md",
	} {
		resp := templateRequest(t, http.MethodGet, server.URL+"/api/templates/read?path="+path, nil, templateTestToken)
		resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest {
			t.Errorf("read %q: %d, want 400", path, resp.StatusCode)
		}
		del := templateRequest(t, http.MethodPost, server.URL+"/api/templates/delete", map[string]string{"sourcePath": path}, templateTestToken)
		del.Body.Close()
		if del.StatusCode != http.StatusBadRequest {
			t.Errorf("delete %q: %d, want 400", path, del.StatusCode)
		}
	}
	if _, err := os.Stat(filepath.Join(root, "inbox", "Note.md")); err != nil {
		t.Fatalf("a template delete reached a note: %v", err)
	}
}

func TestTemplateWriteRespectsNoteSizeLimit(t *testing.T) {
	server, root := templateTestServer(t, 64)
	// Past the note limit but inside the JSON envelope allowance: the explicit
	// check answers.
	resp := templateRequest(t, http.MethodPost, server.URL+"/api/templates/write", map[string]string{
		"slug": "big", "raw": strings.Repeat("x", 200),
	}, templateTestToken)
	resp.Body.Close()
	if resp.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("200-byte template with a 64-byte limit: %d, want 413", resp.StatusCode)
	}
	// Past the reader itself.
	resp = templateRequest(t, http.MethodPost, server.URL+"/api/templates/write", map[string]string{
		"slug": "huge", "raw": strings.Repeat("x", 70<<10),
	}, templateTestToken)
	resp.Body.Close()
	if resp.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("70 KiB template with a 64-byte limit: %d, want 413", resp.StatusCode)
	}
	if entries, _ := os.ReadDir(filepath.Join(root, ".zennotes", "templates")); len(entries) != 0 {
		t.Fatalf("rejected writes left files: %v", entries)
	}
	ok := templateRequest(t, http.MethodPost, server.URL+"/api/templates/write", map[string]string{
		"slug": "small", "raw": "fits",
	}, templateTestToken)
	ok.Body.Close()
	if ok.StatusCode != http.StatusOK {
		t.Fatalf("small template: %d", ok.StatusCode)
	}
}

func TestCapabilitiesAdvertiseCustomTemplateSupport(t *testing.T) {
	root := t.TempDir()
	server, _ := newTestServer(t, config.Config{
		VaultPath:        root,
		DefaultVaultPath: root,
		Bind:             "127.0.0.1:7878",
		BrowseRoots:      []string{root},
	})
	resp, err := http.Get(server.URL + "/api/capabilities")
	if err != nil {
		t.Fatal(err)
	}
	caps := decodeBody[map[string]any](t, resp)
	if caps["supportsCustomTemplates"] != true {
		t.Fatalf("supportsCustomTemplates = %v, want true", caps["supportsCustomTemplates"])
	}
}

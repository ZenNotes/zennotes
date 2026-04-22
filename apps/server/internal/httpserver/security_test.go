package httpserver

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"os"
	"net/url"
	"path/filepath"
	"testing"

	"github.com/ZenNotes/zennotes/apps/server/internal/config"
	"github.com/ZenNotes/zennotes/apps/server/internal/vault"
	"github.com/ZenNotes/zennotes/apps/server/internal/watcher"
)

func newTestServer(t *testing.T, cfg config.Config) (*httptest.Server, *vault.Vault) {
	t.Helper()

	v, err := vault.New(cfg.VaultPath)
	if err != nil {
		t.Fatalf("vault.New: %v", err)
	}
	w, err := watcher.Start(v.Root())
	if err != nil {
		t.Fatalf("watcher.Start: %v", err)
	}
	t.Cleanup(func() { w.Close() })

	server := httptest.NewServer(New(v, w, nil, cfg).Router())
	t.Cleanup(server.Close)
	return server, v
}

func TestSessionLoginProtectsVaultRoutes(t *testing.T) {
	root := t.TempDir()
	server, v := newTestServer(t, config.Config{
		VaultPath:        root,
		DefaultVaultPath: root,
		Bind:             "127.0.0.1:7878",
		AuthToken:        "secret-token",
		BrowseRoots:      []string{root},
	})

	unauthenticatedResp, err := http.Get(server.URL + "/api/vault")
	if err != nil {
		t.Fatalf("GET /api/vault without auth: %v", err)
	}
	defer unauthenticatedResp.Body.Close()
	if unauthenticatedResp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401 without auth, got %d", unauthenticatedResp.StatusCode)
	}

	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatalf("cookiejar.New: %v", err)
	}
	client := &http.Client{Jar: jar}

	loginBody, err := json.Marshal(map[string]string{"token": "secret-token"})
	if err != nil {
		t.Fatalf("json.Marshal: %v", err)
	}
	loginResp, err := client.Post(server.URL+"/api/session/login", "application/json", bytes.NewReader(loginBody))
	if err != nil {
		t.Fatalf("POST /api/session/login: %v", err)
	}
	defer loginResp.Body.Close()
	if loginResp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 from login, got %d", loginResp.StatusCode)
	}

	loginURL, err := url.Parse(server.URL + "/api/session/login")
	if err != nil {
		t.Fatalf("url.Parse: %v", err)
	}
	if len(jar.Cookies(loginURL)) == 0 {
		t.Fatal("expected login to set a session cookie")
	}

	authedResp, err := client.Get(server.URL + "/api/vault")
	if err != nil {
		t.Fatalf("GET /api/vault with session cookie: %v", err)
	}
	defer authedResp.Body.Close()
	if authedResp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 with session cookie, got %d", authedResp.StatusCode)
	}

	var info struct {
		Root string `json:"root"`
	}
	if err := json.NewDecoder(authedResp.Body).Decode(&info); err != nil {
		t.Fatalf("decode /api/vault response: %v", err)
	}
	if info.Root != v.Root() {
		t.Fatalf("expected vault root %q, got %q", v.Root(), info.Root)
	}
}

func TestBrowseRootsEnforced(t *testing.T) {
	parent := t.TempDir()
	allowedRoot := filepath.Join(parent, "allowed")
	blockedRoot := filepath.Join(parent, "blocked")
	if err := os.MkdirAll(allowedRoot, 0o755); err != nil {
		t.Fatalf("MkdirAll allowedRoot: %v", err)
	}
	if err := os.MkdirAll(blockedRoot, 0o755); err != nil {
		t.Fatalf("MkdirAll blockedRoot: %v", err)
	}

	server, _ := newTestServer(t, config.Config{
		VaultPath:        allowedRoot,
		DefaultVaultPath: allowedRoot,
		Bind:             "127.0.0.1:7878",
		AuthToken:        "secret-token",
		BrowseRoots:      []string{allowedRoot},
	})

	request, err := http.NewRequest(http.MethodGet, server.URL+"/api/fs/browse?path="+url.QueryEscape(blockedRoot), nil)
	if err != nil {
		t.Fatalf("http.NewRequest: %v", err)
	}
	request.Header.Set("Authorization", "Bearer secret-token")

	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("GET /api/fs/browse outside allowed root: %v", err)
	}
	defer response.Body.Close()

	if response.StatusCode != http.StatusForbidden {
		t.Fatalf("expected 403 for blocked browse root, got %d", response.StatusCode)
	}
}

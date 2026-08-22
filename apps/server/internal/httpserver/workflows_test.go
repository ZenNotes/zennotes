package httpserver

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/ZenNotes/zennotes/apps/server/internal/config"
)

// The Docker image serves the web client and owns the mounted vault. Workflow
// authoring, execution and Undo therefore have to cross the HTTP boundary and
// persist inside that mounted vault rather than being treated as desktop-only.
func TestWorkflowEndpointsAuthorApplyAndUndo(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "inbox"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "inbox", "A.md"), []byte("# A\n"), 0o600); err != nil {
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

	post := func(path string, payload any) *http.Response {
		t.Helper()
		body, err := json.Marshal(payload)
		if err != nil {
			t.Fatal(err)
		}
		resp, err := client.Post(server.URL+path, "application/json", bytes.NewReader(body))
		if err != nil {
			t.Fatalf("POST %s: %v", path, err)
		}
		return resp
	}
	requireOK := func(resp *http.Response) {
		t.Helper()
		if resp.StatusCode != http.StatusOK {
			body, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			t.Fatalf("%s %s: got %d: %s", resp.Request.Method, resp.Request.URL.Path, resp.StatusCode, body)
		}
	}

	workflowRaw := "---\nname: Docker workflow\nstatus: active\n---\n\nall | append done\n"
	writeResp := post("/api/workflows/write", map[string]any{
		"slug": "Docker workflow",
		"raw":  workflowRaw,
	})
	requireOK(writeResp)
	var written struct {
		ID         string `json:"id"`
		SourcePath string `json:"sourcePath"`
		Raw        string `json:"raw"`
	}
	if err := json.NewDecoder(writeResp.Body).Decode(&written); err != nil {
		t.Fatal(err)
	}
	writeResp.Body.Close()
	if written.ID != "docker-workflow" || written.SourcePath != ".zennotes/workflows/docker-workflow.md" || written.Raw != workflowRaw {
		t.Fatalf("written workflow = %+v", written)
	}

	listResp, err := client.Get(server.URL + "/api/workflows")
	if err != nil {
		t.Fatal(err)
	}
	requireOK(listResp)
	var listed []map[string]any
	if err := json.NewDecoder(listResp.Body).Decode(&listed); err != nil {
		t.Fatal(err)
	}
	listResp.Body.Close()
	if len(listed) != 1 || listed[0]["id"] != "docker-workflow" {
		t.Fatalf("listed workflows = %#v", listed)
	}

	applyResp := post("/api/workflows/apply", map[string]any{
		"workflowId":   "docker-workflow",
		"ops":          []any{map[string]any{"kind": "append", "path": "inbox/A.md", "text": "done"}},
		"applied":      1,
		"irreversible": 0,
		"changes": []any{map[string]any{
			"path":   "inbox/A.md",
			"before": "# A\n",
			"after":  "# A\n\ndone",
		}},
	})
	requireOK(applyResp)
	var receipt struct {
		RunID      string   `json:"runId"`
		WorkflowID string   `json:"workflowId"`
		Applied    int      `json:"applied"`
		Paths      []string `json:"paths"`
	}
	if err := json.NewDecoder(applyResp.Body).Decode(&receipt); err != nil {
		t.Fatal(err)
	}
	applyResp.Body.Close()
	if receipt.RunID == "" || receipt.WorkflowID != "docker-workflow" || receipt.Applied != 1 || len(receipt.Paths) != 1 {
		t.Fatalf("receipt = %+v", receipt)
	}
	if body, err := os.ReadFile(filepath.Join(root, "inbox", "A.md")); err != nil || string(body) != "# A\n\ndone" {
		t.Fatalf("applied note = %q, %v", body, err)
	}

	runsResp, err := client.Get(server.URL + "/api/workflows/runs")
	if err != nil {
		t.Fatal(err)
	}
	requireOK(runsResp)
	var runs []struct {
		RunID    string `json:"runId"`
		Undoable bool   `json:"undoable"`
	}
	if err := json.NewDecoder(runsResp.Body).Decode(&runs); err != nil {
		t.Fatal(err)
	}
	runsResp.Body.Close()
	if len(runs) != 1 || runs[0].RunID != receipt.RunID || !runs[0].Undoable {
		t.Fatalf("runs = %+v", runs)
	}

	undoResp := post("/api/workflows/undo", map[string]string{"runId": receipt.RunID})
	requireOK(undoResp)
	undoResp.Body.Close()
	if body, err := os.ReadFile(filepath.Join(root, "inbox", "A.md")); err != nil || string(body) != "# A\n" {
		t.Fatalf("undone note = %q, %v", body, err)
	}

	deleteResp := post("/api/workflows/delete", map[string]string{"sourcePath": written.SourcePath})
	requireOK(deleteResp)
	deleteResp.Body.Close()
	if _, err := os.Stat(filepath.Join(root, ".zennotes", "workflows", "docker-workflow.md")); !os.IsNotExist(err) {
		t.Fatalf("workflow still exists after delete: %v", err)
	}
}

func TestCapabilitiesAdvertiseWorkflowSupport(t *testing.T) {
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
	defer resp.Body.Close()
	var caps map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&caps); err != nil {
		t.Fatal(err)
	}
	if caps["supportsWorkflows"] != true {
		t.Fatalf("supportsWorkflows = %v, want true", caps["supportsWorkflows"])
	}
}

func TestApplyWorkflowRespectsPerNoteSizeLimit(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "inbox"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "inbox", "A.md"), []byte("# A\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	server, _ := newTestServer(t, config.Config{
		VaultPath:        root,
		DefaultVaultPath: root,
		Bind:             "127.0.0.1:7878",
		AuthToken:        "secret-token",
		BrowseRoots:      []string{root},
		MaxNoteBytes:     8,
	})
	jar := loginAndJar(t, server, "secret-token")
	client := &http.Client{Jar: jar}
	body, err := json.Marshal(map[string]any{
		"workflowId":   "oversized",
		"ops":          []any{map[string]any{"kind": "write-note", "path": "inbox/A.md", "text": "this is too large"}},
		"applied":      1,
		"irreversible": 0,
		"changes": []any{map[string]any{
			"path":   "inbox/A.md",
			"before": "# A\n",
			"after":  "this is too large",
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	resp, err := client.Post(server.URL+"/api/workflows/apply", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusRequestEntityTooLarge {
		responseBody, _ := io.ReadAll(resp.Body)
		t.Fatalf("oversized workflow note: got %d: %s", resp.StatusCode, responseBody)
	}
	if got, err := os.ReadFile(filepath.Join(root, "inbox", "A.md")); err != nil || string(got) != "# A\n" {
		t.Fatalf("oversized workflow changed note to %q (%v)", got, err)
	}
}

package vault

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func workflowTestVault(t *testing.T) (*Vault, string) {
	t.Helper()
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "inbox"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "inbox", "A.md"), []byte("# A\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	v, err := New(root, Options{})
	if err != nil {
		t.Fatal(err)
	}
	return v, root
}

func rawWorkflowOp(t *testing.T, value any) json.RawMessage {
	t.Helper()
	body, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return body
}

func TestPreparedWorkflowRequiresValidMatchingOps(t *testing.T) {
	v, root := workflowTestVault(t)
	before := "# A\n"
	after := "# Changed\n"

	_, err := v.ApplyPreparedWorkflow(PreparedWorkflowRun{
		WorkflowID: "missing-op",
		Changes: []WorkflowRunFileChange{{
			Path: "inbox/A.md", Before: &before, After: &after,
		}},
	})
	if !errors.Is(err, ErrInvalidWorkflow) {
		t.Fatalf("missing op error = %v, want ErrInvalidWorkflow", err)
	}
	if body, err := os.ReadFile(filepath.Join(root, "inbox", "A.md")); err != nil || string(body) != before {
		t.Fatalf("missing-op request changed note to %q (%v)", body, err)
	}

	_, err = v.ApplyPreparedWorkflow(PreparedWorkflowRun{
		WorkflowID: "unknown-op",
		Ops:        []json.RawMessage{rawWorkflowOp(t, map[string]string{"kind": "shell"})},
		Applied:    1,
	})
	if !errors.Is(err, ErrInvalidWorkflow) {
		t.Fatalf("unknown op error = %v, want ErrInvalidWorkflow", err)
	}

	_, err = v.ApplyPreparedWorkflow(PreparedWorkflowRun{
		WorkflowID: "malformed-op",
		Ops:        []json.RawMessage{rawWorkflowOp(t, map[string]string{"kind": "write-note"})},
		Applied:    1,
	})
	if !errors.Is(err, ErrInvalidWorkflow) {
		t.Fatalf("malformed op error = %v, want ErrInvalidWorkflow", err)
	}
}

func TestPreparedWorkflowRejectsStaleAndInternalPaths(t *testing.T) {
	v, root := workflowTestVault(t)
	stale := "# Stale\n"
	after := "# Changed\n"
	op := rawWorkflowOp(t, map[string]string{"kind": "write-note", "path": "inbox/A.md", "text": after})

	_, err := v.ApplyPreparedWorkflow(PreparedWorkflowRun{
		WorkflowID: "stale",
		Ops:        []json.RawMessage{op},
		Applied:    1,
		Changes: []WorkflowRunFileChange{{
			Path: "inbox/A.md", Before: &stale, After: &after,
		}},
	})
	if !errors.Is(err, ErrWorkflowConflict) {
		t.Fatalf("stale error = %v, want ErrWorkflowConflict", err)
	}

	missing := (*string)(nil)
	_, err = v.ApplyPreparedWorkflow(PreparedWorkflowRun{
		WorkflowID: "internal",
		Ops:        []json.RawMessage{op},
		Applied:    1,
		Changes: []WorkflowRunFileChange{{
			Path: ".zennotes/workflows/owned.md", Before: missing, After: &after,
		}},
	})
	if !errors.Is(err, ErrInvalidWorkflow) {
		t.Fatalf("internal path error = %v, want ErrInvalidWorkflow", err)
	}
	if _, err := os.Stat(filepath.Join(root, ".zennotes", "workflows", "owned.md")); !os.IsNotExist(err) {
		t.Fatalf("internal path was written: %v", err)
	}
}

func TestWorkflowRunsReadDesktopInterruptedLedger(t *testing.T) {
	v, root := workflowTestVault(t)
	runsDir := filepath.Join(root, ".zennotes", "workflows", ".runs")
	if err := os.MkdirAll(runsDir, 0o700); err != nil {
		t.Fatal(err)
	}
	ledger := map[string]any{
		"version":      1,
		"runId":        "desktop-run",
		"workflowId":   "desktop-workflow",
		"startedAt":    1,
		"finishedAt":   2,
		"applied":      0,
		"irreversible": 0,
		"paths":        []string{"inbox/A.md"},
		"ops":          []any{},
		"journal":      []any{map[string]any{"path": "inbox/A.md", "before": "# A\n"}},
		"hashes":       map[string]any{},
		"undone":       false,
		"interrupted":  map[string]string{"reason": "desktop stopped while applying"},
	}
	body, err := json.Marshal(ledger)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(runsDir, "desktop-run.json"), body, 0o600); err != nil {
		t.Fatal(err)
	}

	runs, err := v.ListWorkflowRuns()
	if err != nil {
		t.Fatal(err)
	}
	if len(runs) != 1 || !runs[0].Interrupted || !runs[0].Undoable {
		t.Fatalf("desktop interrupted runs = %+v", runs)
	}
}

func TestWorkflowRunsRejectSymlinkedHistoryDirectory(t *testing.T) {
	v, root := workflowTestVault(t)
	external := t.TempDir()
	workflowDir := filepath.Join(root, ".zennotes", "workflows")
	if err := os.MkdirAll(workflowDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(external, filepath.Join(workflowDir, ".runs")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}

	if _, err := v.ListWorkflowRuns(); !errors.Is(err, ErrPathEscape) {
		t.Fatalf("symlinked history error = %v, want ErrPathEscape", err)
	}
}

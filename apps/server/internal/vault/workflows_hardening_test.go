package vault

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A save whose slug differs from the previous filename only by case used to
// delete the workflow that was just written: on a case-insensitive filesystem
// both spellings name one physical file, and the string-compare guard let the
// cleanup remove it. Either filesystem must end with exactly one surviving
// workflow carrying the new content.
func TestWriteWorkflowCaseOnlyRenameKeepsTheFile(t *testing.T) {
	v, root := workflowTestVault(t)
	dir := filepath.Join(root, ".zennotes", "workflows")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "My-Flow.md"), []byte("old\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	if _, err := v.WriteWorkflow(WriteWorkflowInput{
		Slug:               "my-flow",
		Raw:                "new\n",
		PreviousSourcePath: ".zennotes/workflows/My-Flow.md",
	}); err != nil {
		t.Fatal(err)
	}

	body, err := os.ReadFile(filepath.Join(dir, "my-flow.md"))
	if err != nil {
		t.Fatalf("saved workflow unreadable after case-only rename: %v", err)
	}
	if string(body) != "new\n" {
		t.Fatalf("saved workflow = %q, want the new content", body)
	}
}

// A note carrying invalid UTF-8 reaches the browser through JSON, which
// coerces the bad bytes to U+FFFD; the client can only echo that view back.
// Comparing it against raw disk bytes made every apply 409 forever.
func TestApplyPreparedWorkflowAcceptsWireCoercedBeforeBytes(t *testing.T) {
	v, root := workflowTestVault(t)
	raw := []byte("head \xff\xfe tail\n")
	if err := os.WriteFile(filepath.Join(root, "inbox", "B.md"), raw, 0o600); err != nil {
		t.Fatal(err)
	}

	// What the client saw: each invalid byte as one replacement char.
	before := coerceUTF8ForWire(string(raw))
	if !strings.Contains(before, "��") {
		t.Fatalf("test fixture did not coerce: %q", before)
	}
	after := "rewritten\n"

	receipt, err := v.ApplyPreparedWorkflow(PreparedWorkflowRun{
		WorkflowID: "utf8",
		Ops: []json.RawMessage{rawWorkflowOp(t, map[string]string{
			"kind": "write-note", "path": "inbox/B.md", "text": after,
		})},
		Applied: 1,
		Changes: []WorkflowRunFileChange{{Path: "inbox/B.md", Before: &before, After: &after}},
	})
	if err != nil {
		t.Fatalf("apply over wire-coerced before bytes = %v, want success", err)
	}
	if receipt.RolledBack != nil {
		t.Fatalf("run rolled back: %v", receipt.RolledBack.Reason)
	}
	body, err := os.ReadFile(filepath.Join(root, "inbox", "B.md"))
	if err != nil || string(body) != after {
		t.Fatalf("note after run = %q (%v), want %q", body, err, after)
	}
}

// An over-cap run must say WHICH limit it crossed: the dry run just promised
// success, so a bare "invalid counts" reads as a client bug.
func TestApplyPreparedWorkflowNamesTheScaleCap(t *testing.T) {
	v, _ := workflowTestVault(t)
	ops := make([]json.RawMessage, maxWorkflowOps+1)
	for i := range ops {
		ops[i] = rawWorkflowOp(t, map[string]string{"kind": "notify", "message": "x"})
	}
	_, err := v.ApplyPreparedWorkflow(PreparedWorkflowRun{WorkflowID: "big", Ops: ops})
	if err == nil || !strings.Contains(err.Error(), "server limit") {
		t.Fatalf("over-cap error = %v, want the limit named", err)
	}
}

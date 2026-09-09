package vault

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func templateTestVault(t *testing.T) (*Vault, string) {
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

// The slug rules are a synced copy of the desktop module; these cases are the
// desktop's behaviour, spelled out so a drift on either side fails here.
func TestSafeTemplateSlugMirrorsDesktop(t *testing.T) {
	cases := map[string]string{
		"Réunion Hebdo!":     "r-union-hebdo",
		"  ADR  ":            "adr",
		"a--b":               "a--b",
		"a - b":              "a---b",
		"Weekly Review 2026": "weekly-review-2026",
		"UPPER_case.name":    "upper-case-name",
		"":                   "template",
		"---":                "template",
		"!!!":                "template",
	}
	for input, want := range cases {
		if got := safeTemplateSlug(input); got != want {
			t.Errorf("safeTemplateSlug(%q) = %q, want %q", input, got, want)
		}
	}
	stems := map[string]string{
		".zennotes/templates/adr.md": "adr",
		".zennotes/templates/adr.MD": "adr",
		".zennotes/templates/x.y.md": "x.y",
		"adr":                        "adr",
	}
	for input, want := range stems {
		if got := templateFilenameStem(input); got != want {
			t.Errorf("templateFilenameStem(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestWriteTemplateDedupesAndKeepsSlugOnEdit(t *testing.T) {
	v, root := templateTestVault(t)

	first, err := v.WriteTemplate(WriteTemplateInput{Slug: "adr", Raw: "v1"})
	if err != nil {
		t.Fatal(err)
	}
	if first.SourcePath != ".zennotes/templates/adr.md" {
		t.Fatalf("first sourcePath = %q", first.SourcePath)
	}
	second, err := v.WriteTemplate(WriteTemplateInput{Slug: "adr", Raw: "v2"})
	if err != nil {
		t.Fatal(err)
	}
	if second.SourcePath != ".zennotes/templates/adr-2.md" {
		t.Fatalf("duplicate slug landed on %q, want adr-2.md", second.SourcePath)
	}

	edited, err := v.WriteTemplate(WriteTemplateInput{Slug: "adr", Raw: "v1 edited", PreviousSourcePath: first.SourcePath})
	if err != nil {
		t.Fatal(err)
	}
	if edited.SourcePath != first.SourcePath {
		t.Fatalf("editing in place moved the file to %q", edited.SourcePath)
	}
	body, err := os.ReadFile(filepath.Join(root, ".zennotes", "templates", "adr.md"))
	if err != nil || string(body) != "v1 edited" {
		t.Fatalf("edit did not land: %q (%v)", body, err)
	}
	if _, err := os.Stat(filepath.Join(root, ".zennotes", "templates", "adr-3.md")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("editing in place must not create adr-3.md: %v", err)
	}

	files, err := v.ListTemplates()
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 2 || files[0].SourcePath != ".zennotes/templates/adr-2.md" || files[1].SourcePath != ".zennotes/templates/adr.md" {
		t.Fatalf("list = %+v", files)
	}
	entries, _ := os.ReadDir(filepath.Join(root, ".zennotes", "templates"))
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".tmp") {
			t.Fatalf("atomic write left its scratch file behind: %s", entry.Name())
		}
	}
}

func TestWriteTemplateRenameRemovesPrevious(t *testing.T) {
	v, root := templateTestVault(t)
	if _, err := v.WriteTemplate(WriteTemplateInput{Slug: "adr", Raw: "v1"}); err != nil {
		t.Fatal(err)
	}
	renamed, err := v.WriteTemplate(WriteTemplateInput{Slug: "Decision Record", Raw: "v2", PreviousSourcePath: ".zennotes/templates/adr.md"})
	if err != nil {
		t.Fatal(err)
	}
	if renamed.SourcePath != ".zennotes/templates/decision-record.md" {
		t.Fatalf("renamed sourcePath = %q", renamed.SourcePath)
	}
	if _, err := os.Stat(filepath.Join(root, ".zennotes", "templates", "adr.md")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("previous file should be gone after the rename: %v", err)
	}
	raw, err := v.ReadTemplate(renamed.SourcePath)
	if err != nil || raw != "v2" {
		t.Fatalf("read after rename = %q (%v)", raw, err)
	}
	// Deleting twice is fine: the desktop's rm --force semantics.
	if err := v.DeleteTemplate(renamed.SourcePath); err != nil {
		t.Fatal(err)
	}
	if err := v.DeleteTemplate(renamed.SourcePath); err != nil {
		t.Fatalf("second delete should be a no-op, got %v", err)
	}
	if _, err := v.ReadTemplate(renamed.SourcePath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("read after delete = %v, want ErrNotExist", err)
	}
}

func TestTemplatePathsMustStayInsideTemplatesDir(t *testing.T) {
	v, root := templateTestVault(t)
	for _, bad := range []string{
		"../../etc/passwd",
		"/etc/passwd",
		".zennotes/templates/../../inbox/A.md",
		".zennotes/templates/sub/dir.md",
		".zennotes/templates/not-markdown.txt",
		".zennotes/templates",
		"inbox/A.md",
		"",
	} {
		if _, err := v.ReadTemplate(bad); !errors.Is(err, ErrInvalidTemplate) && !errors.Is(err, ErrPathEscape) {
			t.Errorf("ReadTemplate(%q) = %v, want an invalid-path error", bad, err)
		}
		if err := v.DeleteTemplate(bad); !errors.Is(err, ErrInvalidTemplate) && !errors.Is(err, ErrPathEscape) {
			t.Errorf("DeleteTemplate(%q) = %v, want an invalid-path error", bad, err)
		}
	}
	// A template delete can never reach a note.
	if _, err := os.Stat(filepath.Join(root, "inbox", "A.md")); err != nil {
		t.Fatalf("note went missing: %v", err)
	}
	// A bad previous path fails before anything is written.
	if _, err := v.WriteTemplate(WriteTemplateInput{Slug: "adr", Raw: "v1", PreviousSourcePath: "inbox/A.md"}); !errors.Is(err, ErrInvalidTemplate) {
		t.Fatalf("write with a note as previous = %v, want ErrInvalidTemplate", err)
	}
	if _, err := os.Stat(filepath.Join(root, ".zennotes", "templates", "adr.md")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("rejected write left a file behind: %v", err)
	}
}

func TestTemplatesRejectSymlinkedTemplatesDir(t *testing.T) {
	v, root := templateTestVault(t)
	external := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, ".zennotes"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(external, filepath.Join(root, ".zennotes", "templates")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	if _, err := v.WriteTemplate(WriteTemplateInput{Slug: "adr", Raw: "v1"}); !errors.Is(err, ErrPathEscape) {
		t.Fatalf("write through a symlinked templates dir = %v, want ErrPathEscape", err)
	}
	if entries, _ := os.ReadDir(external); len(entries) != 0 {
		t.Fatalf("write escaped into %s: %v", external, entries)
	}
	if err := os.WriteFile(filepath.Join(external, "leak.md"), []byte("outside"), 0o600); err != nil {
		t.Fatal(err)
	}
	files, err := v.ListTemplates()
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 0 {
		t.Fatalf("list followed the symlink: %+v", files)
	}
}

func TestListTemplatesSkipsDotfilesDirsAndNonMarkdown(t *testing.T) {
	v, root := templateTestVault(t)
	dir := filepath.Join(root, ".zennotes", "templates")
	if err := os.MkdirAll(filepath.Join(dir, "nested"), 0o700); err != nil {
		t.Fatal(err)
	}
	for name, body := range map[string]string{
		"adr.md":      "adr",
		"Weekly.MD":   "weekly",
		".draft.md":   "hidden",
		"notes.txt":   "text",
		"nested/x.md": "nested",
	} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	files, err := v.ListTemplates()
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 2 || files[0].SourcePath != ".zennotes/templates/Weekly.MD" || files[0].Raw != "weekly" || files[1].SourcePath != ".zennotes/templates/adr.md" {
		t.Fatalf("list = %+v", files)
	}
	empty, root2 := templateTestVault(t)
	_ = root2
	files, err = empty.ListTemplates()
	if err != nil || len(files) != 0 {
		t.Fatalf("vault without a templates dir: %+v, %v", files, err)
	}
}

package vault

import "testing"

func renameTestNotes() []NoteMeta {
	return []NoteMeta{
		{Path: "inbox/demo/Old Title.md", Title: "Old Title", Folder: FolderInbox},
		{Path: "inbox/Other.md", Title: "Other", Folder: FolderInbox},
	}
}

func TestRewriteWikilinksForRename(t *testing.T) {
	notes := renameTestNotes()
	rw := func(body string) (string, int) {
		return rewriteWikilinksForRename(body, notes, "inbox/demo/Old Title.md", "New Title")
	}

	cases := []struct {
		name, in, want string
		changed        int
	}{
		{"title", "See [[Old Title]] here.", "See [[New Title]] here.", 1},
		{"alias", "[[Old Title|the old one]]", "[[New Title|the old one]]", 1},
		{"heading", "[[Old Title#Intro]]", "[[New Title#Intro]]", 1},
		{"block", "[[Old Title^a1b2]]", "[[New Title^a1b2]]", 1},
		{"heading+alias", "[[Old Title#Intro|see]]", "[[New Title#Intro|see]]", 1},
		{"embed", "![[Old Title]]", "![[New Title]]", 1},
		{"path", "[[inbox/demo/Old Title]]", "[[inbox/demo/New Title]]", 1},
		{"path-rel", "[[demo/Old Title]]", "[[demo/New Title]]", 1},
		{"path-slash", "[[/demo/Old Title]]", "[[/demo/New Title]]", 1},
		{"path-md", "[[inbox/demo/Old Title.md]]", "[[inbox/demo/New Title.md]]", 1},
		{"multiple", "[[Old Title]] and [[Old Title|x]]", "[[New Title]] and [[New Title|x]]", 2},
		{"other", "[[Other]] stays", "[[Other]] stays", 0},
		{"none", "nothing here", "nothing here", 0},
		{"inline-code", "use `[[Old Title]]` literally", "use `[[Old Title]]` literally", 0},
		{"fenced-code", "```\n[[Old Title]]\n```", "```\n[[Old Title]]\n```", 0},
		{"code-then-link", "`[[Old Title]]` then [[Old Title]]", "`[[Old Title]]` then [[New Title]]", 1},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, changed := rw(c.in)
			if got != c.want || changed != c.changed {
				t.Fatalf("rewrite(%q) = (%q, %d), want (%q, %d)", c.in, got, changed, c.want, c.changed)
			}
		})
	}
}

func TestRewriteWikilinksAmbiguousTitle(t *testing.T) {
	dup := []NoteMeta{
		{Path: "inbox/A.md", Title: "Dup", Folder: FolderInbox},
		{Path: "inbox/B.md", Title: "Dup", Folder: FolderInbox},
	}
	// [[Dup]] resolves to the first match (inbox/A.md). Renaming B must not
	// touch it; renaming A must.
	if _, changed := rewriteWikilinksForRename("[[Dup]]", dup, "inbox/B.md", "New"); changed != 0 {
		t.Fatalf("renaming B should not rewrite [[Dup]] (resolves to A), changed=%d", changed)
	}
	if got, _ := rewriteWikilinksForRename("[[Dup]]", dup, "inbox/A.md", "New"); got != "[[New]]" {
		t.Fatalf("renaming A should rewrite [[Dup]] -> [[New]], got %q", got)
	}
}

// End-to-end: a real RenameNote should rewrite inbound links across the vault.
func TestRenameNoteRewritesInboundWikilinks(t *testing.T) {
	root := t.TempDir()
	v, err := New(root, Options{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := v.WriteNote("inbox/Target.md", "# Target\n"); err != nil {
		t.Fatal(err)
	}
	src := "See [[Target]], [[Target|alias]], and ![[Target]].\n\nCode stays: `[[Target]]`\n"
	if _, err := v.WriteNote("inbox/Source.md", src); err != nil {
		t.Fatal(err)
	}

	meta, err := v.RenameNote("inbox/Target.md", "Renamed")
	if err != nil {
		t.Fatal(err)
	}
	if meta.Title != "Renamed" {
		t.Fatalf("renamed title = %q, want Renamed", meta.Title)
	}

	got, err := v.ReadNote("inbox/Source.md")
	if err != nil {
		t.Fatal(err)
	}
	want := "See [[Renamed]], [[Renamed|alias]], and ![[Renamed]].\n\nCode stays: `[[Target]]`\n"
	if got.Body != want {
		t.Fatalf("source after rename =\n%q\nwant\n%q", got.Body, want)
	}
}

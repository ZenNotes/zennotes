package vault

import (
	"os"
	"path/filepath"
	"testing"
)

// writeAsset drops a file at a vault-relative path, creating parent dirs.
func writeAsset(t *testing.T, root, rel, body string) {
	t.Helper()
	abs := filepath.Join(root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(abs), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(abs, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestRenameAssetInPlace(t *testing.T) {
	root := t.TempDir()
	v, err := New(root, Options{})
	if err != nil {
		t.Fatal(err)
	}
	writeAsset(t, root, "assets/pic.png", "PNG")

	meta, err := v.RenameAsset("assets/pic.png", "renamed.png")
	if err != nil {
		t.Fatal(err)
	}
	if meta.Path != "assets/renamed.png" {
		t.Fatalf("renamed path = %q, want assets/renamed.png", meta.Path)
	}
	if meta.Kind != "image" {
		t.Errorf("kind = %q, want image", meta.Kind)
	}
	if _, err := os.Stat(filepath.Join(root, "assets", "renamed.png")); err != nil {
		t.Errorf("renamed file missing: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "assets", "pic.png")); !os.IsNotExist(err) {
		t.Errorf("old file still present, err = %v", err)
	}
}

func TestRenameAssetRejectsCollision(t *testing.T) {
	root := t.TempDir()
	v, err := New(root, Options{})
	if err != nil {
		t.Fatal(err)
	}
	writeAsset(t, root, "assets/a.png", "A")
	writeAsset(t, root, "assets/b.png", "B")

	if _, err := v.RenameAsset("assets/a.png", "b.png"); err == nil {
		t.Fatal("expected collision error, got nil")
	}
	// Both originals must still be intact.
	if _, err := os.Stat(filepath.Join(root, "assets", "a.png")); err != nil {
		t.Errorf("source lost after failed rename: %v", err)
	}
}

func TestRenameAssetRejectsMarkdownAndDotDot(t *testing.T) {
	root := t.TempDir()
	v, err := New(root, Options{})
	if err != nil {
		t.Fatal(err)
	}
	writeAsset(t, root, "assets/pic.png", "PNG")

	if _, err := v.RenameAsset("assets/pic.png", "note.md"); err == nil {
		t.Error("expected error renaming asset to a .md name")
	}
	if _, err := v.RenameAsset("assets/pic.png", "sub/dir.png"); err == nil {
		t.Error("expected error for a name containing a path separator")
	}
	if _, err := v.RenameAsset("inbox/Note.md", "x.png"); err == nil {
		t.Error("expected error renaming a markdown note through RenameAsset")
	}
}

func TestMoveAssetIntoFolder(t *testing.T) {
	root := t.TempDir()
	v, err := New(root, Options{})
	if err != nil {
		t.Fatal(err)
	}
	writeAsset(t, root, "assets/pic.png", "PNG")

	meta, err := v.MoveAsset("assets/pic.png", "media/screens")
	if err != nil {
		t.Fatal(err)
	}
	if meta.Path != "media/screens/pic.png" {
		t.Fatalf("moved path = %q, want media/screens/pic.png", meta.Path)
	}
	if _, err := os.Stat(filepath.Join(root, "media", "screens", "pic.png")); err != nil {
		t.Errorf("moved file missing: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "assets", "pic.png")); !os.IsNotExist(err) {
		t.Errorf("source still present after move, err = %v", err)
	}
}

func TestMoveAssetEmptyTargetGoesToAssetsDir(t *testing.T) {
	root := t.TempDir()
	v, err := New(root, Options{})
	if err != nil {
		t.Fatal(err)
	}
	// A loose asset at the vault root, as a Vault Root-mode drop can leave.
	writeAsset(t, root, "pic.png", "PNG")

	meta, err := v.MoveAsset("pic.png", "")
	if err != nil {
		t.Fatal(err)
	}
	if meta.Path != "assets/pic.png" {
		t.Fatalf("moved path = %q, want assets/pic.png", meta.Path)
	}
}

func TestMoveAssetUniquifiesOnCollision(t *testing.T) {
	root := t.TempDir()
	v, err := New(root, Options{})
	if err != nil {
		t.Fatal(err)
	}
	writeAsset(t, root, "assets/pic.png", "SRC")
	writeAsset(t, root, "media/pic.png", "EXISTING")

	meta, err := v.MoveAsset("assets/pic.png", "media")
	if err != nil {
		t.Fatal(err)
	}
	if meta.Path != "media/pic 2.png" {
		t.Fatalf("moved path = %q, want media/pic 2.png", meta.Path)
	}
	// The pre-existing file must be untouched.
	body, err := os.ReadFile(filepath.Join(root, "media", "pic.png"))
	if err != nil || string(body) != "EXISTING" {
		t.Errorf("pre-existing file clobbered: body=%q err=%v", body, err)
	}
}

func TestMoveAssetSameDirIsNoop(t *testing.T) {
	root := t.TempDir()
	v, err := New(root, Options{})
	if err != nil {
		t.Fatal(err)
	}
	writeAsset(t, root, "assets/pic.png", "PNG")

	meta, err := v.MoveAsset("assets/pic.png", "assets")
	if err != nil {
		t.Fatal(err)
	}
	if meta.Path != "assets/pic.png" {
		t.Fatalf("no-op move path = %q, want assets/pic.png", meta.Path)
	}
}

func TestFolderColorsRoundTripAndValidation(t *testing.T) {
	root := t.TempDir()
	v, err := New(root, Options{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := v.SetSettings(VaultSettings{
		FolderColors: map[string]FolderColorID{
			"inbox:Projects": "violet",
			"inbox:Bad":      "chartreuse", // not a preset — must be dropped
			"":               "blue",       // empty key — must be dropped
		},
	}); err != nil {
		t.Fatal(err)
	}
	got, err := v.GetSettings()
	if err != nil {
		t.Fatal(err)
	}
	if got.FolderColors["inbox:Projects"] != "violet" {
		t.Fatalf("folderColors did not round-trip: %v", got.FolderColors)
	}
	if _, ok := got.FolderColors["inbox:Bad"]; ok {
		t.Error("invalid color id was persisted")
	}
	if _, ok := got.FolderColors[""]; ok {
		t.Error("empty-key color was persisted")
	}
}

func TestFolderColorsFollowFolderRename(t *testing.T) {
	root := t.TempDir()
	v, err := New(root, Options{})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "inbox", "Projects"), 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := v.SetSettings(VaultSettings{
		FolderColors: map[string]FolderColorID{"inbox:Projects": "teal"},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := v.RenameFolder("inbox", "Projects", "Work"); err != nil {
		t.Fatal(err)
	}
	got, err := v.GetSettings()
	if err != nil {
		t.Fatal(err)
	}
	if got.FolderColors["inbox:Work"] != "teal" {
		t.Errorf("color did not follow rename: %v", got.FolderColors)
	}
	if _, ok := got.FolderColors["inbox:Projects"]; ok {
		t.Error("stale color key survived rename")
	}
}

func TestFolderColorsPrunedOnDeleteAndCopiedOnDuplicate(t *testing.T) {
	root := t.TempDir()
	v, err := New(root, Options{})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "inbox", "Projects"), 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := v.SetSettings(VaultSettings{
		FolderColors: map[string]FolderColorID{"inbox:Projects": "pink"},
	}); err != nil {
		t.Fatal(err)
	}

	rel, err := v.DuplicateFolder("inbox", "Projects")
	if err != nil {
		t.Fatal(err)
	}
	dup, err := v.GetSettings()
	if err != nil {
		t.Fatal(err)
	}
	if dup.FolderColors["inbox:"+rel] != "pink" {
		t.Errorf("duplicate did not inherit color (key inbox:%s): %v", rel, dup.FolderColors)
	}
	if dup.FolderColors["inbox:Projects"] != "pink" {
		t.Errorf("source color lost after duplicate: %v", dup.FolderColors)
	}

	if err := v.DeleteFolder("inbox", "Projects"); err != nil {
		t.Fatal(err)
	}
	del, err := v.GetSettings()
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := del.FolderColors["inbox:Projects"]; ok {
		t.Error("deleted folder's color was not pruned")
	}
}

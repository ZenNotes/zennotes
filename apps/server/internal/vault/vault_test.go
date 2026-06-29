package vault

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestVaultDefaultModesAreTight(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("posix file modes")
	}
	root := t.TempDir()
	v, err := New(root, Options{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := v.WriteNote("hello.md", "hi"); err != nil {
		t.Fatal(err)
	}

	info, err := os.Stat(filepath.Join(v.Root(), "hello.md"))
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("note perm = %o, want 0600", perm)
	}

	// Note files live under inbox/, but the directory was created during
	// EnsureLayout. Inspect the inbox dir to verify dirMode applied.
	dirInfo, err := os.Stat(filepath.Join(v.Root(), "inbox"))
	if err != nil {
		t.Fatal(err)
	}
	if perm := dirInfo.Mode().Perm(); perm != 0o700 {
		t.Fatalf("inbox dir perm = %o, want 0700", perm)
	}
}

func TestVaultModeOverride(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("posix file modes")
	}
	root := t.TempDir()
	v, err := New(root, Options{FileMode: 0o644, DirMode: 0o755})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := v.WriteNote("hello.md", "hi"); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(filepath.Join(v.Root(), "hello.md"))
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o644 {
		t.Fatalf("override perm = %o, want 0644", perm)
	}
}

func TestImportAssetEnforcesMaxBytes(t *testing.T) {
	root := t.TempDir()
	v, err := New(root, Options{MaxAssetBytes: 16})
	if err != nil {
		t.Fatal(err)
	}
	big := bytes.Repeat([]byte("a"), 17)
	_, err = v.ImportAsset("note.md", "x.bin", bytes.NewReader(big))
	if !errors.Is(err, ErrAssetTooLarge) {
		t.Fatalf("expected ErrAssetTooLarge, got %v", err)
	}
	// Partial file should be removed.
	entries, _ := os.ReadDir(v.Root())
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".bin") {
			t.Fatalf("partial asset %q should be cleaned up", e.Name())
		}
	}
}

func TestImportAssetWithinLimit(t *testing.T) {
	root := t.TempDir()
	v, err := New(root, Options{MaxAssetBytes: 32})
	if err != nil {
		t.Fatal(err)
	}
	body := bytes.Repeat([]byte("a"), 16)
	asset, err := v.ImportAsset("note.md", "x.bin", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("expected success, got %v", err)
	}
	abs := filepath.Join(v.Root(), asset.Name)
	got, err := os.ReadFile(abs)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, body) {
		t.Fatalf("written bytes differ from input")
	}
}

func TestImportAssetReportsAtBoundary(t *testing.T) {
	root := t.TempDir()
	v, err := New(root, Options{MaxAssetBytes: 8})
	if err != nil {
		t.Fatal(err)
	}
	body := bytes.Repeat([]byte("a"), 8)
	if _, err := v.ImportAsset("note.md", "x.bin", bytes.NewReader(body)); err != nil {
		t.Fatalf("8/8 bytes should succeed, got %v", err)
	}
	// 9-byte body must be rejected even though only one byte over.
	body9 := bytes.Repeat([]byte("a"), 9)
	if _, err := v.ImportAsset("note.md", "y.bin", bytes.NewReader(body9)); !errors.Is(err, ErrAssetTooLarge) {
		t.Fatalf("9/8 should reject with ErrAssetTooLarge, got %v", err)
	}
}

func TestNoteCommentsFollowRenameDuplicateAndDelete(t *testing.T) {
	root := t.TempDir()
	v, err := New(root, Options{})
	if err != nil {
		t.Fatal(err)
	}
	meta, err := v.WriteNote("inbox/Alpha.md", "hello world")
	if err != nil {
		t.Fatal(err)
	}
	comments, err := v.WriteNoteComments(meta.Path, []NoteComment{{
		AnchorStart: 0,
		AnchorEnd:   5,
		AnchorText:  "hello",
		Body:        "Tighten this claim.",
	}})
	if err != nil {
		t.Fatal(err)
	}
	if len(comments) != 1 || comments[0].ID == "" {
		t.Fatalf("comment was not normalized: %#v", comments)
	}

	renamed, err := v.RenameNote(meta.Path, "Beta")
	if err != nil {
		t.Fatal(err)
	}
	oldComments, err := v.ReadNoteComments(meta.Path)
	if err != nil {
		t.Fatal(err)
	}
	if len(oldComments) != 0 {
		t.Fatalf("old sidecar still has comments: %#v", oldComments)
	}
	renamedComments, err := v.ReadNoteComments(renamed.Path)
	if err != nil {
		t.Fatal(err)
	}
	if len(renamedComments) != 1 || renamedComments[0].NotePath != renamed.Path {
		t.Fatalf("comments did not follow rename: %#v", renamedComments)
	}

	duplicated, err := v.DuplicateNote(renamed.Path)
	if err != nil {
		t.Fatal(err)
	}
	duplicatedComments, err := v.ReadNoteComments(duplicated.Path)
	if err != nil {
		t.Fatal(err)
	}
	if len(duplicatedComments) != 1 || duplicatedComments[0].NotePath != duplicated.Path {
		t.Fatalf("comments did not copy to duplicate: %#v", duplicatedComments)
	}
	if duplicatedComments[0].ID == renamedComments[0].ID {
		t.Fatalf("duplicated note should get independent comment ids")
	}

	if err := v.DeleteNote(renamed.Path); err != nil {
		t.Fatal(err)
	}
	deletedComments, err := v.ReadNoteComments(renamed.Path)
	if err != nil {
		t.Fatal(err)
	}
	if len(deletedComments) != 0 {
		t.Fatalf("comments should be removed with deleted note: %#v", deletedComments)
	}
}

func TestReadNoteRefusesSymlinkOutsideVault(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink semantics differ on windows")
	}
	root := t.TempDir()
	outside := t.TempDir()
	secret := filepath.Join(outside, "secret.txt")
	if err := os.WriteFile(secret, []byte("classified"), 0o600); err != nil {
		t.Fatal(err)
	}
	v, err := New(root, Options{})
	if err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(v.Root(), "evil.md")
	if err := os.Symlink(secret, link); err != nil {
		t.Fatal(err)
	}

	if _, err := v.ReadNote("evil.md"); !errors.Is(err, ErrPathEscape) {
		t.Fatalf("expected ErrPathEscape via ReadNote, got %v", err)
	}
}

func TestWriteNoteRefusesSymlinkOutsideVault(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink semantics differ on windows")
	}
	root := t.TempDir()
	outside := t.TempDir()
	target := filepath.Join(outside, "victim.txt")
	if err := os.WriteFile(target, []byte("original"), 0o600); err != nil {
		t.Fatal(err)
	}
	v, err := New(root, Options{})
	if err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(v.Root(), "evil.md")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}

	if _, err := v.WriteNote("evil.md", "tampered"); !errors.Is(err, ErrPathEscape) {
		t.Fatalf("expected ErrPathEscape via WriteNote, got %v", err)
	}
	// The target file outside the vault must not be touched.
	got, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "original" {
		t.Fatalf("file outside vault was modified: %q", got)
	}
}

func TestDuplicateFolderRefusesNestedSymlink(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink semantics differ on windows")
	}
	root := t.TempDir()
	outside := t.TempDir()
	secret := filepath.Join(outside, "secret.md")
	if err := os.WriteFile(secret, []byte("classified"), 0o600); err != nil {
		t.Fatal(err)
	}
	v, err := New(root, Options{})
	if err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(v.Root(), string(FolderInbox), "source")
	if err := os.MkdirAll(source, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "safe.md"), []byte("safe"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(secret, filepath.Join(source, "leak.md")); err != nil {
		t.Fatal(err)
	}

	if _, err := v.DuplicateFolder(FolderInbox, "source"); !errors.Is(err, ErrPathEscape) {
		t.Fatalf("expected ErrPathEscape duplicating folder with symlink, got %v", err)
	}
	if _, err := os.Stat(filepath.Join(v.Root(), string(FolderInbox), "source copy", "leak.md")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("symlink target should not be copied into duplicated folder, stat err=%v", err)
	}
}

func TestSearchTextRefreshesAfterExternalChange(t *testing.T) {
	root := t.TempDir()
	v, err := New(root, Options{})
	if err != nil {
		t.Fatal(err)
	}
	meta, err := v.WriteNote("inbox/Search.md", "alpha only\n")
	if err != nil {
		t.Fatal(err)
	}

	matches, err := v.SearchText("alpha")
	if err != nil {
		t.Fatal(err)
	}
	if !textSearchMatchesPath(matches, meta.Path) {
		t.Fatalf("initial search did not find %s: %#v", meta.Path, matches)
	}

	abs := filepath.Join(v.Root(), filepath.FromSlash(meta.Path))
	if err := os.WriteFile(abs, []byte("beta only\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	future := time.Now().Add(2 * time.Second)
	if err := os.Chtimes(abs, future, future); err != nil {
		t.Fatal(err)
	}

	matches, err = v.SearchText("alpha")
	if err != nil {
		t.Fatal(err)
	}
	if textSearchMatchesPath(matches, meta.Path) {
		t.Fatalf("stale search result still found %s: %#v", meta.Path, matches)
	}

	matches, err = v.SearchText("beta")
	if err != nil {
		t.Fatal(err)
	}
	if !textSearchMatchesPath(matches, meta.Path) {
		t.Fatalf("refreshed search did not find %s: %#v", meta.Path, matches)
	}
}

func TestListNotesUsesMatchingPersistedMetadata(t *testing.T) {
	root := t.TempDir()
	v, err := New(root, Options{})
	if err != nil {
		t.Fatal(err)
	}
	rel := filepath.ToSlash(filepath.Join(string(FolderInbox), "cached.md"))
	abs := filepath.Join(v.Root(), filepath.FromSlash(rel))
	if err := os.WriteFile(abs, []byte("# Disk Title\n\n#disk\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(abs)
	if err != nil {
		t.Fatal(err)
	}
	cachePath := filepath.Join(v.Root(), internalVaultDir, noteMetaCacheFile)
	if err := os.MkdirAll(filepath.Dir(cachePath), 0o700); err != nil {
		t.Fatal(err)
	}
	cache := persistedNoteMetaCache{
		Version: noteMetaCacheVersion,
		Entries: []persistedNoteMetaEntry{{
			Path:    rel,
			MtimeMs: mtimeMs(info),
			Size:    info.Size(),
			Meta: NoteMeta{
				Path:           rel,
				Title:          "Cached Title",
				Folder:         FolderInbox,
				SiblingOrder:   0,
				CreatedAt:      info.ModTime().UnixMilli(),
				UpdatedAt:      info.ModTime().UnixMilli(),
				Size:           info.Size(),
				Tags:           []string{"cached"},
				Wikilinks:      []string{"Cached Target"},
				HasAttachments: false,
				Excerpt:        "cached excerpt",
			},
		}},
	}
	raw, err := json.Marshal(cache)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cachePath, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	v.invalidateNoteMetaCache()

	notes, err := v.ListNotes()
	if err != nil {
		t.Fatal(err)
	}
	meta, ok := findNoteMeta(notes, rel)
	if !ok {
		t.Fatalf("note %s not found in %#v", rel, notes)
	}
	if meta.Title != "Cached Title" || len(meta.Tags) != 1 || meta.Tags[0] != "cached" || meta.Excerpt != "cached excerpt" {
		t.Fatalf("did not use matching persisted metadata: %#v", meta)
	}
}

func TestListNotesIgnoresStalePersistedMetadata(t *testing.T) {
	root := t.TempDir()
	v, err := New(root, Options{})
	if err != nil {
		t.Fatal(err)
	}
	rel := filepath.ToSlash(filepath.Join(string(FolderInbox), "stale.md"))
	abs := filepath.Join(v.Root(), filepath.FromSlash(rel))
	if err := os.WriteFile(abs, []byte("# Fresh Title\n\n#fresh\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	cachePath := filepath.Join(v.Root(), internalVaultDir, noteMetaCacheFile)
	if err := os.MkdirAll(filepath.Dir(cachePath), 0o700); err != nil {
		t.Fatal(err)
	}
	cache := persistedNoteMetaCache{
		Version: noteMetaCacheVersion,
		Entries: []persistedNoteMetaEntry{{
			Path:    rel,
			MtimeMs: 1,
			Size:    1,
			Meta: NoteMeta{
				Path:           rel,
				Title:          "Stale Title",
				Folder:         FolderInbox,
				SiblingOrder:   0,
				CreatedAt:      1,
				UpdatedAt:      1,
				Size:           1,
				Tags:           []string{"stale"},
				Wikilinks:      []string{},
				HasAttachments: false,
				Excerpt:        "stale excerpt",
			},
		}},
	}
	raw, err := json.Marshal(cache)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cachePath, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	v.invalidateNoteMetaCache()

	notes, err := v.ListNotes()
	if err != nil {
		t.Fatal(err)
	}
	meta, ok := findNoteMeta(notes, rel)
	if !ok {
		t.Fatalf("note %s not found in %#v", rel, notes)
	}
	if meta.Title != "stale" || len(meta.Tags) != 1 || meta.Tags[0] != "fresh" || !strings.Contains(meta.Excerpt, "Fresh Title") {
		t.Fatalf("stale persisted metadata was not ignored: %#v", meta)
	}
}

func findNoteMeta(notes []NoteMeta, path string) (NoteMeta, bool) {
	for _, note := range notes {
		if note.Path == path {
			return note, true
		}
	}
	return NoteMeta{}, false
}

func textSearchMatchesPath(matches []TextSearchMatch, path string) bool {
	for _, match := range matches {
		if match.Path == path {
			return true
		}
	}
	return false
}

// Compile-time assertion that ImportAsset accepts an io.Reader (silences
// unused-import lints if the asset tests are stripped down later).
var _ = io.Reader(bytes.NewReader(nil))

func TestArchiveRoundTripPreservesSubfolder(t *testing.T) {
	root := t.TempDir()
	v, err := New(root, Options{})
	if err != nil {
		t.Fatal(err)
	}
	if err := v.EnsureLayout(); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "inbox", "demo"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "inbox", "demo", "Tables.md"), []byte("# Tables\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	archived, err := v.ArchiveNote("inbox/demo/Tables.md")
	if err != nil {
		t.Fatal(err)
	}
	if archived.Path != "archive/demo/Tables.md" {
		t.Fatalf("archived path = %q, want archive/demo/Tables.md", archived.Path)
	}

	restored, err := v.UnarchiveNote(archived.Path)
	if err != nil {
		t.Fatal(err)
	}
	if restored.Path != "inbox/demo/Tables.md" {
		t.Fatalf("unarchived path = %q, want inbox/demo/Tables.md", restored.Path)
	}
}

func TestTrashRoundTripPreservesSubfolder(t *testing.T) {
	root := t.TempDir()
	v, err := New(root, Options{})
	if err != nil {
		t.Fatal(err)
	}
	if err := v.EnsureLayout(); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "inbox", "demo"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "inbox", "demo", "Tables.md"), []byte("# Tables\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	trashed, err := v.MoveToTrash("inbox/demo/Tables.md")
	if err != nil {
		t.Fatal(err)
	}
	if trashed.Path != "trash/demo/Tables.md" {
		t.Fatalf("trashed path = %q, want trash/demo/Tables.md", trashed.Path)
	}

	restored, err := v.RestoreFromTrash(trashed.Path)
	if err != nil {
		t.Fatal(err)
	}
	if restored.Path != "inbox/demo/Tables.md" {
		t.Fatalf("restored path = %q, want inbox/demo/Tables.md", restored.Path)
	}
}

func TestVaultSettingsWeeklyNotesRoundTrip(t *testing.T) {
	root := t.TempDir()
	v, err := New(root, Options{})
	if err != nil {
		t.Fatal(err)
	}

	// Mirrors what the web client POSTs: weekly notes enabled with a custom
	// directory and a template, plus a daily-notes template. Before the fix
	// the server struct lacked WeeklyNotes (and DailyNotes.TemplateID), so
	// these were silently dropped on decode/normalize and never persisted —
	// the toggle always reverted after a reload. (#117)
	if _, err := v.SetSettings(VaultSettings{
		PrimaryNotesLocation: PrimaryNotesInbox,
		DailyNotes: DailyNotesSettings{
			Enabled:      true,
			Directory:    "Daily",
			TitlePattern: "yyyy-MM-dd-EEE",
			Locale:       "pt-BR",
			TemplateID:   "daily-tmpl",
		},
		WeeklyNotes: WeeklyNotesSettings{
			Enabled:      true,
			Directory:    "My Weeks",
			TitlePattern: "yyyy-'W'ww-EEE",
			Locale:       "en-US",
			TemplateID:   "weekly-tmpl",
		},
	}); err != nil {
		t.Fatal(err)
	}

	got, err := v.GetSettings()
	if err != nil {
		t.Fatal(err)
	}
	if !got.WeeklyNotes.Enabled {
		t.Error("weekly notes enabled did not persist")
	}
	if got.WeeklyNotes.Directory != "My Weeks" {
		t.Errorf("weekly directory = %q, want %q", got.WeeklyNotes.Directory, "My Weeks")
	}
	if got.WeeklyNotes.TemplateID != "weekly-tmpl" {
		t.Errorf("weekly templateId = %q, want %q", got.WeeklyNotes.TemplateID, "weekly-tmpl")
	}
	if got.WeeklyNotes.TitlePattern != "yyyy-'W'ww-EEE" {
		t.Errorf("weekly titlePattern = %q, want %q", got.WeeklyNotes.TitlePattern, "yyyy-'W'ww-EEE")
	}
	if got.WeeklyNotes.Locale != "en-US" {
		t.Errorf("weekly locale = %q, want %q", got.WeeklyNotes.Locale, "en-US")
	}
	if got.DailyNotes.TemplateID != "daily-tmpl" {
		t.Errorf("daily templateId = %q, want %q", got.DailyNotes.TemplateID, "daily-tmpl")
	}
	if got.DailyNotes.TitlePattern != "yyyy-MM-dd-EEE" {
		t.Errorf("daily titlePattern = %q, want %q", got.DailyNotes.TitlePattern, "yyyy-MM-dd-EEE")
	}
	if got.DailyNotes.Locale != "pt-BR" {
		t.Errorf("daily locale = %q, want %q", got.DailyNotes.Locale, "pt-BR")
	}

	// The key must actually reach vault.json — the original bug was that it
	// never hit disk.
	raw, err := os.ReadFile(v.settingsPath())
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(raw, []byte("weeklyNotes")) {
		t.Errorf("vault.json missing weeklyNotes key:\n%s", raw)
	}

	// An empty weekly directory normalizes to the default, mirroring daily.
	if _, err := v.SetSettings(VaultSettings{
		PrimaryNotesLocation: PrimaryNotesInbox,
		WeeklyNotes:          WeeklyNotesSettings{Enabled: true, Directory: ""},
	}); err != nil {
		t.Fatal(err)
	}
	got, err = v.GetSettings()
	if err != nil {
		t.Fatal(err)
	}
	if got.WeeklyNotes.Directory != DefaultWeeklyNotesDirectory {
		t.Errorf("empty weekly directory = %q, want default %q", got.WeeklyNotes.Directory, DefaultWeeklyNotesDirectory)
	}
}

// The web client drives the implicit-due and task-rollover behavior off two
// daily-notes booleans. They are pointers so "absent" round-trips as unset
// (the TS client applies the real default); an explicit value must survive a
// SetSettings -> GetSettings round-trip and reach vault.json, or the web
// toggles would silently revert like #117.
func TestVaultSettingsDailyTaskFlagsRoundTrip(t *testing.T) {
	root := t.TempDir()
	v, err := New(root, Options{})
	if err != nil {
		t.Fatal(err)
	}

	yes := true
	no := false
	if _, err := v.SetSettings(VaultSettings{
		PrimaryNotesLocation: PrimaryNotesInbox,
		DailyNotes: DailyNotesSettings{
			Enabled:                 true,
			Directory:               "Daily",
			TasksDueOnNoteDate:      &no, // explicitly turn the default (true) OFF
			RolloverUnfinishedTasks: &yes,
		},
	}); err != nil {
		t.Fatal(err)
	}

	got, err := v.GetSettings()
	if err != nil {
		t.Fatal(err)
	}
	if got.DailyNotes.TasksDueOnNoteDate == nil || *got.DailyNotes.TasksDueOnNoteDate != false {
		t.Errorf("tasksDueOnNoteDate = %v, want explicit false", got.DailyNotes.TasksDueOnNoteDate)
	}
	if got.DailyNotes.RolloverUnfinishedTasks == nil || *got.DailyNotes.RolloverUnfinishedTasks != true {
		t.Errorf("rolloverUnfinishedTasks = %v, want explicit true", got.DailyNotes.RolloverUnfinishedTasks)
	}

	raw, err := os.ReadFile(v.settingsPath())
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(raw, []byte("tasksDueOnNoteDate")) {
		t.Errorf("vault.json missing tasksDueOnNoteDate key:\n%s", raw)
	}
	if !bytes.Contains(raw, []byte("rolloverUnfinishedTasks")) {
		t.Errorf("vault.json missing rolloverUnfinishedTasks key:\n%s", raw)
	}

	// Absent pointers must stay nil (omitted) so the client default wins.
	if _, err := v.SetSettings(VaultSettings{
		PrimaryNotesLocation: PrimaryNotesInbox,
		DailyNotes:           DailyNotesSettings{Enabled: true, Directory: "Daily"},
	}); err != nil {
		t.Fatal(err)
	}
	got, err = v.GetSettings()
	if err != nil {
		t.Fatal(err)
	}
	if got.DailyNotes.TasksDueOnNoteDate != nil {
		t.Errorf("absent tasksDueOnNoteDate = %v, want nil", *got.DailyNotes.TasksDueOnNoteDate)
	}
}

// A file or directory the server can't read must be skipped, not abort the whole
// vault scan — otherwise one root-owned entry hides the entire vault. (#159)
func TestListSkipsUnreadableEntries(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX permission bits don't apply on Windows")
	}
	if os.Geteuid() == 0 {
		t.Skip("permission errors are bypassed when running as root")
	}
	root := t.TempDir()
	v, err := New(root, Options{})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if _, err := v.WriteNote("inbox/Readable.md", "ok"); err != nil {
		t.Fatalf("WriteNote readable: %v", err)
	}
	if _, err := v.WriteNote("inbox/Locked/Secret.md", "secret"); err != nil {
		t.Fatalf("WriteNote locked: %v", err)
	}

	// Make the subfolder unreadable, simulating a root-owned dir the non-root
	// server process can't read. Locate it by name so this is mode-independent.
	var locked string
	_ = filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err == nil && d.IsDir() && d.Name() == "Locked" {
			locked = p
		}
		return nil
	})
	if locked == "" {
		t.Fatal("could not locate the Locked subfolder on disk")
	}
	if err := os.Chmod(locked, 0o000); err != nil {
		t.Fatalf("chmod: %v", err)
	}
	t.Cleanup(func() { _ = os.Chmod(locked, 0o755) })

	notes, err := v.ListNotes()
	if err != nil {
		t.Fatalf("ListNotes aborted instead of skipping the unreadable dir: %v", err)
	}
	var sawReadable, sawSecret bool
	for _, n := range notes {
		if strings.Contains(n.Path, "Readable.md") {
			sawReadable = true
		}
		if strings.Contains(n.Path, "Secret.md") {
			sawSecret = true
		}
	}
	if !sawReadable {
		t.Errorf("readable note missing from %d listed notes", len(notes))
	}
	if sawSecret {
		t.Error("note inside the unreadable dir should have been skipped")
	}

	if _, err := v.ListFolders(); err != nil {
		t.Fatalf("ListFolders aborted instead of skipping the unreadable dir: %v", err)
	}
}

func TestDatabaseBaseFolderListedButInternalsHidden(t *testing.T) {
	root := t.TempDir()
	v, err := New(root, Options{})
	if err != nil {
		t.Fatal(err)
	}
	// A database folder with its internals, a record-page note, and a nested dir
	// (its internals + nested dirs must NOT surface as folders).
	baseDir := filepath.Join(root, "inbox", "Books.base")
	if err := os.MkdirAll(filepath.Join(baseDir, "pages"), 0o700); err != nil {
		t.Fatal(err)
	}
	for name, body := range map[string]string{
		"data.csv":    "id,Title\nr1,Dune\n",
		"schema.json": `{"version":1}`,
		"Dune.md":     "# Dune",
	} {
		if err := os.WriteFile(filepath.Join(baseDir, name), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	// A regular note + folder that MUST still surface.
	if err := os.WriteFile(filepath.Join(root, "inbox", "Regular.md"), []byte("# Hi"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "inbox", "RealFolder"), 0o700); err != nil {
		t.Fatal(err)
	}

	notes, err := v.ListNotes()
	if err != nil {
		t.Fatal(err)
	}
	for _, n := range notes {
		if strings.Contains(n.Path, ".base") {
			t.Errorf("ListNotes leaked a database-internal note: %s", n.Path)
		}
	}
	if !hasNotePath(notes, "inbox/Regular.md") {
		t.Error("ListNotes dropped a regular note")
	}

	folders, err := v.ListFolders()
	if err != nil {
		t.Fatal(err)
	}
	sawReal := false
	sawBase := false
	for _, f := range folders {
		// The database folder itself lists (renderer renders it as a database)...
		if f.Subpath == "Books.base" {
			sawBase = true
			continue
		}
		// ...but nothing INSIDE it (e.g. Books.base/pages) is exposed as a folder.
		if strings.Contains(f.Subpath, ".base/") {
			t.Errorf("ListFolders leaked a database-internal folder: %s", f.Subpath)
		}
		if f.Subpath == "RealFolder" {
			sawReal = true
		}
	}
	if !sawBase {
		t.Error("ListFolders should list the .base database folder itself")
	}
	if !sawReal {
		t.Error("ListFolders dropped a regular folder")
	}

	assets, err := v.ListAssets()
	if err != nil {
		t.Fatal(err)
	}
	for _, a := range assets {
		if strings.Contains(a.Path, ".base") {
			t.Errorf("ListAssets leaked a database-internal file: %s", a.Path)
		}
	}
}

func hasNotePath(notes []NoteMeta, path string) bool {
	for _, n := range notes {
		if n.Path == path {
			return true
		}
	}
	return false
}

func TestFavoritesRoundTripAndDedupe(t *testing.T) {
	root := t.TempDir()
	v, err := New(root, Options{})
	if err != nil {
		t.Fatal(err)
	}
	saved, err := v.SetSettings(VaultSettings{
		// Mix of a note path and a folder key, with a duplicate and an empty entry.
		Favorites: []string{"inbox/Idea.md", "inbox:Projects", "inbox/Idea.md", ""},
	})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"inbox/Idea.md", "inbox:Projects"}
	if len(saved.Favorites) != len(want) {
		t.Fatalf("favorites = %v, want %v", saved.Favorites, want)
	}
	for i, f := range want {
		if saved.Favorites[i] != f {
			t.Errorf("favorites[%d] = %q, want %q", i, saved.Favorites[i], f)
		}
	}
	// Persisted to disk and reloaded.
	reloaded, err := v.GetSettings()
	if err != nil {
		t.Fatal(err)
	}
	if len(reloaded.Favorites) != len(want) {
		t.Errorf("reloaded favorites = %v, want %v", reloaded.Favorites, want)
	}
}

func TestFavoritesSurviveFolderRename(t *testing.T) {
	root := t.TempDir()
	v, err := New(root, Options{})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "inbox", "Projects"), 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := v.SetSettings(VaultSettings{Favorites: []string{"inbox:Projects", "inbox/Idea.md"}}); err != nil {
		t.Fatal(err)
	}
	if _, err := v.RenameFolder("inbox", "Projects", "Work"); err != nil {
		t.Fatal(err)
	}
	// The server carries favorites through verbatim (the client rewrites keys).
	settings, err := v.GetSettings()
	if err != nil {
		t.Fatal(err)
	}
	if len(settings.Favorites) != 2 {
		t.Fatalf("folder rename dropped favorites: %v", settings.Favorites)
	}
}

func TestExcalidrawListedAsNoteNotAsset(t *testing.T) {
	root := t.TempDir()
	v, err := New(root, Options{})
	if err != nil {
		t.Fatal(err)
	}
	// A drawing whose JSON body contains a hex color (#1971c2) that must NOT
	// be mistaken for a #tag, plus an image that should stay an asset.
	scene := `{"type":"excalidraw","version":2,"elements":[{"strokeColor":"#1971c2"}],"appState":{},"files":{}}`
	if err := os.WriteFile(filepath.Join(root, "inbox", "Sketch.excalidraw"), []byte(scene), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "assets"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "assets", "pic.png"), []byte("PNG"), 0o600); err != nil {
		t.Fatal(err)
	}

	notes, err := v.ListNotes()
	if err != nil {
		t.Fatal(err)
	}
	if !hasNotePath(notes, "inbox/Sketch.excalidraw") {
		t.Error("ListNotes dropped the .excalidraw drawing")
	}
	for _, n := range notes {
		if n.Path == "inbox/Sketch.excalidraw" {
			if n.Title != "Sketch" {
				t.Errorf("drawing title = %q, want Sketch", n.Title)
			}
			if len(n.Tags) != 0 {
				t.Errorf("drawing leaked tags from JSON hex colors: %v", n.Tags)
			}
		}
	}

	assets, err := v.ListAssets()
	if err != nil {
		t.Fatal(err)
	}
	sawImage := false
	for _, a := range assets {
		if strings.HasSuffix(a.Path, ".excalidraw") {
			t.Errorf("ListAssets leaked a drawing: %s", a.Path)
		}
		if a.Path == "assets/pic.png" {
			sawImage = true
		}
	}
	if !sawImage {
		t.Error("ListAssets dropped a real asset")
	}
}

func TestCreateExcalidrawSeedsEmptyScene(t *testing.T) {
	root := t.TempDir()
	v, err := New(root, Options{})
	if err != nil {
		t.Fatal(err)
	}
	meta, err := v.CreateExcalidraw(FolderInbox, "My Drawing", "")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(meta.Path, ".excalidraw") {
		t.Errorf("created path = %q, want a .excalidraw file", meta.Path)
	}
	content, err := v.ReadNote(meta.Path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(content.Body, `"type": "excalidraw"`) {
		t.Errorf("seeded scene missing excalidraw type: %s", content.Body)
	}
}

func TestRenameAndMovePreserveExcalidrawExt(t *testing.T) {
	root := t.TempDir()
	v, err := New(root, Options{})
	if err != nil {
		t.Fatal(err)
	}
	created, err := v.CreateExcalidraw(FolderInbox, "Diagram", "")
	if err != nil {
		t.Fatal(err)
	}

	renamed, err := v.RenameNote(created.Path, "Flowchart")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(renamed.Path, ".excalidraw") {
		t.Errorf("rename dropped the extension: %q", renamed.Path)
	}

	moved, err := v.MoveNote(renamed.Path, FolderArchive, "")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(moved.Path, ".excalidraw") {
		t.Errorf("move dropped the extension: %q", moved.Path)
	}
}

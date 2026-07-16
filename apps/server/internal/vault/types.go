package vault

import (
	"path/filepath"
	"strings"
)

// Types in this file mirror the TypeScript interfaces in
// `src/shared/ipc.ts` and `src/shared/tasks.ts`. The JSON tags must
// match the TS field names exactly so the client can consume the
// responses without translation.

type NoteFolder string
type PrimaryNotesLocation string
type FolderIconID string
type FolderColorID string

const (
	FolderInbox   NoteFolder = "inbox"
	FolderQuick   NoteFolder = "quick"
	FolderArchive NoteFolder = "archive"
	FolderTrash   NoteFolder = "trash"

	PrimaryNotesInbox              PrimaryNotesLocation = "inbox"
	PrimaryNotesRoot               PrimaryNotesLocation = "root"
	DefaultDailyNotesDirectory                          = "Daily Notes"
	DefaultDailyNoteTitlePattern                        = "yyyy-MM-dd"
	DefaultDailyNoteLocale                              = "system"
	DefaultWeeklyNotesDirectory                         = "Weekly Notes"
	DefaultWeeklyNoteTitlePattern                       = "yyyy-'W'ww"
	DefaultWeeklyNoteLocale                             = "system"
	DefaultMonthlyNotesDirectory                        = "Monthly Notes"
	DefaultMonthlyNoteTitlePattern                      = "yyyy-MM"
	DefaultMonthlyNoteLocale                            = "system"
)

func IsValidFolder(f NoteFolder) bool {
	switch f {
	case FolderInbox, FolderQuick, FolderArchive, FolderTrash:
		return true
	}
	return false
}

var AllFolders = []NoteFolder{FolderInbox, FolderQuick, FolderArchive, FolderTrash}

func FolderForRelativePath(rel string) (NoteFolder, bool) {
	normalized := filepath.ToSlash(rel)
	top := strings.SplitN(normalized, "/", 2)[0]
	if IsValidFolder(NoteFolder(top)) {
		return NoteFolder(top), true
	}
	if top == "" || strings.HasPrefix(top, ".") {
		return "", false
	}
	if _, reserved := reservedRootNames[top]; reserved {
		return "", false
	}
	return FolderInbox, true
}

type DateNotePatternSettings struct {
	Directory    string `json:"directory"`
	TitlePattern string `json:"titlePattern,omitempty"`
	Locale       string `json:"locale,omitempty"`
}

type DailyNotesSettings struct {
	Enabled        bool                      `json:"enabled"`
	Directory      string                    `json:"directory"`
	TitlePattern   string                    `json:"titlePattern,omitempty"`
	Locale         string                    `json:"locale,omitempty"`
	LegacyPatterns []DateNotePatternSettings `json:"legacyPatterns,omitempty"`
	TemplateID     string                    `json:"templateId,omitempty"`
	// Pointers so an absent field round-trips as "unset" (the TS client applies
	// the real default — true for TasksDueOnNoteDate, false for rollover). These
	// drive purely client-side behavior; the server only persists them.
	TasksDueOnNoteDate      *bool `json:"tasksDueOnNoteDate,omitempty"`
	RolloverUnfinishedTasks *bool `json:"rolloverUnfinishedTasks,omitempty"`
}

type WeeklyNotesSettings struct {
	Enabled        bool                      `json:"enabled"`
	Directory      string                    `json:"directory"`
	TitlePattern   string                    `json:"titlePattern,omitempty"`
	Locale         string                    `json:"locale,omitempty"`
	LegacyPatterns []DateNotePatternSettings `json:"legacyPatterns,omitempty"`
	TemplateID     string                    `json:"templateId,omitempty"`
}

type MonthlyNotesSettings struct {
	Enabled        bool                      `json:"enabled"`
	Directory      string                    `json:"directory"`
	TitlePattern   string                    `json:"titlePattern,omitempty"`
	Locale         string                    `json:"locale,omitempty"`
	LegacyPatterns []DateNotePatternSettings `json:"legacyPatterns,omitempty"`
	TemplateID     string                    `json:"templateId,omitempty"`
}

type VaultSettings struct {
	PrimaryNotesLocation PrimaryNotesLocation    `json:"primaryNotesLocation"`
	DailyNotes           DailyNotesSettings      `json:"dailyNotes"`
	WeeklyNotes          WeeklyNotesSettings     `json:"weeklyNotes"`
	MonthlyNotes         MonthlyNotesSettings    `json:"monthlyNotes"`
	FolderIcons          map[string]FolderIconID `json:"folderIcons"`
	// FolderColors are per-folder accent colors, keyed by `folder:subpath` (the
	// same key as FolderIcons). Persisted so the web client's recolors survive a
	// round-trip instead of being silently dropped. (#379)
	FolderColors map[string]FolderColorID `json:"folderColors"`
	// Favorites are note paths or `folder:subpath` keys pinned to the top of
	// the sidebar. Persisted so the web client's favorites survive a round-trip.
	Favorites []string `json:"favorites"`
}

// NoteMeta — vault-relative note metadata. Mirrors shared/ipc.ts NoteMeta.
type NoteMeta struct {
	Path           string     `json:"path"`
	Title          string     `json:"title"`
	Folder         NoteFolder `json:"folder"`
	SiblingOrder   int        `json:"siblingOrder"`
	CreatedAt      int64      `json:"createdAt"`
	UpdatedAt      int64      `json:"updatedAt"`
	Size           int64      `json:"size"`
	Tags           []string   `json:"tags"`
	Wikilinks      []string   `json:"wikilinks"`
	HasAttachments bool       `json:"hasAttachments"`
	Excerpt        string     `json:"excerpt"`
}

// NoteContent extends NoteMeta with the raw body.
type NoteContent struct {
	NoteMeta
	Body string `json:"body"`
}

// NoteComment — sidecar annotation/comment data for a note.
type NoteComment struct {
	ID          string `json:"id"`
	NotePath    string `json:"notePath"`
	AnchorStart int    `json:"anchorStart"`
	AnchorEnd   int    `json:"anchorEnd"`
	AnchorText  string `json:"anchorText"`
	Body        string `json:"body"`
	CreatedAt   int64  `json:"createdAt"`
	UpdatedAt   int64  `json:"updatedAt"`
	ResolvedAt  *int64 `json:"resolvedAt"`
}

// FolderEntry — mirrors shared/ipc.ts FolderEntry.
type FolderEntry struct {
	Folder       NoteFolder `json:"folder"`
	Subpath      string     `json:"subpath"`
	SiblingOrder int        `json:"siblingOrder"`
}

// AssetMeta — mirrors shared/ipc.ts AssetMeta.
type AssetMeta struct {
	Path         string `json:"path"`
	Name         string `json:"name"`
	Kind         string `json:"kind"`
	SiblingOrder int    `json:"siblingOrder"`
	Size         int64  `json:"size"`
	UpdatedAt    int64  `json:"updatedAt"`
}

// ImportedAsset — mirrors shared/ipc.ts ImportedAsset.
type ImportedAsset struct {
	Name     string `json:"name"`
	Path     string `json:"path"`
	Markdown string `json:"markdown"`
	Kind     string `json:"kind"`
}

// VaultInfo — mirrors shared/ipc.ts VaultInfo.
type VaultInfo struct {
	Root string `json:"root"`
	Name string `json:"name"`
}

// TextSearchCapabilities — mirrors shared/ipc.ts VaultTextSearchCapabilities.
type TextSearchCapabilities struct {
	Ripgrep bool `json:"ripgrep"`
	Fzf     bool `json:"fzf"`
}

// TextSearchMatch — mirrors shared/ipc.ts VaultTextSearchMatch.
type TextSearchMatch struct {
	Path       string     `json:"path"`
	Title      string     `json:"title"`
	Folder     NoteFolder `json:"folder"`
	LineNumber int        `json:"lineNumber"`
	Offset     int        `json:"offset"`
	LineText   string     `json:"lineText"`
}

// Task — mirrors shared/tasks.ts VaultTask.
type Task struct {
	ID         string     `json:"id"`
	SourcePath string     `json:"sourcePath"`
	NoteTitle  string     `json:"noteTitle"`
	NoteFolder NoteFolder `json:"noteFolder"`
	LineNumber int        `json:"lineNumber"`
	TaskIndex  int        `json:"taskIndex"`
	RawText    string     `json:"rawText"`
	Content    string     `json:"content"`
	Checked    bool       `json:"checked"`
	Due        string     `json:"due,omitempty"`
	Priority   string     `json:"priority,omitempty"`
	Waiting    bool       `json:"waiting"`
	Tags       []string   `json:"tags"`
}

// ChangeEvent — mirrors shared/ipc.ts VaultChangeEvent.
type ChangeEvent struct {
	Kind   string     `json:"kind"` // "add" | "change" | "unlink"
	Path   string     `json:"path"`
	Folder NoteFolder `json:"folder"`
	Scope  string     `json:"scope,omitempty"`
}

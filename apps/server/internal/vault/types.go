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

var defaultFolderPaths = map[NoteFolder]string{
	FolderInbox:   string(FolderInbox),
	FolderQuick:   string(FolderQuick),
	FolderArchive: string(FolderArchive),
	FolderTrash:   string(FolderTrash),
}

var reservedFolderPathNames = map[string]struct{}{
	"assets":         {},
	".zennotes":      {},
	"attachements":   {},
	"_assets":        {},
	"deleted-assets": {},
	"comments":       {},
}

func isValidFolderPath(p string) bool {
	if p == "" || len(p) > 128 {
		return false
	}
	if strings.Contains(p, "/") || strings.Contains(p, "\\") {
		return false
	}
	if p == "." || p == ".." || strings.HasPrefix(p, ".") {
		return false
	}
	for _, c := range p {
		if c == ':' || c == '*' || c == '?' || c == '"' || c == '<' || c == '>' ||
			c == '|' || c == '#' || c == '^' || c == '[' || c == ']' {
			return false
		}
	}
	if _, reserved := reservedFolderPathNames[strings.ToLower(p)]; reserved {
		return false
	}
	return true
}

// NormalizeSystemFolderPaths validates a raw systemFolderPaths map the way the
// vault settings reader does. Exported so callers that read vault.json without
// going through GetSettings (the watcher) classify against the same paths the
// vault itself uses. Mirrors normalizeSystemFolderPaths in
// packages/shared-domain/src/system-folder-paths.ts.
func NormalizeSystemFolderPaths(raw map[string]string) map[string]string {
	return normalizeSystemFolderPaths(raw)
}

func normalizeSystemFolderPaths(raw map[string]string) map[string]string {
	if raw == nil {
		return nil
	}
	next := map[string]string{}
	for _, folder := range AllFolders {
		val, ok := raw[string(folder)]
		if !ok || val == "" {
			continue
		}
		val = strings.TrimSpace(val)
		if !isValidFolderPath(val) {
			continue
		}
		if val == string(folder) {
			continue
		}
		// Never let a folder claim ANOTHER folder's default name, even when that
		// other folder has moved out of the way: {inbox: "archive", archive:
		// "inbox"} resolves without collision, and the swap it describes reads
		// backwards on every surface that classifies a path by its top segment
		// (and in every other app looking at the same directory).
		if claimsAnotherDefaultName(folder, val) {
			continue
		}
		next[string(folder)] = val
	}
	changed := true
	for changed {
		changed = false
		for _, folder := range AllFolders {
			val, ok := next[string(folder)]
			if !ok {
				continue
			}
			lower := strings.ToLower(val)
			for _, other := range AllFolders {
				if other == folder {
					continue
				}
				otherResolved := strings.ToLower(resolveFolderPath(other, next))
				if lower == otherResolved {
					delete(next, string(folder))
					changed = true
					break
				}
			}
		}
	}
	if len(next) == 0 {
		return nil
	}
	return next
}

func claimsAnotherDefaultName(folder NoteFolder, val string) bool {
	lower := strings.ToLower(val)
	for _, other := range AllFolders {
		if other == folder {
			continue
		}
		if lower == defaultFolderPaths[other] {
			return true
		}
	}
	return false
}

func resolveFolderPath(folder NoteFolder, paths map[string]string) string {
	if p, ok := paths[string(folder)]; ok {
		return p
	}
	return defaultFolderPaths[folder]
}

// SystemFolderForDirName returns the system folder that owns a top-level
// directory name, or false when the name belongs to no system folder (an
// ordinary user folder, an assets dir, anything else).
//
// This is THE classification rule for a path's first segment, because only the
// RESOLVED name of each folder counts: with inbox remapped to `01 - Entry`,
// `01 - Entry/` is the inbox and a directory literally named `inbox/` is just a
// user folder. Case-insensitive, since macOS and Windows preserve whatever case
// the directory was created with (#186). Mirrors systemFolderForDirName in
// packages/shared-domain/src/system-folder-paths.ts.
func SystemFolderForDirName(name string, paths map[string]string) (NoteFolder, bool) {
	lower := strings.ToLower(name)
	for _, folder := range AllFolders {
		if strings.ToLower(resolveFolderPath(folder, paths)) == lower {
			return folder, true
		}
	}
	return "", false
}

func FolderForRelativePath(rel string) (NoteFolder, bool) {
	return FolderForRelativePathWithSettings(rel, nil)
}

func FolderForRelativePathWithSettings(rel string, paths map[string]string) (NoteFolder, bool) {
	normalized := filepath.ToSlash(rel)
	top := strings.SplitN(normalized, "/", 2)[0]
	if top == "" || strings.HasPrefix(top, ".") {
		return "", false
	}
	if folder, ok := SystemFolderForDirName(top, paths); ok {
		return folder, true
	}
	// Only the dirs that are reserved no matter where the system folders live.
	// A default name whose folder has moved (`inbox/` once inbox is `bucket`)
	// is an ordinary user folder and must classify as one.
	if _, reserved := reservedNonSystemRootNames[top]; reserved {
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

// FileLocationMode mirrors shared/ipc.ts FileLocationMode: where a new
// drawing / database / task file is created.
type FileLocationMode string

const (
	FileLocationPrimary    FileLocationMode = "primary"
	FileLocationActiveNote FileLocationMode = "active-note"
	FileLocationFolder     FileLocationMode = "folder"
)

// FileLocationSetting mirrors shared/ipc.ts FileLocationSetting. Persisted so
// the web client's Drawings / Databases / Tasks location choices survive a
// round-trip instead of being silently dropped by the settings struct (#446).
type FileLocationSetting struct {
	Mode   FileLocationMode `json:"mode"`
	Folder string           `json:"folder,omitempty"`
}

type VaultSettings struct {
	PrimaryNotesLocation PrimaryNotesLocation    `json:"primaryNotesLocation"`
	DailyNotes           DailyNotesSettings      `json:"dailyNotes"`
	WeeklyNotes          WeeklyNotesSettings     `json:"weeklyNotes"`
	MonthlyNotes         MonthlyNotesSettings    `json:"monthlyNotes"`
	DrawingsLocation     FileLocationSetting     `json:"drawingsLocation"`
	DatabasesLocation    FileLocationSetting     `json:"databasesLocation"`
	TasksLocation        FileLocationSetting     `json:"tasksLocation"`
	FolderIcons          map[string]FolderIconID `json:"folderIcons"`
	// FolderColors are per-folder accent colors, keyed by `folder:subpath` (the
	// same key as FolderIcons). Persisted so the web client's recolors survive a
	// round-trip instead of being silently dropped. (#379)
	FolderColors map[string]FolderColorID `json:"folderColors"`
	// Favorites are note paths or `folder:subpath` keys pinned to the top of
	// the sidebar. Persisted so the web client's favorites survive a round-trip.
	Favorites []string `json:"favorites"`
	// Per-system-folder on-disk path overrides (#115). Maps internal folder IDs
	// to vault-relative directory names. Absent entries fall back to the default.
	SystemFolderPaths map[string]string `json:"systemFolderPaths,omitempty"`
	// Tasks-system settings (#458). Mirrors shared/ipc.ts VaultSettings.tasks;
	// persisted as a first-class field so a web client's settings write never
	// drops a desktop-written exclusion list (the #446/#379 round-trip rule).
	Tasks *TasksSettings `json:"tasks,omitempty"`
	// Typst preamble settings (#486, #562). Mirrors shared/ipc.ts
	// VaultSettings.typstPreambles; a first-class field for the same round-trip
	// reason as Tasks above.
	TypstPreambles *TypstPreambleSettings `json:"typstPreambles,omitempty"`
}

// TasksSettings mirrors shared/ipc.ts VaultSettings.tasks (#458).
type TasksSettings struct {
	// ExcludedFolders lists vault-relative directory paths (as they exist on
	// disk) whose notes never feed the Tasks surfaces.
	ExcludedFolders []string `json:"excludedFolders,omitempty"`
}

// TypstPreambleSettings mirrors shared/ipc.ts VaultSettings.typstPreambles
// (#562).
type TypstPreambleSettings struct {
	// Folder names the directory whose notes are Typst preambles, matched at
	// any depth. Empty means the default, `typst`.
	Folder string `json:"folder,omitempty"`
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

// DeletedAsset — mirrors shared/ipc.ts DeletedAsset. The meta file it is
// read from (.zn-deleted.json) is shared with the desktop app: a vault can be
// served remotely today and opened locally tomorrow, so the field set must
// stay byte-compatible with desktop vault.ts.
type DeletedAsset struct {
	Path      string `json:"path"`
	Name      string `json:"name"`
	UndoToken string `json:"undoToken"`
	DeletedAt string `json:"deletedAt,omitempty"`
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
	// Cancelled is true for a `[-]` task — intentionally abandoned (#450).
	Cancelled bool `json:"cancelled,omitempty"`
	// InProgress is true for a `[/]` task: started, not finished (#512).
	// Unlike Checked/Cancelled it is still open work, so it keeps its place
	// in the active buckets on every surface.
	InProgress bool `json:"inProgress,omitempty"`
	// Forwarded is true for a `[>]` record: the task moved to another note
	// and a live copy exists there (#316). Without it, a web client read
	// carried tasks as open twice, record and copy alike (#611 review).
	Forwarded bool   `json:"forwarded,omitempty"`
	Due       string `json:"due,omitempty"`
	Priority  string `json:"priority,omitempty"`
	Waiting   bool   `json:"waiting"`
	// Fields contains inline @key:value metadata (or a file task's explicit
	// frontmatter status) so remote Kanban boards group tasks exactly like the
	// desktop parser (#643). Status is the effective status: Fields["status"]
	// when set, and "open" for a file task whose frontmatter says nothing,
	// which deliberately stays out of Fields (#672).
	Fields map[string]string `json:"fields"`
	Status string            `json:"status,omitempty"`
	Tags   []string          `json:"tags"`
	// Kind is how the task is stored: "file" for a whole-note task
	// (TaskNotes-style, tagged `task` with metadata in frontmatter) or
	// empty/"inline" for a classic `- [ ]` checkbox line. The renderer
	// branches its toggle logic on this.
	Kind string `json:"kind,omitempty"`
	// Scheduled and CompletedDate are file-task-only frontmatter dates
	// (YYYY-MM-DD). They mirror the TS VaultTask shape.
	Scheduled     string `json:"scheduled,omitempty"`
	CompletedDate string `json:"completedDate,omitempty"`
}

// ChangeEvent — mirrors shared/ipc.ts VaultChangeEvent.
type ChangeEvent struct {
	Kind   string     `json:"kind"` // "add" | "change" | "unlink"
	Path   string     `json:"path"`
	Folder NoteFolder `json:"folder"`
	Scope  string     `json:"scope,omitempty"`
}

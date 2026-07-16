package vault

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"hash/fnv"
	"io"
	"io/fs"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	// AssetsDir is the canonical top-level folder for assets; attachements/_assets
	// are recognized legacy dirs. Asset migration runs on the desktop (#185).
	AssetsDir             = "assets"
	PrimaryAttachmentsDir = "attachements"
	internalVaultDir      = ".zennotes"
	vaultSettingsFile     = "vault.json"
	noteMetaCacheFile     = "note-meta-cache-v1.json"
	noteMetaCacheVersion  = 1
	noteCommentsDir       = "comments"
	noteCommentsSuffix    = ".comments.json"
	noteMetaReadLimit     = 64
	// formDirSuffix marks a database folder (`<Name>.base/`), a self-contained
	// folder holding data.csv, schema.json, and record-page notes. Databases are
	// a desktop-only feature; the server hides these folders (it neither serves
	// the grid nor exposes the internals as loose notes/assets).
	formDirSuffix = ".base"
)

// isFormDirName reports whether a folder name marks a database folder.
func isFormDirName(name string) bool {
	return strings.HasSuffix(strings.ToLower(name), formDirSuffix)
}

// excalidrawExt marks a standalone Excalidraw drawing — the native Excalidraw
// JSON scene format. Drawings are a first-class file type alongside Markdown
// notes: listed in the sidebar (not as assets) and opened in a dedicated editor.
const excalidrawExt = ".excalidraw"

// isExcalidrawName reports whether a filename is an Excalidraw drawing.
func isExcalidrawName(name string) bool {
	return strings.EqualFold(filepath.Ext(name), excalidrawExt)
}

// noteExt returns the on-disk extension for a note-like file, preserving
// `.excalidraw` for drawings and defaulting to `.md` otherwise. Rename/move/
// duplicate use it so a drawing never silently becomes a Markdown note.
func noteExt(name string) string {
	if isExcalidrawName(name) {
		return excalidrawExt
	}
	return ".md"
}

// emptyExcalidrawJSON mirrors emptyExcalidrawDocument() in
// packages/shared-domain/src/excalidraw.ts (JSON.stringify, 2-space indent).
const emptyExcalidrawJSON = `{
  "type": "excalidraw",
  "version": 2,
  "source": "zennotes",
  "elements": [],
  "appState": {},
  "files": {}
}`

// ErrAssetTooLarge is returned when an asset upload exceeds the
// vault's MaxAssetBytes limit.
var ErrAssetTooLarge = errors.New("asset exceeds maximum size")

var legacyAttachmentsDirs = []string{PrimaryAttachmentsDir, "_assets"}
var reservedRootNames = map[string]struct{}{
	string(FolderInbox):   {},
	string(FolderQuick):   {},
	string(FolderArchive): {},
	string(FolderTrash):   {},
	AssetsDir:             {},
	PrimaryAttachmentsDir: {},
	internalVaultDir:      {},
}

var hiddenPrimaryRootNames = map[string]struct{}{
	string(FolderQuick):   {},
	string(FolderArchive): {},
	string(FolderTrash):   {},
	AssetsDir:             {},
	PrimaryAttachmentsDir: {},
	internalVaultDir:      {},
}
var validFolderIconIDs = map[FolderIconID]struct{}{
	"folder":     {},
	"bolt":       {},
	"tray":       {},
	"archive":    {},
	"trash":      {},
	"book":       {},
	"bookmark":   {},
	"calendar":   {},
	"briefcase":  {},
	"tag":        {},
	"document":   {},
	"sparkle":    {},
	"code":       {},
	"user":       {},
	"star":       {},
	"heart":      {},
	"link":       {},
	"lightbulb":  {},
	"flask":      {},
	"graduation": {},
	"music":      {},
	"image":      {},
	"palette":    {},
	"terminal":   {},
	"wrench":     {},
	"globe":      {},
	"map":        {},
	"chart":      {},
	"home":       {},
}

// validFolderColorIDs mirrors the FolderColorId presets in
// packages/bridge-contract/src/ipc.ts. (#379)
var validFolderColorIDs = map[FolderColorID]struct{}{
	"red":    {},
	"orange": {},
	"amber":  {},
	"green":  {},
	"teal":   {},
	"sky":    {},
	"blue":   {},
	"indigo": {},
	"violet": {},
	"pink":   {},
}

func init() {
	for _, dir := range legacyAttachmentsDirs {
		reservedRootNames[dir] = struct{}{}
		hiddenPrimaryRootNames[dir] = struct{}{}
	}
}

func shouldHidePrimaryRootName(name string) bool {
	_, hidden := hiddenPrimaryRootNames[name]
	return hidden
}

// Vault encapsulates all operations against a filesystem vault root.
// It is concurrency-safe at the public-method level; internally most
// ops do a short RW-lock dance around mutating operations.
type Vault struct {
	root          string
	fileMode      fs.FileMode
	dirMode       fs.FileMode
	maxAssetBytes int64
	mu            sync.RWMutex
	searchCacheMu sync.Mutex
	searchCache   *textSearchCache
	metaCacheMu   sync.Mutex
	metaCache     map[string]noteMetaCacheEntry
	metaCacheLoad bool
	metaCacheGen  uint64
}

// Options tunes vault filesystem permissions and limits. Zero values
// fall back to a private-by-default profile (0o600 / 0o700, 50 MiB).
type Options struct {
	FileMode      fs.FileMode
	DirMode       fs.FileMode
	MaxAssetBytes int64
}

type textSearchFile struct {
	abs      string
	relPosix string
	title    string
	folder   NoteFolder
}

type textSearchCandidate struct {
	match     TextSearchMatch
	lineLower string
}

type textSearchCache struct {
	signature  uint64
	candidates []textSearchCandidate
}

type noteMetaCacheEntry struct {
	mtimeMs float64
	size    int64
	meta    NoteMeta
}

type persistedNoteMetaCache struct {
	Version int                      `json:"version"`
	Entries []persistedNoteMetaEntry `json:"entries"`
}

type persistedNoteMetaEntry struct {
	Path    string   `json:"path"`
	MtimeMs float64  `json:"mtimeMs"`
	Size    int64    `json:"size"`
	Meta    NoteMeta `json:"meta"`
}

func mtimeMs(info fs.FileInfo) float64 {
	return float64(info.ModTime().UnixNano()) / 1_000_000
}

func sameMtimeMs(a, b float64) bool {
	return math.Abs(a-b) < 0.001
}

func (v *Vault) noteMetaCachePath() string {
	return filepath.Join(v.root, internalVaultDir, noteMetaCacheFile)
}

func (v *Vault) invalidateNoteMetaCache() {
	v.metaCacheMu.Lock()
	v.metaCache = map[string]noteMetaCacheEntry{}
	v.metaCacheLoad = false
	v.metaCacheGen++
	v.metaCacheMu.Unlock()
}

func (v *Vault) invalidateTextSearchCache() {
	v.searchCacheMu.Lock()
	v.searchCache = nil
	v.searchCacheMu.Unlock()
	v.invalidateNoteMetaCache()
}

func New(root string, opts Options) (*Vault, error) {
	abs, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	if opts.FileMode == 0 {
		opts.FileMode = 0o600
	}
	if opts.DirMode == 0 {
		opts.DirMode = 0o700
	}
	if opts.MaxAssetBytes <= 0 {
		opts.MaxAssetBytes = 50 << 20
	}
	if err := os.MkdirAll(abs, opts.DirMode); err != nil {
		return nil, err
	}
	v := &Vault{
		root:          abs,
		fileMode:      opts.FileMode,
		dirMode:       opts.DirMode,
		maxAssetBytes: opts.MaxAssetBytes,
		metaCache:     map[string]noteMetaCacheEntry{},
	}
	if err := v.EnsureLayout(); err != nil {
		return nil, err
	}
	return v, nil
}

func (v *Vault) Root() string {
	return v.root
}

func (v *Vault) Info() VaultInfo {
	return VaultInfo{Root: v.root, Name: filepath.Base(v.root)}
}

func cloneSettings(settings VaultSettings) VaultSettings {
	folderIcons := make(map[string]FolderIconID, len(settings.FolderIcons))
	for key, value := range settings.FolderIcons {
		folderIcons[key] = value
	}
	folderColors := make(map[string]FolderColorID, len(settings.FolderColors))
	for key, value := range settings.FolderColors {
		folderColors[key] = value
	}
	favorites := make([]string, len(settings.Favorites))
	copy(favorites, settings.Favorites)
	dailyLegacyPatterns := make([]DateNotePatternSettings, len(settings.DailyNotes.LegacyPatterns))
	copy(dailyLegacyPatterns, settings.DailyNotes.LegacyPatterns)
	weeklyLegacyPatterns := make([]DateNotePatternSettings, len(settings.WeeklyNotes.LegacyPatterns))
	copy(weeklyLegacyPatterns, settings.WeeklyNotes.LegacyPatterns)
	monthlyLegacyPatterns := make([]DateNotePatternSettings, len(settings.MonthlyNotes.LegacyPatterns))
	copy(monthlyLegacyPatterns, settings.MonthlyNotes.LegacyPatterns)
	return VaultSettings{
		PrimaryNotesLocation: settings.PrimaryNotesLocation,
		DailyNotes: DailyNotesSettings{
			Enabled:                 settings.DailyNotes.Enabled,
			Directory:               settings.DailyNotes.Directory,
			TitlePattern:            settings.DailyNotes.TitlePattern,
			Locale:                  settings.DailyNotes.Locale,
			LegacyPatterns:          dailyLegacyPatterns,
			TemplateID:              settings.DailyNotes.TemplateID,
			TasksDueOnNoteDate:      settings.DailyNotes.TasksDueOnNoteDate,
			RolloverUnfinishedTasks: settings.DailyNotes.RolloverUnfinishedTasks,
		},
		WeeklyNotes: WeeklyNotesSettings{
			Enabled:        settings.WeeklyNotes.Enabled,
			Directory:      settings.WeeklyNotes.Directory,
			TitlePattern:   settings.WeeklyNotes.TitlePattern,
			Locale:         settings.WeeklyNotes.Locale,
			LegacyPatterns: weeklyLegacyPatterns,
			TemplateID:     settings.WeeklyNotes.TemplateID,
		},
		MonthlyNotes: MonthlyNotesSettings{
			Enabled:        settings.MonthlyNotes.Enabled,
			Directory:      settings.MonthlyNotes.Directory,
			TitlePattern:   settings.MonthlyNotes.TitlePattern,
			Locale:         settings.MonthlyNotes.Locale,
			LegacyPatterns: monthlyLegacyPatterns,
			TemplateID:     settings.MonthlyNotes.TemplateID,
		},
		FolderIcons:  folderIcons,
		FolderColors: folderColors,
		Favorites:    favorites,
	}
}

func normalizeDailyNotesDirectory(value string) string {
	trimmed := strings.Trim(value, "/")
	if trimmed == "" {
		return DefaultDailyNotesDirectory
	}
	return trimmed
}

func normalizeDailyNoteTitlePattern(value string) string {
	trimmed := strings.TrimSpace(strings.NewReplacer("/", "-", "\\", "-").Replace(value))
	if trimmed == "" {
		return DefaultDailyNoteTitlePattern
	}
	return trimmed
}

func normalizeDailyNoteLocale(value string) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return DefaultDailyNoteLocale
	}
	return trimmed
}

func normalizeWeeklyNotesDirectory(value string) string {
	trimmed := strings.Trim(value, "/")
	if trimmed == "" {
		return DefaultWeeklyNotesDirectory
	}
	return trimmed
}

func normalizeWeeklyNoteTitlePattern(value string) string {
	trimmed := strings.TrimSpace(strings.NewReplacer("/", "-", "\\", "-").Replace(value))
	if trimmed == "" {
		return DefaultWeeklyNoteTitlePattern
	}
	return trimmed
}

func normalizeWeeklyNoteLocale(value string) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return DefaultWeeklyNoteLocale
	}
	return trimmed
}

func normalizeMonthlyNotesDirectory(value string) string {
	trimmed := strings.Trim(value, "/")
	if trimmed == "" {
		return DefaultMonthlyNotesDirectory
	}
	return trimmed
}

func normalizeMonthlyNoteTitlePattern(value string) string {
	trimmed := strings.TrimSpace(strings.NewReplacer("/", "-", "\\", "-").Replace(value))
	if trimmed == "" {
		return DefaultMonthlyNoteTitlePattern
	}
	return trimmed
}

func normalizeMonthlyNoteLocale(value string) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return DefaultMonthlyNoteLocale
	}
	return trimmed
}

func normalizeDailyNoteLegacyPatterns(value []DateNotePatternSettings) []DateNotePatternSettings {
	out := []DateNotePatternSettings{}
	seen := map[string]bool{}
	for _, pattern := range value {
		next := DateNotePatternSettings{
			Directory:    normalizeDailyNotesDirectory(pattern.Directory),
			TitlePattern: normalizeDailyNoteTitlePattern(pattern.TitlePattern),
			Locale:       normalizeDailyNoteLocale(pattern.Locale),
		}
		key := next.Directory + "\x00" + next.TitlePattern + "\x00" + next.Locale
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, next)
	}
	return out
}

func normalizeWeeklyNoteLegacyPatterns(value []DateNotePatternSettings) []DateNotePatternSettings {
	out := []DateNotePatternSettings{}
	seen := map[string]bool{}
	for _, pattern := range value {
		next := DateNotePatternSettings{
			Directory:    normalizeWeeklyNotesDirectory(pattern.Directory),
			TitlePattern: normalizeWeeklyNoteTitlePattern(pattern.TitlePattern),
			Locale:       normalizeWeeklyNoteLocale(pattern.Locale),
		}
		key := next.Directory + "\x00" + next.TitlePattern + "\x00" + next.Locale
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, next)
	}
	return out
}

func normalizeMonthlyNoteLegacyPatterns(value []DateNotePatternSettings) []DateNotePatternSettings {
	out := []DateNotePatternSettings{}
	seen := map[string]bool{}
	for _, pattern := range value {
		next := DateNotePatternSettings{
			Directory:    normalizeMonthlyNotesDirectory(pattern.Directory),
			TitlePattern: normalizeMonthlyNoteTitlePattern(pattern.TitlePattern),
			Locale:       normalizeMonthlyNoteLocale(pattern.Locale),
		}
		key := next.Directory + "\x00" + next.TitlePattern + "\x00" + next.Locale
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, next)
	}
	return out
}

func normalizePrimaryNotesLocation(value PrimaryNotesLocation) PrimaryNotesLocation {
	if value == PrimaryNotesRoot {
		return PrimaryNotesRoot
	}
	return PrimaryNotesInbox
}

func normalizeVaultSettings(value VaultSettings, fallbackPrimary PrimaryNotesLocation) VaultSettings {
	folderIcons := map[string]FolderIconID{}
	for key, value := range value.FolderIcons {
		if key == "" {
			continue
		}
		if _, ok := validFolderIconIDs[value]; !ok {
			continue
		}
		folderIcons[key] = value
	}
	folderColors := map[string]FolderColorID{}
	for key, value := range value.FolderColors {
		if key == "" {
			continue
		}
		if _, ok := validFolderColorIDs[value]; !ok {
			continue
		}
		folderColors[key] = value
	}
	return VaultSettings{
		PrimaryNotesLocation: normalizePrimaryNotesLocation(func() PrimaryNotesLocation {
			if value.PrimaryNotesLocation == "" {
				return fallbackPrimary
			}
			return value.PrimaryNotesLocation
		}()),
		DailyNotes: DailyNotesSettings{
			Enabled:                 value.DailyNotes.Enabled,
			Directory:               normalizeDailyNotesDirectory(value.DailyNotes.Directory),
			TitlePattern:            normalizeDailyNoteTitlePattern(value.DailyNotes.TitlePattern),
			Locale:                  normalizeDailyNoteLocale(value.DailyNotes.Locale),
			LegacyPatterns:          normalizeDailyNoteLegacyPatterns(value.DailyNotes.LegacyPatterns),
			TemplateID:              value.DailyNotes.TemplateID,
			TasksDueOnNoteDate:      value.DailyNotes.TasksDueOnNoteDate,
			RolloverUnfinishedTasks: value.DailyNotes.RolloverUnfinishedTasks,
		},
		WeeklyNotes: WeeklyNotesSettings{
			Enabled:        value.WeeklyNotes.Enabled,
			Directory:      normalizeWeeklyNotesDirectory(value.WeeklyNotes.Directory),
			TitlePattern:   normalizeWeeklyNoteTitlePattern(value.WeeklyNotes.TitlePattern),
			Locale:         normalizeWeeklyNoteLocale(value.WeeklyNotes.Locale),
			LegacyPatterns: normalizeWeeklyNoteLegacyPatterns(value.WeeklyNotes.LegacyPatterns),
			TemplateID:     value.WeeklyNotes.TemplateID,
		},
		MonthlyNotes: MonthlyNotesSettings{
			Enabled:        value.MonthlyNotes.Enabled,
			Directory:      normalizeMonthlyNotesDirectory(value.MonthlyNotes.Directory),
			TitlePattern:   normalizeMonthlyNoteTitlePattern(value.MonthlyNotes.TitlePattern),
			Locale:         normalizeMonthlyNoteLocale(value.MonthlyNotes.Locale),
			LegacyPatterns: normalizeMonthlyNoteLegacyPatterns(value.MonthlyNotes.LegacyPatterns),
			TemplateID:     value.MonthlyNotes.TemplateID,
		},
		FolderIcons:  folderIcons,
		FolderColors: folderColors,
		Favorites:    normalizeFavorites(value.Favorites),
	}
}

func normalizeFavorites(value []string) []string {
	out := []string{}
	seen := map[string]struct{}{}
	for _, entry := range value {
		if entry == "" {
			continue
		}
		if _, ok := seen[entry]; ok {
			continue
		}
		seen[entry] = struct{}{}
		out = append(out, entry)
	}
	return out
}

func folderIconKey(folder NoteFolder, subpath string) string {
	return fmt.Sprintf("%s:%s", folder, subpath)
}

func rewriteFolderIconsForRename(
	folderIcons map[string]FolderIconID,
	folder NoteFolder,
	oldSubpath string,
	newSubpath string,
) map[string]FolderIconID {
	next := map[string]FolderIconID{}
	exactKey := folderIconKey(folder, oldSubpath)
	prefix := exactKey + "/"
	for key, value := range folderIcons {
		switch {
		case key == exactKey:
			next[folderIconKey(folder, newSubpath)] = value
		case strings.HasPrefix(key, prefix):
			next[folderIconKey(folder, newSubpath)+key[len(exactKey):]] = value
		default:
			next[key] = value
		}
	}
	return next
}

// rewriteFolderColorsForRename keeps a folder's accent color attached to it (and
// its descendants) when the folder is renamed, mirroring the icon rewrite. (#379)
func rewriteFolderColorsForRename(
	folderColors map[string]FolderColorID,
	folder NoteFolder,
	oldSubpath string,
	newSubpath string,
) map[string]FolderColorID {
	next := map[string]FolderColorID{}
	exactKey := folderIconKey(folder, oldSubpath)
	prefix := exactKey + "/"
	for key, value := range folderColors {
		switch {
		case key == exactKey:
			next[folderIconKey(folder, newSubpath)] = value
		case strings.HasPrefix(key, prefix):
			next[folderIconKey(folder, newSubpath)+key[len(exactKey):]] = value
		default:
			next[key] = value
		}
	}
	return next
}

func removeFolderIcons(
	folderIcons map[string]FolderIconID,
	folder NoteFolder,
	subpath string,
) map[string]FolderIconID {
	next := map[string]FolderIconID{}
	exactKey := folderIconKey(folder, subpath)
	prefix := exactKey + "/"
	for key, value := range folderIcons {
		if key == exactKey || strings.HasPrefix(key, prefix) {
			continue
		}
		next[key] = value
	}
	return next
}

// removeFolderColors drops the deleted folder's (and its descendants') accent
// colors, mirroring removeFolderIcons. (#379)
func removeFolderColors(
	folderColors map[string]FolderColorID,
	folder NoteFolder,
	subpath string,
) map[string]FolderColorID {
	next := map[string]FolderColorID{}
	exactKey := folderIconKey(folder, subpath)
	prefix := exactKey + "/"
	for key, value := range folderColors {
		if key == exactKey || strings.HasPrefix(key, prefix) {
			continue
		}
		next[key] = value
	}
	return next
}

func duplicateFolderIcons(
	folderIcons map[string]FolderIconID,
	folder NoteFolder,
	sourceSubpath string,
	targetSubpath string,
) map[string]FolderIconID {
	next := map[string]FolderIconID{}
	for key, value := range folderIcons {
		next[key] = value
	}
	exactKey := folderIconKey(folder, sourceSubpath)
	prefix := exactKey + "/"
	for key, value := range folderIcons {
		switch {
		case key == exactKey:
			next[folderIconKey(folder, targetSubpath)] = value
		case strings.HasPrefix(key, prefix):
			next[folderIconKey(folder, targetSubpath)+key[len(exactKey):]] = value
		}
	}
	return next
}

// duplicateFolderColors copies the source folder's (and descendants') accent
// colors onto the duplicated folder, mirroring duplicateFolderIcons. (#379)
func duplicateFolderColors(
	folderColors map[string]FolderColorID,
	folder NoteFolder,
	sourceSubpath string,
	targetSubpath string,
) map[string]FolderColorID {
	next := map[string]FolderColorID{}
	for key, value := range folderColors {
		next[key] = value
	}
	exactKey := folderIconKey(folder, sourceSubpath)
	prefix := exactKey + "/"
	for key, value := range folderColors {
		switch {
		case key == exactKey:
			next[folderIconKey(folder, targetSubpath)] = value
		case strings.HasPrefix(key, prefix):
			next[folderIconKey(folder, targetSubpath)+key[len(exactKey):]] = value
		}
	}
	return next
}

func (v *Vault) settingsPath() string {
	return filepath.Join(v.root, internalVaultDir, vaultSettingsFile)
}

func (v *Vault) commentsRoot() string {
	return filepath.Join(v.root, internalVaultDir, noteCommentsDir)
}

func (v *Vault) commentsPath(rel string) (string, error) {
	return SafeJoin(v.commentsRoot(), filepath.ToSlash(rel)+noteCommentsSuffix)
}

func (v *Vault) inferPrimaryNotesLocation() PrimaryNotesLocation {
	entries, err := os.ReadDir(v.root)
	if err != nil {
		return PrimaryNotesInbox
	}
	for _, entry := range entries {
		name := entry.Name()
		if strings.HasPrefix(name, ".") {
			continue
		}
		if _, reserved := reservedRootNames[name]; reserved {
			continue
		}
		if entry.IsDir() || strings.EqualFold(filepath.Ext(name), ".md") || isExcalidrawName(name) {
			return PrimaryNotesRoot
		}
	}
	return PrimaryNotesInbox
}

func (v *Vault) vaultLooksEmpty() bool {
	entries, err := os.ReadDir(v.root)
	if err != nil {
		return true
	}
	for _, entry := range entries {
		name := entry.Name()
		if strings.HasPrefix(name, ".") || name == internalVaultDir {
			continue
		}
		return false
	}
	return true
}

func (v *Vault) GetSettings() (VaultSettings, error) {
	fallbackPrimary := v.inferPrimaryNotesLocation()
	raw, err := os.ReadFile(v.settingsPath())
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return normalizeVaultSettings(VaultSettings{}, fallbackPrimary), nil
		}
		return VaultSettings{}, err
	}
	var settings VaultSettings
	if err := json.Unmarshal(raw, &settings); err != nil {
		return VaultSettings{}, err
	}
	return normalizeVaultSettings(settings, fallbackPrimary), nil
}

func (v *Vault) SetSettings(next VaultSettings) (VaultSettings, error) {
	fallbackPrimary := v.inferPrimaryNotesLocation()
	normalized := normalizeVaultSettings(next, fallbackPrimary)
	if err := os.MkdirAll(filepath.Dir(v.settingsPath()), v.dirMode); err != nil {
		return VaultSettings{}, err
	}
	data, err := json.MarshalIndent(normalized, "", "  ")
	if err != nil {
		return VaultSettings{}, err
	}
	if err := os.WriteFile(v.settingsPath(), data, v.fileMode); err != nil {
		return VaultSettings{}, err
	}
	if normalized.PrimaryNotesLocation == PrimaryNotesInbox {
		if err := os.MkdirAll(filepath.Join(v.root, string(FolderInbox)), v.dirMode); err != nil {
			return VaultSettings{}, err
		}
	}
	v.invalidateTextSearchCache()
	return cloneSettings(normalized), nil
}

func (v *Vault) primaryNotesRoot() (string, error) {
	settings, err := v.GetSettings()
	if err != nil {
		return "", err
	}
	if settings.PrimaryNotesLocation == PrimaryNotesRoot {
		return v.root, nil
	}
	return filepath.Join(v.root, string(FolderInbox)), nil
}

func (v *Vault) folderRoot(folder NoteFolder) (string, error) {
	if folder == FolderInbox {
		return v.primaryNotesRoot()
	}
	return filepath.Join(v.root, string(folder)), nil
}

// EnsureLayout creates the four top-level folders and seeds a welcome
// note if the vault is empty. Matches src/main/vault.ts ensureVaultLayout.
func (v *Vault) EnsureLayout() error {
	wasEmpty := v.vaultLooksEmpty()
	settings, err := v.GetSettings()
	if err != nil {
		return err
	}
	for _, f := range AllFolders {
		if f == FolderInbox && settings.PrimaryNotesLocation == PrimaryNotesRoot {
			continue
		}
		if err := os.MkdirAll(filepath.Join(v.root, string(f)), v.dirMode); err != nil {
			return err
		}
	}
	if wasEmpty {
		welcomeDir, err := v.primaryNotesRoot()
		if err != nil {
			return err
		}
		if err := os.MkdirAll(welcomeDir, v.dirMode); err != nil {
			return err
		}
		welcome := filepath.Join(welcomeDir, "Welcome.md")
		if _, err := os.Stat(welcome); errors.Is(err, os.ErrNotExist) {
			_ = os.WriteFile(welcome, []byte(welcomeNote), v.fileMode)
		}
	}
	return nil
}

// --- Listing ---

func validCachedNoteMeta(meta NoteMeta, path string) bool {
	if meta.Path != path || meta.Title == "" || !IsValidFolder(meta.Folder) {
		return false
	}
	if meta.Tags == nil || meta.Wikilinks == nil {
		return false
	}
	return true
}

func (v *Vault) hydratePersistedNoteMetaCache() {
	v.metaCacheMu.Lock()
	if v.metaCacheLoad {
		v.metaCacheMu.Unlock()
		return
	}
	v.metaCacheLoad = true
	v.metaCacheMu.Unlock()

	raw, err := os.ReadFile(v.noteMetaCachePath())
	if err != nil {
		return
	}
	var persisted persistedNoteMetaCache
	if err := json.Unmarshal(raw, &persisted); err != nil || persisted.Version != noteMetaCacheVersion {
		return
	}

	entries := map[string]noteMetaCacheEntry{}
	for _, entry := range persisted.Entries {
		if entry.Path == "" || !validCachedNoteMeta(entry.Meta, entry.Path) {
			continue
		}
		abs, err := SafeJoin(v.root, entry.Path)
		if err != nil {
			continue
		}
		entries[abs] = noteMetaCacheEntry{
			mtimeMs: entry.MtimeMs,
			size:    entry.Size,
			meta:    entry.Meta,
		}
	}
	if len(entries) == 0 {
		return
	}

	v.metaCacheMu.Lock()
	for key, entry := range entries {
		v.metaCache[key] = entry
	}
	v.metaCacheMu.Unlock()
}

func (v *Vault) persistNoteMetaCacheSnapshot(metas []NoteMeta) {
	if os.Getenv("ZEN_PERF_DISABLE_PERSISTED_META_CACHE") == "1" {
		return
	}
	v.metaCacheMu.Lock()
	generation := v.metaCacheGen
	v.metaCacheMu.Unlock()
	if len(metas) == 0 {
		return
	}
	metas = append([]NoteMeta(nil), metas...)

	go func(metas []NoteMeta, generation uint64) {
		time.Sleep(time.Second)

		entries := make([]persistedNoteMetaEntry, 0, len(metas))
		v.metaCacheMu.Lock()
		if v.metaCacheGen != generation {
			v.metaCacheMu.Unlock()
			return
		}
		for _, meta := range metas {
			abs, err := SafeJoin(v.root, meta.Path)
			if err != nil {
				continue
			}
			cached, ok := v.metaCache[abs]
			if !ok {
				continue
			}
			metaCopy := cached.meta
			metaCopy.SiblingOrder = meta.SiblingOrder
			entries = append(entries, persistedNoteMetaEntry{
				Path:    meta.Path,
				MtimeMs: cached.mtimeMs,
				Size:    cached.size,
				Meta:    metaCopy,
			})
		}
		v.metaCacheMu.Unlock()
		if len(entries) == 0 {
			return
		}

		target := v.noteMetaCachePath()
		temp := fmt.Sprintf("%s.%d.%d.tmp", target, os.Getpid(), time.Now().UnixNano())
		if err := os.MkdirAll(filepath.Dir(target), v.dirMode); err != nil {
			return
		}
		data, err := json.Marshal(persistedNoteMetaCache{
			Version: noteMetaCacheVersion,
			Entries: entries,
		})
		if err != nil {
			return
		}
		data = append(data, '\n')
		if err := os.WriteFile(temp, data, v.fileMode); err != nil {
			return
		}
		v.metaCacheMu.Lock()
		stillCurrent := v.metaCacheGen == generation
		v.metaCacheMu.Unlock()
		if !stillCurrent {
			_ = os.Remove(temp)
			return
		}
		if err := os.Rename(temp, target); err != nil {
			_ = os.Remove(temp)
		}
	}(metas, generation)
}

// ListNotes walks every top-level folder and returns metadata for each
// note. Sibling order is the directory-listing order per folder, which
// matches the TS version's behaviour for non-sorted filesystems.
// isSkippableWalkErr reports whether a directory-walk error should skip the
// offending entry and keep scanning, rather than aborting the whole vault scan.
// Covers entries that vanished mid-scan and, importantly for self-hosted
// servers, entries the process lacks permission to read (e.g. a vault copied in
// with root-owned files while the container runs as a non-root user). (#159)
func isSkippableWalkErr(err error) bool {
	return errors.Is(err, os.ErrNotExist) || errors.Is(err, os.ErrPermission)
}

func (v *Vault) ListNotes() ([]NoteMeta, error) {
	v.mu.RLock()
	defer v.mu.RUnlock()
	v.hydratePersistedNoteMetaCache()

	type noteFile struct {
		folder NoteFolder
		path   string
	}

	files := []noteFile{}
	for _, folder := range AllFolders {
		folderRoot, err := v.folderRoot(folder)
		if err != nil {
			return nil, err
		}
		isPrimaryRoot := folder == FolderInbox && filepath.Clean(folderRoot) == filepath.Clean(v.root)
		err = filepath.WalkDir(folderRoot, func(path string, d os.DirEntry, err error) error {
			if err != nil {
				if isSkippableWalkErr(err) {
					return nil
				}
				return err
			}
			if d.IsDir() {
				if strings.HasPrefix(d.Name(), ".") && path != folderRoot {
					return filepath.SkipDir
				}
				if isFormDirName(d.Name()) {
					return filepath.SkipDir // database folder — not loose notes
				}
				if isPrimaryRoot && path != folderRoot {
					parent := filepath.Dir(path)
					if filepath.Clean(parent) == filepath.Clean(folderRoot) {
						if shouldHidePrimaryRootName(d.Name()) {
							return filepath.SkipDir
						}
					}
				}
				return nil
			}
			if isPrimaryRoot {
				parent := filepath.Dir(path)
				if filepath.Clean(parent) == filepath.Clean(folderRoot) {
					if shouldHidePrimaryRootName(d.Name()) {
						return filepath.SkipDir
					}
				}
			}
			if !strings.EqualFold(filepath.Ext(d.Name()), ".md") && !isExcalidrawName(d.Name()) {
				return nil
			}
			files = append(files, noteFile{folder: folder, path: path})
			return nil
		})
		if err != nil {
			return nil, err
		}
	}

	results := make([]NoteMeta, len(files))
	ok := make([]bool, len(files))
	limit := noteMetaReadLimit
	if len(files) < limit {
		limit = len(files)
	}
	sem := make(chan struct{}, limit)
	var wg sync.WaitGroup
	for index, file := range files {
		wg.Add(1)
		go func(index int, file noteFile) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			meta, err := v.readMeta(file.folder, file.path)
			if err != nil {
				return // skip unreadable files silently
			}
			results[index] = meta
			ok[index] = true
		}(index, file)
	}
	wg.Wait()

	out := make([]NoteMeta, 0, len(files))
	for index, meta := range results {
		if ok[index] {
			out = append(out, meta)
		}
	}

	// sibling order per directory (by appearance in out for that dir)
	assignSiblingOrder(out, func(m NoteMeta) string {
		return filepath.Dir(m.Path)
	}, func(m *NoteMeta, i int) { m.SiblingOrder = i })
	v.persistNoteMetaCacheSnapshot(out)
	return out, nil
}

func assignSiblingOrder[T any](list []T, key func(T) string, set func(*T, int)) {
	counts := map[string]int{}
	for i := range list {
		k := key(list[i])
		set(&list[i], counts[k])
		counts[k]++
	}
}

// ListFolders enumerates every non-root subdirectory under each top-level folder.
func (v *Vault) ListFolders() ([]FolderEntry, error) {
	v.mu.RLock()
	defer v.mu.RUnlock()
	out := []FolderEntry{}
	for _, folder := range AllFolders {
		folderRoot, err := v.folderRoot(folder)
		if err != nil {
			return nil, err
		}
		isPrimaryRoot := folder == FolderInbox && filepath.Clean(folderRoot) == filepath.Clean(v.root)
		err = filepath.WalkDir(folderRoot, func(path string, d os.DirEntry, err error) error {
			if err != nil {
				if isSkippableWalkErr(err) {
					return nil
				}
				return err
			}
			if !d.IsDir() {
				return nil
			}
			if path == folderRoot {
				return nil
			}
			if strings.HasPrefix(d.Name(), ".") {
				return filepath.SkipDir
			}
			if isPrimaryRoot {
				parent := filepath.Dir(path)
				if filepath.Clean(parent) == filepath.Clean(folderRoot) {
					if shouldHidePrimaryRootName(d.Name()) {
						return filepath.SkipDir
					}
				}
			}
			rel, err := filepath.Rel(folderRoot, path)
			if err != nil {
				return nil
			}
			out = append(out, FolderEntry{
				Folder:  folder,
				Subpath: filepath.ToSlash(rel),
			})
			// A `<Name>.base` database folder is listed (the renderer shows it as
			// a database) but its internals are not exposed as folders.
			if isFormDirName(d.Name()) {
				return filepath.SkipDir
			}
			return nil
		})
		if err != nil {
			return nil, err
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Folder != out[j].Folder {
			return out[i].Folder < out[j].Folder
		}
		return out[i].Subpath < out[j].Subpath
	})
	assignSiblingOrder(out, func(f FolderEntry) string {
		parent := filepath.Dir(f.Subpath)
		return string(f.Folder) + "/" + parent
	}, func(f *FolderEntry, i int) { f.SiblingOrder = i })
	return out, nil
}

// ListAssets walks the attachments directory.
func (v *Vault) ListAssets() ([]AssetMeta, error) {
	v.mu.RLock()
	defer v.mu.RUnlock()
	out := []AssetMeta{}
	var walk func(dir string) error
	walk = func(dir string) error {
		entries, err := os.ReadDir(dir)
		if err != nil {
			if isSkippableWalkErr(err) {
				return nil
			}
			return err
		}
		for index, entry := range entries {
			name := entry.Name()
			if strings.HasPrefix(name, ".") {
				continue
			}
			full := filepath.Join(dir, name)
			if entry.IsDir() {
				if filepath.Clean(dir) == filepath.Clean(v.root) && name == internalVaultDir {
					continue
				}
				if isFormDirName(name) {
					continue // database folder — its data.csv/schema.json aren't assets
				}
				if err := walk(full); err != nil {
					if isSkippableWalkErr(err) {
						continue
					}
					return err
				}
				continue
			}
			if !entry.Type().IsRegular() || strings.EqualFold(filepath.Ext(name), ".md") || isExcalidrawName(name) {
				continue
			}
			info, err := entry.Info()
			if err != nil {
				continue
			}
			rel, err := filepath.Rel(v.root, full)
			if err != nil {
				continue
			}
			out = append(out, AssetMeta{
				Path:         filepath.ToSlash(rel),
				Name:         name,
				Kind:         kindForExt(strings.ToLower(filepath.Ext(name))),
				SiblingOrder: index,
				Size:         info.Size(),
				UpdatedAt:    info.ModTime().UnixMilli(),
			})
		}
		return nil
	}
	if err := walk(v.root); err != nil {
		return nil, err
	}
	sort.SliceStable(out, func(i, j int) bool {
		return out[i].UpdatedAt > out[j].UpdatedAt
	})
	return out, nil
}

func (v *Vault) HasAssetsDir() bool {
	v.mu.RLock()
	defer v.mu.RUnlock()
	for _, dir := range append([]string{AssetsDir}, legacyAttachmentsDirs...) {
		info, err := os.Stat(filepath.Join(v.root, dir))
		if err == nil && info.IsDir() {
			return true
		}
	}
	return false
}

func kindForExt(ext string) string {
	switch ext {
	case ".apng", ".avif", ".gif", ".jpeg", ".jpg", ".png", ".svg", ".webp":
		return "image"
	case ".pdf":
		return "pdf"
	case ".aac", ".flac", ".m4a", ".mp3", ".ogg", ".wav":
		return "audio"
	case ".m4v", ".mov", ".mp4", ".ogv", ".webm":
		return "video"
	}
	return "file"
}

// --- Read / Write ---

// buildNoteMeta assembles NoteMeta for a note-like file. Excalidraw drawings
// store JSON, not Markdown, so their tags/wikilinks/excerpt are skipped — a hex
// color like "#1971c2" in the scene must not register as a #tag.
func buildNoteMeta(relPosix, title string, folder NoteFolder, info os.FileInfo, bodyStr string) NoteMeta {
	meta := NoteMeta{
		Path:      relPosix,
		Title:     title,
		Folder:    folder,
		CreatedAt: info.ModTime().UnixMilli(),
		UpdatedAt: info.ModTime().UnixMilli(),
		Size:      info.Size(),
		Tags:      []string{},
		Wikilinks: []string{},
	}
	if isExcalidrawName(relPosix) {
		return meta
	}
	meta.Tags = ExtractTags(bodyStr)
	meta.Wikilinks = ExtractWikilinks(bodyStr)
	meta.HasAttachments = BodyHasLocalAsset(bodyStr)
	meta.Excerpt = BuildExcerpt(bodyStr)
	return meta
}

func (v *Vault) readMeta(folder NoteFolder, abs string) (NoteMeta, error) {
	info, err := os.Stat(abs)
	if err != nil {
		return NoteMeta{}, err
	}
	rel, err := filepath.Rel(v.root, abs)
	if err != nil {
		return NoteMeta{}, err
	}
	relPosix := filepath.ToSlash(rel)
	statMtimeMs := mtimeMs(info)
	v.metaCacheMu.Lock()
	cached, ok := v.metaCache[abs]
	if ok &&
		sameMtimeMs(cached.mtimeMs, statMtimeMs) &&
		cached.size == info.Size() &&
		cached.meta.Path == relPosix &&
		cached.meta.Folder == folder {
		meta := cached.meta
		v.metaCacheMu.Unlock()
		return meta, nil
	}
	v.metaCacheMu.Unlock()

	body, err := os.ReadFile(abs)
	if err != nil {
		return NoteMeta{}, err
	}
	bodyStr := string(body)

	title := strings.TrimSuffix(filepath.Base(abs), filepath.Ext(abs))

	meta := buildNoteMeta(relPosix, title, folder, info, bodyStr)
	v.metaCacheMu.Lock()
	v.metaCache[abs] = noteMetaCacheEntry{
		mtimeMs: statMtimeMs,
		size:    info.Size(),
		meta:    meta,
	}
	v.metaCacheMu.Unlock()
	return meta, nil
}

func (v *Vault) ReadNote(rel string) (NoteContent, error) {
	v.mu.RLock()
	defer v.mu.RUnlock()
	abs, err := SafeJoin(v.root, rel)
	if err != nil {
		return NoteContent{}, err
	}
	info, err := os.Stat(abs)
	if err != nil {
		return NoteContent{}, err
	}
	body, err := os.ReadFile(abs)
	if err != nil {
		return NoteContent{}, err
	}
	folder, _ := v.folderOf(abs)
	bodyStr := string(body)
	rel = filepath.ToSlash(rel)
	title := strings.TrimSuffix(filepath.Base(abs), filepath.Ext(abs))
	meta := buildNoteMeta(rel, title, folder, info, bodyStr)
	return NoteContent{NoteMeta: meta, Body: bodyStr}, nil
}

func (v *Vault) WriteNote(rel, body string) (NoteMeta, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	abs, err := SafeJoin(v.root, rel)
	if err != nil {
		return NoteMeta{}, err
	}
	if err := os.MkdirAll(filepath.Dir(abs), v.dirMode); err != nil {
		return NoteMeta{}, err
	}
	if err := os.WriteFile(abs, []byte(body), v.fileMode); err != nil {
		return NoteMeta{}, err
	}
	v.invalidateTextSearchCache()
	folder, _ := v.folderOf(abs)
	return v.readMeta(folder, abs)
}

func newCommentID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err == nil {
		return hex.EncodeToString(b[:])
	}
	return fmt.Sprintf("comment-%d", time.Now().UnixNano())
}

func normalizeComment(input NoteComment, notePath string) (NoteComment, bool) {
	body := strings.TrimSpace(input.Body)
	if body == "" {
		return NoteComment{}, false
	}
	start := input.AnchorStart
	if start < 0 {
		start = 0
	}
	end := input.AnchorEnd
	if end < 0 {
		end = start
	}
	if end < start {
		start, end = end, start
	}
	anchorText := strings.Join(strings.Fields(input.AnchorText), " ")
	if len(anchorText) > 500 {
		anchorText = anchorText[:500]
	}
	now := time.Now().UnixMilli()
	createdAt := input.CreatedAt
	if createdAt <= 0 {
		createdAt = now
	}
	updatedAt := input.UpdatedAt
	if updatedAt <= 0 {
		updatedAt = now
	}
	id := strings.TrimSpace(input.ID)
	if id == "" {
		id = newCommentID()
	}
	return NoteComment{
		ID:          id,
		NotePath:    notePath,
		AnchorStart: start,
		AnchorEnd:   end,
		AnchorText:  anchorText,
		Body:        body,
		CreatedAt:   createdAt,
		UpdatedAt:   updatedAt,
		ResolvedAt:  input.ResolvedAt,
	}, true
}

func normalizeComments(inputs []NoteComment, notePath string) []NoteComment {
	out := make([]NoteComment, 0, len(inputs))
	seen := map[string]struct{}{}
	for _, input := range inputs {
		comment, ok := normalizeComment(input, notePath)
		if !ok {
			continue
		}
		if _, exists := seen[comment.ID]; exists {
			continue
		}
		seen[comment.ID] = struct{}{}
		out = append(out, comment)
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].CreatedAt == out[j].CreatedAt {
			return out[i].ID < out[j].ID
		}
		return out[i].CreatedAt < out[j].CreatedAt
	})
	return out
}

func (v *Vault) readNoteCommentsLocked(rel string) ([]NoteComment, error) {
	notePath := filepath.ToSlash(rel)
	abs, err := v.commentsPath(notePath)
	if err != nil {
		return nil, err
	}
	raw, err := os.ReadFile(abs)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return []NoteComment{}, nil
		}
		return nil, err
	}
	var envelope struct {
		Comments []NoteComment `json:"comments"`
	}
	if err := json.Unmarshal(raw, &envelope); err == nil && envelope.Comments != nil {
		return normalizeComments(envelope.Comments, notePath), nil
	}
	var comments []NoteComment
	if err := json.Unmarshal(raw, &comments); err != nil {
		return []NoteComment{}, nil
	}
	return normalizeComments(comments, notePath), nil
}

func (v *Vault) ReadNoteComments(rel string) ([]NoteComment, error) {
	v.mu.RLock()
	defer v.mu.RUnlock()
	return v.readNoteCommentsLocked(rel)
}

func (v *Vault) writeNoteCommentsLocked(rel string, comments []NoteComment) ([]NoteComment, error) {
	notePath := filepath.ToSlash(rel)
	normalized := normalizeComments(comments, notePath)
	abs, err := v.commentsPath(notePath)
	if err != nil {
		return nil, err
	}
	if len(normalized) == 0 {
		if err := os.Remove(abs); err != nil && !errors.Is(err, os.ErrNotExist) {
			return nil, err
		}
		return []NoteComment{}, nil
	}
	if err := os.MkdirAll(filepath.Dir(abs), v.dirMode); err != nil {
		return nil, err
	}
	data, err := json.MarshalIndent(struct {
		Version  int           `json:"version"`
		Comments []NoteComment `json:"comments"`
	}{Version: 1, Comments: normalized}, "", "  ")
	if err != nil {
		return nil, err
	}
	if err := os.WriteFile(abs, data, v.fileMode); err != nil {
		return nil, err
	}
	return normalized, nil
}

func (v *Vault) WriteNoteComments(rel string, comments []NoteComment) ([]NoteComment, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	return v.writeNoteCommentsLocked(rel, comments)
}

func (v *Vault) removeNoteCommentsLocked(rel string) error {
	abs, err := v.commentsPath(rel)
	if err != nil {
		return err
	}
	if err := os.Remove(abs); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

func (v *Vault) moveNoteCommentsLocked(oldRel, nextRel string) error {
	oldAbs, err := v.commentsPath(oldRel)
	if err != nil {
		return err
	}
	nextAbs, err := v.commentsPath(nextRel)
	if err != nil {
		return err
	}
	if oldAbs == nextAbs {
		return nil
	}
	if _, err := os.Stat(oldAbs); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	if err := os.MkdirAll(filepath.Dir(nextAbs), v.dirMode); err != nil {
		return err
	}
	if _, err := os.Stat(nextAbs); err == nil {
		existing, err := v.readNoteCommentsLocked(nextRel)
		if err != nil {
			return err
		}
		moving, err := v.readNoteCommentsLocked(oldRel)
		if err != nil {
			return err
		}
		if _, err := v.writeNoteCommentsLocked(nextRel, append(existing, moving...)); err != nil {
			return err
		}
		return os.Remove(oldAbs)
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return os.Rename(oldAbs, nextAbs)
}

func (v *Vault) copyNoteCommentsLocked(sourceRel, nextRel string) error {
	source, err := v.readNoteCommentsLocked(sourceRel)
	if err != nil {
		return err
	}
	if len(source) == 0 {
		return nil
	}
	now := time.Now().UnixMilli()
	copyComments := make([]NoteComment, 0, len(source))
	for _, comment := range source {
		comment.ID = newCommentID()
		comment.NotePath = filepath.ToSlash(nextRel)
		comment.CreatedAt = now
		comment.UpdatedAt = now
		copyComments = append(copyComments, comment)
	}
	_, err = v.writeNoteCommentsLocked(nextRel, copyComments)
	return err
}

func (v *Vault) folderOf(abs string) (NoteFolder, bool) {
	rel, err := filepath.Rel(v.root, abs)
	if err != nil {
		return "", false
	}
	return FolderForRelativePath(rel)
}

// --- Create / Rename / Delete ---

func (v *Vault) CreateNote(folder NoteFolder, title, subpath string) (NoteMeta, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	if !IsValidFolder(folder) {
		return NoteMeta{}, fmt.Errorf("invalid folder: %s", folder)
	}
	if title == "" {
		title = defaultTitle()
	}
	title = sanitizeFileStem(title)
	dir, err := v.folderRoot(folder)
	if err != nil {
		return NoteMeta{}, err
	}
	if subpath != "" {
		sub, err := SafeJoin(dir, subpath)
		if err != nil {
			return NoteMeta{}, err
		}
		dir = sub
	}
	if err := os.MkdirAll(dir, v.dirMode); err != nil {
		return NoteMeta{}, err
	}
	abs := uniquePath(dir, title, ".md")
	if err := os.WriteFile(abs, []byte(""), v.fileMode); err != nil {
		return NoteMeta{}, err
	}
	v.invalidateTextSearchCache()
	return v.readMeta(folder, abs)
}

// CreateExcalidraw writes a new empty `.excalidraw` drawing under folder/subpath
// and returns its meta. Mirrors CreateNote but seeds an empty Excalidraw scene.
func (v *Vault) CreateExcalidraw(folder NoteFolder, title, subpath string) (NoteMeta, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	if !IsValidFolder(folder) {
		return NoteMeta{}, fmt.Errorf("invalid folder: %s", folder)
	}
	if title == "" {
		title = defaultTitle()
	}
	title = sanitizeFileStem(title)
	dir, err := v.folderRoot(folder)
	if err != nil {
		return NoteMeta{}, err
	}
	if subpath != "" {
		sub, err := SafeJoin(dir, subpath)
		if err != nil {
			return NoteMeta{}, err
		}
		dir = sub
	}
	if err := os.MkdirAll(dir, v.dirMode); err != nil {
		return NoteMeta{}, err
	}
	abs := uniquePath(dir, title, excalidrawExt)
	if err := os.WriteFile(abs, []byte(emptyExcalidrawJSON), v.fileMode); err != nil {
		return NoteMeta{}, err
	}
	v.invalidateTextSearchCache()
	return v.readMeta(folder, abs)
}

func (v *Vault) RenameNote(rel, nextTitle string) (NoteMeta, error) {
	// Snapshot the vault before the rename (ListNotes takes its own read lock)
	// so inbound [[wikilinks]] still resolve to this note under its current name.
	notesBefore, _ := v.ListNotes()
	meta, err := v.renameNoteFile(rel, nextTitle)
	if err != nil {
		return NoteMeta{}, err
	}
	if meta.Path != rel {
		// ReadNote / WriteNote take their own locks, so this runs after the
		// rename's write lock has been released.
		v.rewriteInboundWikilinks(notesBefore, rel, meta.Title)
	}
	return meta, nil
}

func (v *Vault) renameNoteFile(rel, nextTitle string) (NoteMeta, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	abs, err := SafeJoin(v.root, rel)
	if err != nil {
		return NoteMeta{}, err
	}
	nextTitle = sanitizeFileStem(nextTitle)
	if nextTitle == "" {
		return NoteMeta{}, errors.New("empty title")
	}
	dir := filepath.Dir(abs)
	newAbs := uniquePath(dir, nextTitle, noteExt(abs))
	if err := os.Rename(abs, newAbs); err != nil {
		return NoteMeta{}, err
	}
	v.invalidateTextSearchCache()
	folder, _ := v.folderOf(newAbs)
	meta, err := v.readMeta(folder, newAbs)
	if err != nil {
		return NoteMeta{}, err
	}
	if err := v.moveNoteCommentsLocked(rel, meta.Path); err != nil {
		return NoteMeta{}, err
	}
	return meta, nil
}

// rewriteInboundWikilinks rewrites every note that linked to the renamed note's
// old name so it points to the new title. Only notes that actually link to it
// are read and rewritten.
func (v *Vault) rewriteInboundWikilinks(notesBefore []NoteMeta, oldPath, newTitle string) {
	for _, n := range notesBefore {
		if n.Path == oldPath || n.Folder == FolderTrash {
			continue
		}
		linksToIt := false
		for _, t := range n.Wikilinks {
			if r, ok := wikiResolveTarget(notesBefore, t); ok && r.Path == oldPath {
				linksToIt = true
				break
			}
		}
		if !linksToIt {
			continue
		}
		content, err := v.ReadNote(n.Path)
		if err != nil {
			continue
		}
		body, changed := rewriteWikilinksForRename(content.Body, notesBefore, oldPath, newTitle)
		if changed > 0 {
			_, _ = v.WriteNote(n.Path, body)
		}
	}
}

func (v *Vault) DeleteNote(rel string) error {
	v.mu.Lock()
	defer v.mu.Unlock()
	abs, err := SafeJoin(v.root, rel)
	if err != nil {
		return err
	}
	if err := os.Remove(abs); err != nil {
		return err
	}
	v.invalidateTextSearchCache()
	return v.removeNoteCommentsLocked(rel)
}

// --- Trash / Restore / Archive / Unarchive / Duplicate / Move ---

func (v *Vault) MoveToTrash(rel string) (NoteMeta, error) {
	return v.moveBetweenFolders(rel, FolderTrash)
}
func (v *Vault) RestoreFromTrash(rel string) (NoteMeta, error) {
	return v.moveBetweenFolders(rel, FolderInbox)
}
func (v *Vault) ArchiveNote(rel string) (NoteMeta, error) {
	return v.moveBetweenFolders(rel, FolderArchive)
}
func (v *Vault) UnarchiveNote(rel string) (NoteMeta, error) {
	return v.moveBetweenFolders(rel, FolderInbox)
}

// folderSubpathOf returns the note's directory relative to its top-level
// folder root ("" when it sits at the folder root). Carried along on
// archive/trash moves so the reverse move restores the subfolder.
// Mirrors folderSubpathOf in apps/desktop/src/main/vault.ts.
func (v *Vault) folderSubpathOf(abs string) string {
	folder, ok := v.folderOf(abs)
	if !ok {
		return ""
	}
	sourceRoot, err := v.folderRoot(folder)
	if err != nil {
		return ""
	}
	relDir, err := filepath.Rel(sourceRoot, filepath.Dir(abs))
	if err != nil || relDir == "." || strings.HasPrefix(relDir, "..") || filepath.IsAbs(relDir) {
		return ""
	}
	return relDir
}

func (v *Vault) moveBetweenFolders(rel string, target NoteFolder) (NoteMeta, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	abs, err := SafeJoin(v.root, rel)
	if err != nil {
		return NoteMeta{}, err
	}
	title := strings.TrimSuffix(filepath.Base(abs), filepath.Ext(abs))
	// Mirror the source subfolder in the destination so a round-trip
	// (archive → unarchive, trash → restore) puts the note back where
	// it came from instead of at the folder's top level.
	subpath := v.folderSubpathOf(abs)
	targetRoot, err := v.folderRoot(target)
	if err != nil {
		return NoteMeta{}, err
	}
	destDir := targetRoot
	if subpath != "" {
		destDir, err = SafeJoin(targetRoot, subpath)
		if err != nil {
			return NoteMeta{}, err
		}
	}
	if err := os.MkdirAll(destDir, v.dirMode); err != nil {
		return NoteMeta{}, err
	}
	newAbs := uniquePath(destDir, title, noteExt(abs))
	if err := os.Rename(abs, newAbs); err != nil {
		return NoteMeta{}, err
	}
	v.invalidateTextSearchCache()
	meta, err := v.readMeta(target, newAbs)
	if err != nil {
		return NoteMeta{}, err
	}
	if err := v.moveNoteCommentsLocked(rel, meta.Path); err != nil {
		return NoteMeta{}, err
	}
	return meta, nil
}

func (v *Vault) EmptyTrash() error {
	v.mu.Lock()
	defer v.mu.Unlock()
	trashDir := filepath.Join(v.root, string(FolderTrash))
	entries, err := os.ReadDir(trashDir)
	if err != nil {
		return nil
	}
	for _, e := range entries {
		_ = v.removeNoteCommentsLocked(filepath.ToSlash(filepath.Join(string(FolderTrash), e.Name())))
		_ = os.RemoveAll(filepath.Join(trashDir, e.Name()))
	}
	v.invalidateTextSearchCache()
	return nil
}

func (v *Vault) DuplicateNote(rel string) (NoteMeta, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	abs, err := SafeJoin(v.root, rel)
	if err != nil {
		return NoteMeta{}, err
	}
	folder, _ := v.folderOf(abs)
	title := strings.TrimSuffix(filepath.Base(abs), filepath.Ext(abs)) + " copy"
	newAbs := uniquePath(filepath.Dir(abs), sanitizeFileStem(title), noteExt(abs))
	if err := copyFile(abs, newAbs, v.fileMode); err != nil {
		return NoteMeta{}, err
	}
	v.invalidateTextSearchCache()
	meta, err := v.readMeta(folder, newAbs)
	if err != nil {
		return NoteMeta{}, err
	}
	if err := v.copyNoteCommentsLocked(rel, meta.Path); err != nil {
		return NoteMeta{}, err
	}
	return meta, nil
}

func (v *Vault) MoveNote(rel string, target NoteFolder, targetSubpath string) (NoteMeta, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	abs, err := SafeJoin(v.root, rel)
	if err != nil {
		return NoteMeta{}, err
	}
	if !IsValidFolder(target) {
		return NoteMeta{}, fmt.Errorf("invalid folder: %s", target)
	}
	destDir, err := v.folderRoot(target)
	if err != nil {
		return NoteMeta{}, err
	}
	if targetSubpath != "" {
		sub, err := SafeJoin(destDir, targetSubpath)
		if err != nil {
			return NoteMeta{}, err
		}
		destDir = sub
	}
	if err := os.MkdirAll(destDir, v.dirMode); err != nil {
		return NoteMeta{}, err
	}
	title := strings.TrimSuffix(filepath.Base(abs), filepath.Ext(abs))
	newAbs := uniquePath(destDir, title, noteExt(abs))
	if err := os.Rename(abs, newAbs); err != nil {
		return NoteMeta{}, err
	}
	v.invalidateTextSearchCache()
	meta, err := v.readMeta(target, newAbs)
	if err != nil {
		return NoteMeta{}, err
	}
	if err := v.moveNoteCommentsLocked(rel, meta.Path); err != nil {
		return NoteMeta{}, err
	}
	return meta, nil
}

// --- Folders ---

func (v *Vault) CreateFolder(folder NoteFolder, subpath string) error {
	v.mu.Lock()
	defer v.mu.Unlock()
	if !IsValidFolder(folder) {
		return fmt.Errorf("invalid folder: %s", folder)
	}
	base, err := v.folderRoot(folder)
	if err != nil {
		return err
	}
	abs, err := SafeJoin(base, subpath)
	if err != nil {
		return err
	}
	return os.MkdirAll(abs, v.dirMode)
}

func (v *Vault) RenameFolder(folder NoteFolder, oldSub, newSub string) (string, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	base, err := v.folderRoot(folder)
	if err != nil {
		return "", err
	}
	oldAbs, err := SafeJoin(base, oldSub)
	if err != nil {
		return "", err
	}
	newAbs, err := SafeJoin(base, newSub)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(newAbs), v.dirMode); err != nil {
		return "", err
	}
	if err := os.Rename(oldAbs, newAbs); err != nil {
		return "", err
	}
	v.invalidateTextSearchCache()
	settings, err := v.GetSettings()
	if err != nil {
		return "", err
	}
	_, err = v.SetSettings(VaultSettings{
		PrimaryNotesLocation: settings.PrimaryNotesLocation,
		DailyNotes:           settings.DailyNotes,
		WeeklyNotes:          settings.WeeklyNotes,
		MonthlyNotes:         settings.MonthlyNotes,
		FolderIcons:          rewriteFolderIconsForRename(settings.FolderIcons, folder, oldSub, newSub),
		FolderColors:         rewriteFolderColorsForRename(settings.FolderColors, folder, oldSub, newSub),
		// Favorites are carried through verbatim; the client rewrites stale
		// favorite keys after the rename and re-persists them.
		Favorites: settings.Favorites,
	})
	if err != nil {
		return "", err
	}
	rel, _ := filepath.Rel(base, newAbs)
	return filepath.ToSlash(rel), nil
}

func (v *Vault) DeleteFolder(folder NoteFolder, subpath string) error {
	v.mu.Lock()
	defer v.mu.Unlock()
	base, err := v.folderRoot(folder)
	if err != nil {
		return err
	}
	abs, err := SafeJoin(base, subpath)
	if err != nil {
		return err
	}
	if abs == base {
		return errors.New("refusing to delete top-level folder")
	}
	if err := os.RemoveAll(abs); err != nil {
		return err
	}
	v.invalidateTextSearchCache()
	settings, err := v.GetSettings()
	if err != nil {
		return err
	}
	_, err = v.SetSettings(VaultSettings{
		PrimaryNotesLocation: settings.PrimaryNotesLocation,
		DailyNotes:           settings.DailyNotes,
		WeeklyNotes:          settings.WeeklyNotes,
		MonthlyNotes:         settings.MonthlyNotes,
		FolderIcons:          removeFolderIcons(settings.FolderIcons, folder, subpath),
		FolderColors:         removeFolderColors(settings.FolderColors, folder, subpath),
		// Favorites are carried through verbatim; the client prunes the deleted
		// folder's favorites and re-persists them.
		Favorites: settings.Favorites,
	})
	return err
}

func (v *Vault) DuplicateFolder(folder NoteFolder, subpath string) (string, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	base, err := v.folderRoot(folder)
	if err != nil {
		return "", err
	}
	src, err := SafeJoin(base, subpath)
	if err != nil {
		return "", err
	}
	parent := filepath.Dir(src)
	baseName := filepath.Base(src) + " copy"
	dst := uniqueDir(parent, baseName)
	if err := copyDir(src, dst, v.fileMode, v.dirMode); err != nil {
		return "", err
	}
	v.invalidateTextSearchCache()
	settings, err := v.GetSettings()
	if err != nil {
		return "", err
	}
	rel, _ := filepath.Rel(base, dst)
	relPath := filepath.ToSlash(rel)
	_, err = v.SetSettings(VaultSettings{
		PrimaryNotesLocation: settings.PrimaryNotesLocation,
		DailyNotes:           settings.DailyNotes,
		WeeklyNotes:          settings.WeeklyNotes,
		MonthlyNotes:         settings.MonthlyNotes,
		FolderIcons:          duplicateFolderIcons(settings.FolderIcons, folder, subpath, relPath),
		FolderColors:         duplicateFolderColors(settings.FolderColors, folder, subpath, relPath),
		// A duplicated folder isn't auto-favorited; carry existing favorites through.
		Favorites: settings.Favorites,
	})
	if err != nil {
		return "", err
	}
	return relPath, nil
}

// --- Tasks ---

func (v *Vault) ScanTasks() ([]Task, error) {
	v.mu.RLock()
	defer v.mu.RUnlock()
	all := []Task{}
	for _, folder := range []NoteFolder{FolderInbox, FolderQuick, FolderArchive} {
		folderRoot, err := v.folderRoot(folder)
		if err != nil {
			return nil, err
		}
		isPrimaryRoot := folder == FolderInbox && filepath.Clean(folderRoot) == filepath.Clean(v.root)
		_ = filepath.WalkDir(folderRoot, func(path string, d os.DirEntry, err error) error {
			if err != nil {
				return nil
			}
			if d.IsDir() {
				if strings.HasPrefix(d.Name(), ".") && path != folderRoot {
					return filepath.SkipDir
				}
				if isFormDirName(d.Name()) {
					return filepath.SkipDir // database folder — not loose notes
				}
				if isPrimaryRoot && path != folderRoot {
					parent := filepath.Dir(path)
					if filepath.Clean(parent) == filepath.Clean(folderRoot) {
						if shouldHidePrimaryRootName(d.Name()) {
							return filepath.SkipDir
						}
					}
				}
				return nil
			}
			if isPrimaryRoot {
				parent := filepath.Dir(path)
				if filepath.Clean(parent) == filepath.Clean(folderRoot) {
					if shouldHidePrimaryRootName(d.Name()) {
						return nil
					}
				}
			}
			if !strings.EqualFold(filepath.Ext(d.Name()), ".md") {
				return nil
			}
			body, err := os.ReadFile(path)
			if err != nil {
				return nil
			}
			rel, _ := filepath.Rel(v.root, path)
			relPosix := filepath.ToSlash(rel)
			title := strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
			tasks := ParseTasks(relPosix, title, folder, string(body))
			all = append(all, tasks...)
			return nil
		})
	}
	return all, nil
}

func (v *Vault) ScanTasksForPath(rel string) ([]Task, error) {
	v.mu.RLock()
	defer v.mu.RUnlock()
	abs, err := SafeJoin(v.root, rel)
	if err != nil {
		return nil, err
	}
	body, err := os.ReadFile(abs)
	if err != nil {
		return nil, err
	}
	folder, _ := v.folderOf(abs)
	title := strings.TrimSuffix(filepath.Base(abs), filepath.Ext(abs))
	return ParseTasks(filepath.ToSlash(rel), title, folder, string(body)), nil
}

// --- Text search ---

func (v *Vault) SearchCapabilities() TextSearchCapabilities {
	return TextSearchCapabilities{Ripgrep: false, Fzf: false}
}

func (v *Vault) textSearchFilesLocked() (uint64, []textSearchFile, error) {
	h := fnv.New64a()
	files := []textSearchFile{}
	for _, folder := range []NoteFolder{FolderInbox, FolderQuick, FolderArchive} {
		folderRoot, err := v.folderRoot(folder)
		if err != nil {
			return 0, nil, err
		}
		cleanFolderRoot := filepath.Clean(folderRoot)
		isPrimaryRoot := folder == FolderInbox && cleanFolderRoot == filepath.Clean(v.root)
		fmt.Fprintf(h, "folder\x00%s\x00%s\x00%t\x00", folder, filepath.ToSlash(cleanFolderRoot), isPrimaryRoot)
		_ = filepath.WalkDir(folderRoot, func(path string, d os.DirEntry, err error) error {
			if err != nil {
				return nil
			}
			if d.IsDir() {
				if strings.HasPrefix(d.Name(), ".") && path != folderRoot {
					return filepath.SkipDir
				}
				if isPrimaryRoot && path != folderRoot {
					parent := filepath.Dir(path)
					if filepath.Clean(parent) == cleanFolderRoot {
						if shouldHidePrimaryRootName(d.Name()) {
							return filepath.SkipDir
						}
					}
				}
				return nil
			}
			if isPrimaryRoot {
				parent := filepath.Dir(path)
				if filepath.Clean(parent) == cleanFolderRoot {
					if shouldHidePrimaryRootName(d.Name()) {
						return nil
					}
				}
			}
			if !strings.EqualFold(filepath.Ext(d.Name()), ".md") {
				return nil
			}
			info, err := d.Info()
			if err != nil {
				return nil
			}
			rel, _ := filepath.Rel(v.root, path)
			relPosix := filepath.ToSlash(rel)
			title := strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
			modNano := info.ModTime().UnixNano()
			size := info.Size()
			fmt.Fprintf(h, "file\x00%s\x00%s\x00%d\x00%d\x00", folder, relPosix, size, modNano)
			files = append(files, textSearchFile{
				abs:      path,
				relPosix: relPosix,
				title:    title,
				folder:   folder,
			})
			return nil
		})
	}
	return h.Sum64(), files, nil
}

func (v *Vault) textSearchCandidatesLocked() ([]textSearchCandidate, error) {
	signature, files, err := v.textSearchFilesLocked()
	if err != nil {
		return nil, err
	}

	v.searchCacheMu.Lock()
	if v.searchCache != nil && v.searchCache.signature == signature {
		candidates := v.searchCache.candidates
		v.searchCacheMu.Unlock()
		return candidates, nil
	}
	v.searchCacheMu.Unlock()

	groups := make([][]textSearchCandidate, len(files))
	limit := noteMetaReadLimit
	if len(files) < limit {
		limit = len(files)
	}
	sem := make(chan struct{}, limit)
	var wg sync.WaitGroup
	for index, file := range files {
		wg.Add(1)
		go func(index int, file textSearchFile) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			body, err := os.ReadFile(file.abs)
			if err != nil {
				return
			}
			lines := strings.Split(string(body), "\n")
			offset := 0
			candidates := make([]textSearchCandidate, 0, len(lines))
			for i, line := range lines {
				collapsed := wsCollapseRe.ReplaceAllString(line, " ")
				collapsed = strings.TrimSpace(collapsed)
				if len(collapsed) > 220 {
					collapsed = collapsed[:220]
				}
				candidates = append(candidates, textSearchCandidate{
					match: TextSearchMatch{
						Path:       file.relPosix,
						Title:      file.title,
						Folder:     file.folder,
						LineNumber: i + 1,
						Offset:     offset,
						LineText:   collapsed,
					},
					lineLower: strings.ToLower(line),
				})
				offset += len(line) + 1
			}
			groups[index] = candidates
		}(index, file)
	}
	wg.Wait()

	candidates := []textSearchCandidate{}
	for _, group := range groups {
		candidates = append(candidates, group...)
	}

	v.searchCacheMu.Lock()
	if v.searchCache != nil && v.searchCache.signature == signature {
		candidates = v.searchCache.candidates
	} else {
		v.searchCache = &textSearchCache{
			signature:  signature,
			candidates: candidates,
		}
	}
	v.searchCacheMu.Unlock()

	return candidates, nil
}

func (v *Vault) SearchText(query string) ([]TextSearchMatch, error) {
	v.mu.RLock()
	defer v.mu.RUnlock()
	query = strings.TrimSpace(query)
	if query == "" {
		return []TextSearchMatch{}, nil
	}
	needle := strings.ToLower(query)
	candidates, err := v.textSearchCandidatesLocked()
	if err != nil {
		return nil, err
	}
	out := []TextSearchMatch{}
	for _, candidate := range candidates {
		if !strings.Contains(candidate.lineLower, needle) {
			continue
		}
		out = append(out, candidate.match)
		if len(out) >= 200 {
			break
		}
	}
	return out, nil
}

// --- Assets upload + raw serving ---

// ImportAsset writes raw bytes into the vault root and returns the
// markdown snippet to embed relative to the source note.
func (v *Vault) ImportAsset(notePath, filename string, body io.Reader) (ImportedAsset, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	if err := os.MkdirAll(v.root, v.dirMode); err != nil {
		return ImportedAsset{}, err
	}
	safeName := sanitizeFileName(filename)
	if safeName == "" {
		safeName = "file"
	}
	ext := filepath.Ext(safeName)
	stem := strings.TrimSuffix(safeName, ext)
	abs := uniquePath(v.root, stem, ext)
	f, err := os.OpenFile(abs, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, v.fileMode)
	if err != nil {
		return ImportedAsset{}, err
	}
	cleanupPartial := func() {
		_ = f.Close()
		_ = os.Remove(abs)
	}
	limited := io.LimitReader(body, v.maxAssetBytes+1)
	written, err := io.Copy(f, limited)
	if err != nil {
		cleanupPartial()
		return ImportedAsset{}, err
	}
	if written > v.maxAssetBytes {
		cleanupPartial()
		return ImportedAsset{}, ErrAssetTooLarge
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(abs)
		return ImportedAsset{}, err
	}
	rel := filepath.ToSlash(filepath.Base(abs))
	noteDir := filepath.Dir(filepath.FromSlash(notePath))
	if noteDir == "." {
		noteDir = ""
	}
	markdownPath := rel
	if noteDir != "" {
		if relative, err := filepath.Rel(noteDir, rel); err == nil {
			markdownPath = filepath.ToSlash(relative)
		}
	}
	kind := kindForExt(strings.ToLower(filepath.Ext(abs)))
	markdown := makeAssetMarkdown(markdownPath, kind, filepath.Base(abs))
	return ImportedAsset{
		Name:     filepath.Base(abs),
		Path:     rel,
		Markdown: markdown,
		Kind:     kind,
	}, nil
}

func (v *Vault) AssetAbsPath(rel string) (string, error) {
	v.mu.RLock()
	defer v.mu.RUnlock()
	return SafeJoin(v.root, rel)
}

// RenameAsset renames an asset file in place (same directory), mirroring the
// desktop renameAsset. It refuses internal files and markdown notes, and
// handles a case-only rename on case-insensitive filesystems. (#379)
func (v *Vault) RenameAsset(rel, nextName string) (AssetMeta, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	srcAbs, err := v.assertAssetFile(rel)
	if err != nil {
		return AssetMeta{}, err
	}
	cleanName, err := cleanAssetFilename(nextName)
	if err != nil {
		return AssetMeta{}, err
	}
	destAbs := filepath.Join(filepath.Dir(srcAbs), cleanName)
	if destAbs != srcAbs {
		if dstInfo, statErr := os.Stat(destAbs); statErr == nil {
			// Something is already at the destination. Allow it only when it is
			// literally the same file (case-only rename on a case-insensitive
			// filesystem), routing through a temp name; otherwise it collides.
			srcInfo, srcErr := os.Stat(srcAbs)
			if srcErr != nil {
				return AssetMeta{}, srcErr
			}
			if !os.SameFile(dstInfo, srcInfo) {
				return AssetMeta{}, fmt.Errorf("an asset named %q already exists in this folder", cleanName)
			}
			tmp := srcAbs + ".zenrename.tmp"
			if err := os.Rename(srcAbs, tmp); err != nil {
				return AssetMeta{}, err
			}
			if err := os.Rename(tmp, destAbs); err != nil {
				return AssetMeta{}, err
			}
		} else if !errors.Is(statErr, os.ErrNotExist) {
			return AssetMeta{}, statErr
		} else if err := os.Rename(srcAbs, destAbs); err != nil {
			return AssetMeta{}, err
		}
	}
	return v.assetMetaForAbs(destAbs)
}

// MoveAsset moves an asset file into targetDir (vault-relative; empty means the
// unified assets/ folder), mirroring the desktop moveAsset. The filename is made
// unique in the destination. (#379)
func (v *Vault) MoveAsset(rel, targetDir string) (AssetMeta, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	srcAbs, err := v.assertAssetFile(rel)
	if err != nil {
		return AssetMeta{}, err
	}
	destDir, err := v.cleanAssetTargetDir(targetDir)
	if err != nil {
		return AssetMeta{}, err
	}
	if err := os.MkdirAll(destDir, v.dirMode); err != nil {
		return AssetMeta{}, err
	}
	if filepath.Clean(destDir) == filepath.Clean(filepath.Dir(srcAbs)) {
		return v.assetMetaForAbs(srcAbs)
	}
	name := filepath.Base(srcAbs)
	ext := filepath.Ext(name)
	stem := strings.TrimSuffix(name, ext)
	destAbs := uniquePath(destDir, stem, ext)
	if err := os.Rename(srcAbs, destAbs); err != nil {
		return AssetMeta{}, err
	}
	return v.assetMetaForAbs(destAbs)
}

// assertAssetFile validates rel points at an existing, editable asset file and
// returns its safe absolute path. Assumes the caller holds v.mu.
func (v *Vault) assertAssetFile(rel string) (string, error) {
	trimmed := strings.Trim(strings.TrimSpace(filepath.ToSlash(rel)), "/")
	if trimmed == "" {
		return "", errors.New("asset path is required")
	}
	for _, part := range strings.Split(trimmed, "/") {
		if part == internalVaultDir {
			return "", errors.New("cannot modify internal ZenNotes files")
		}
	}
	if strings.EqualFold(filepath.Ext(trimmed), ".md") {
		return "", errors.New("use note actions to modify markdown notes")
	}
	abs, err := SafeJoin(v.root, trimmed)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(abs)
	if err != nil {
		return "", err
	}
	if info.IsDir() {
		return "", errors.New("asset path is not a file")
	}
	return abs, nil
}

// cleanAssetTargetDir resolves a vault-relative destination directory for a
// move. Empty resolves to the unified assets/ folder. Assumes caller holds v.mu.
func (v *Vault) cleanAssetTargetDir(targetDir string) (string, error) {
	normalized := strings.Trim(strings.TrimSpace(filepath.ToSlash(targetDir)), "/")
	if normalized == "" {
		return SafeJoin(v.root, AssetsDir)
	}
	for _, part := range strings.Split(normalized, "/") {
		if part == internalVaultDir {
			return "", errors.New("cannot move assets into internal ZenNotes files")
		}
	}
	return SafeJoin(v.root, normalized)
}

func (v *Vault) assetMetaForAbs(abs string) (AssetMeta, error) {
	info, err := os.Stat(abs)
	if err != nil {
		return AssetMeta{}, err
	}
	rel, err := filepath.Rel(v.root, abs)
	if err != nil {
		return AssetMeta{}, err
	}
	name := filepath.Base(abs)
	return AssetMeta{
		Path:         filepath.ToSlash(rel),
		Name:         name,
		Kind:         kindForExt(strings.ToLower(filepath.Ext(name))),
		SiblingOrder: 0,
		Size:         info.Size(),
		UpdatedAt:    info.ModTime().UnixMilli(),
	}, nil
}

func cleanAssetFilename(name string) (string, error) {
	raw := strings.TrimSpace(name)
	if strings.ContainsAny(raw, "/\\") {
		return "", errors.New("use only a file name")
	}
	trimmed := filepath.Base(raw)
	if trimmed == "" || trimmed == "." || trimmed == ".." {
		return "", errors.New("asset name is required")
	}
	if strings.EqualFold(filepath.Ext(trimmed), ".md") {
		return "", errors.New("use note actions for markdown notes")
	}
	return trimmed, nil
}

func makeAssetMarkdown(relPath, kind, name string) string {
	dest := "<" + strings.ReplaceAll(relPath, ">", "%3E") + ">"
	switch kind {
	case "image":
		return "![" + name + "](" + dest + ")"
	default:
		return "[" + name + "](" + dest + ")"
	}
}

// --- Misc helpers ---

var forbiddenFilenameChars = []string{"/", "\\", ":", "*", "?", "\"", "<", ">", "|"}

func sanitizeFileStem(title string) string {
	t := title
	for _, c := range forbiddenFilenameChars {
		t = strings.ReplaceAll(t, c, "")
	}
	t = strings.TrimSpace(t)
	if t == "" {
		t = defaultTitle()
	}
	return t
}

func sanitizeFileName(name string) string {
	ext := filepath.Ext(name)
	stem := strings.TrimSuffix(name, ext)
	return sanitizeFileStem(stem) + ext
}

func defaultTitle() string {
	return "Untitled-" + time.Now().Format("2006-01-02-150405")
}

func uniquePath(dir, stem, ext string) string {
	candidate := filepath.Join(dir, stem+ext)
	if _, err := os.Stat(candidate); errors.Is(err, os.ErrNotExist) {
		return candidate
	}
	for i := 2; ; i++ {
		candidate = filepath.Join(dir, fmt.Sprintf("%s %d%s", stem, i, ext))
		if _, err := os.Stat(candidate); errors.Is(err, os.ErrNotExist) {
			return candidate
		}
	}
}

func uniqueDir(parent, base string) string {
	candidate := filepath.Join(parent, base)
	if _, err := os.Stat(candidate); errors.Is(err, os.ErrNotExist) {
		return candidate
	}
	for i := 2; ; i++ {
		candidate = filepath.Join(parent, fmt.Sprintf("%s %d", base, i))
		if _, err := os.Stat(candidate); errors.Is(err, os.ErrNotExist) {
			return candidate
		}
	}
}

func copyFile(src, dst string, mode fs.FileMode) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, in)
	return err
}

func copyDir(src, dst string, fileMode, dirMode fs.FileMode) error {
	return filepath.WalkDir(src, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		info, err := os.Lstat(path)
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return ErrPathEscape
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		if info.IsDir() {
			return os.MkdirAll(target, dirMode)
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("unsupported file type in folder copy: %s", path)
		}
		return copyFile(path, target, fileMode)
	})
}

const welcomeNote = `# Welcome to ZenNotes

ZenNotes keeps your notes as plain markdown files. Press ` + "`?`" + ` to see the
keybinding cheat sheet, or start typing to begin.

- Notes live in ` + "`inbox/`" + `, ` + "`quick/`" + `, ` + "`archive/`" + `, and ` + "`trash/`" + `.
- Every word you write stays on disk, under your control.
- Vim motions are on by default.
`

package vault

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	workflowsRelDir            = ".zennotes/workflows"
	workflowRunsRelDir         = ".zennotes/workflows/.runs"
	workflowLedgerVersion      = 1
	maxWorkflowSlugLength      = 64
	maxWorkflowIDLength        = 256
	maxWorkflowOps             = 5000
	maxWorkflowChanges         = 10000
	maxRetainedWorkflowRuns    = 100
	maxRetainedWorkflowRunByte = 50 * 1024 * 1024
)

var (
	ErrInvalidWorkflow   = errors.New("invalid workflow request")
	ErrWorkflowConflict  = errors.New("workflow plan is stale")
	workflowRunIDPattern = regexp.MustCompile(`^[A-Za-z0-9-]{1,160}$`)
)

type WorkflowFile struct {
	ID         string `json:"id"`
	SourcePath string `json:"sourcePath"`
	Raw        string `json:"raw"`
}

type WriteWorkflowInput struct {
	Slug               string `json:"slug"`
	Raw                string `json:"raw"`
	PreviousSourcePath string `json:"previousSourcePath,omitempty"`
}

type WorkflowRunFileChange struct {
	Path   string  `json:"path"`
	Before *string `json:"before"`
	After  *string `json:"after"`
}

type PreparedWorkflowRun struct {
	WorkflowID   string                  `json:"workflowId"`
	Ops          []json.RawMessage       `json:"ops"`
	Applied      int                     `json:"applied"`
	Irreversible int                     `json:"irreversible"`
	Changes      []WorkflowRunFileChange `json:"changes"`
}

type WorkflowRunReceipt struct {
	RunID        string            `json:"runId"`
	WorkflowID   string            `json:"workflowId"`
	StartedAt    int64             `json:"startedAt"`
	Applied      int               `json:"applied"`
	Paths        []string          `json:"paths"`
	Irreversible int               `json:"irreversible"`
	RolledBack   *WorkflowRollback `json:"rolledBack,omitempty"`
}

type WorkflowRollback struct {
	Reason string `json:"reason"`
}

type WorkflowUndoResult struct {
	RunID        string   `json:"runId"`
	Restored     int      `json:"restored"`
	DriftedPaths []string `json:"driftedPaths,omitempty"`
}

type WorkflowRunSummary struct {
	RunID       string   `json:"runId"`
	WorkflowID  string   `json:"workflowId"`
	StartedAt   int64    `json:"startedAt"`
	Applied     int      `json:"applied"`
	Paths       []string `json:"paths"`
	Undoable    bool     `json:"undoable"`
	Interrupted bool     `json:"interrupted,omitempty"`
}

type workflowJournalEntry struct {
	Path   string  `json:"path"`
	Before *string `json:"before"`
}

type workflowRunLedger struct {
	Version      int                    `json:"version"`
	RunID        string                 `json:"runId"`
	WorkflowID   string                 `json:"workflowId"`
	StartedAt    int64                  `json:"startedAt"`
	FinishedAt   int64                  `json:"finishedAt"`
	Applied      int                    `json:"applied"`
	Irreversible int                    `json:"irreversible"`
	Paths        []string               `json:"paths"`
	Ops          []json.RawMessage      `json:"ops"`
	Journal      []workflowJournalEntry `json:"journal"`
	Hashes       map[string]*string     `json:"hashes"`
	Undone       bool                   `json:"undone"`
	UndoneAt     int64                  `json:"undoneAt,omitempty"`
	RolledBack   *WorkflowRollback      `json:"rolledBack,omitempty"`
	Interrupted  *WorkflowRollback      `json:"interrupted,omitempty"`
}

func workflowDir(root string) string {
	return filepath.Join(root, ".zennotes", "workflows")
}

func safeWorkflowSlug(value string) string {
	var out strings.Builder
	dash := false
	for _, r := range strings.ToLower(strings.TrimSpace(value)) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			if dash && out.Len() > 0 && out.Len() < maxWorkflowSlugLength {
				out.WriteByte('-')
			}
			dash = false
			if out.Len() < maxWorkflowSlugLength {
				out.WriteRune(r)
			}
			continue
		}
		dash = true
	}
	result := strings.Trim(out.String(), "-")
	if result == "" {
		return "workflow"
	}
	return result
}

func (v *Vault) resolveWorkflowFilePath(sourcePath string) (string, error) {
	abs, err := SafeJoin(v.root, sourcePath)
	if err != nil {
		return "", err
	}
	dir := workflowDir(v.root)
	rel, err := filepath.Rel(dir, abs)
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || strings.Contains(rel, string(filepath.Separator)) {
		return "", fmt.Errorf("%w: refusing workflow path outside workflows dir", ErrInvalidWorkflow)
	}
	if !strings.EqualFold(filepath.Ext(rel), ".md") {
		return "", fmt.Errorf("%w: workflow path must be a .md file", ErrInvalidWorkflow)
	}
	return abs, nil
}

func workflowIDForName(name string) string {
	return strings.TrimSuffix(name, filepath.Ext(name))
}

func (v *Vault) ListWorkflows() ([]WorkflowFile, error) {
	v.mu.RLock()
	defer v.mu.RUnlock()
	entries, err := os.ReadDir(workflowDir(v.root))
	if errors.Is(err, os.ErrNotExist) {
		return []WorkflowFile{}, nil
	}
	if err != nil {
		return nil, err
	}
	out := make([]WorkflowFile, 0, len(entries))
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || strings.HasPrefix(name, ".") || !strings.EqualFold(filepath.Ext(name), ".md") {
			continue
		}
		sourcePath := workflowsRelDir + "/" + name
		abs, err := v.resolveWorkflowFilePath(sourcePath)
		if err != nil {
			continue
		}
		raw, err := os.ReadFile(abs)
		if err != nil {
			continue
		}
		out = append(out, WorkflowFile{ID: workflowIDForName(name), SourcePath: sourcePath, Raw: string(raw)})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

func (v *Vault) WriteWorkflow(input WriteWorkflowInput) (WorkflowFile, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	name := safeWorkflowSlug(input.Slug) + ".md"
	sourcePath := workflowsRelDir + "/" + name
	abs, err := v.resolveWorkflowFilePath(sourcePath)
	if err != nil {
		return WorkflowFile{}, err
	}
	var previous string
	if input.PreviousSourcePath != "" {
		previous, err = v.resolveWorkflowFilePath(input.PreviousSourcePath)
		if err != nil {
			return WorkflowFile{}, err
		}
	}
	if err := writeFileAtomic(abs, []byte(input.Raw), v.fileMode, v.dirMode); err != nil {
		return WorkflowFile{}, err
	}
	if previous != "" && previous != abs {
		// On a case-insensitive filesystem two differently-cased paths can name
		// the SAME file, and writeFileAtomic just landed the new content on it;
		// a spelling compare then let os.Remove delete the workflow that was
		// just saved. Compare file identity, not path strings.
		sameFile := false
		if prevInfo, statErr := os.Stat(previous); statErr == nil {
			if newInfo, statErr := os.Stat(abs); statErr == nil && os.SameFile(prevInfo, newInfo) {
				sameFile = true
			}
		}
		if !sameFile {
			if err := os.Remove(previous); err != nil && !errors.Is(err, os.ErrNotExist) {
				return WorkflowFile{}, err
			}
		}
	}
	return WorkflowFile{ID: workflowIDForName(name), SourcePath: sourcePath, Raw: input.Raw}, nil
}

func (v *Vault) DeleteWorkflow(sourcePath string) error {
	v.mu.Lock()
	defer v.mu.Unlock()
	abs, err := v.resolveWorkflowFilePath(sourcePath)
	if err != nil {
		return err
	}
	if err := os.Remove(abs); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

func workflowPathSegments(path string) []string {
	return strings.Split(strings.ReplaceAll(path, "\\", "/"), "/")
}

func (v *Vault) resolveWorkflowNotePath(rel string) (string, error) {
	if rel == "" || strings.HasPrefix(rel, "/") || strings.HasPrefix(rel, "\\") || filepath.IsAbs(rel) || (len(rel) >= 2 && ((rel[0] >= 'A' && rel[0] <= 'Z') || (rel[0] >= 'a' && rel[0] <= 'z')) && rel[1] == ':') {
		return "", fmt.Errorf("%w: workflow note path is absolute or empty: %s", ErrInvalidWorkflow, rel)
	}
	segments := workflowPathSegments(rel)
	for _, segment := range segments {
		if segment == ".." {
			return "", fmt.Errorf("%w: workflow note path escapes the vault: %s", ErrInvalidWorkflow, rel)
		}
	}
	if len(segments) > 0 && strings.EqualFold(segments[0], internalVaultDir) {
		return "", fmt.Errorf("%w: workflow note path is inside %s: %s", ErrInvalidWorkflow, internalVaultDir, rel)
	}
	ext := strings.ToLower(filepath.Ext(rel))
	if ext != ".md" && ext != excalidrawExt {
		return "", fmt.Errorf("%w: workflow path is not a note: %s", ErrInvalidWorkflow, rel)
	}
	return SafeJoin(v.root, rel)
}

func nullableString(value string) *string {
	copy := value
	return &copy
}

func readOptionalText(abs string) (*string, error) {
	body, err := os.ReadFile(abs)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return nullableString(string(body)), nil
}

func optionalStringsEqual(left, right *string) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}

// coerceUTF8ForWire mirrors what encoding/json does to a string on its way to
// the client: every invalid UTF-8 byte becomes one U+FFFD replacement. The
// client can never echo back bytes JSON already destroyed, so before-bytes
// comparisons must compare against this view of the disk, byte-for-byte
// identical to what /notes/read served.
func coerceUTF8ForWire(s string) string {
	if utf8.ValidString(s) {
		return s
	}
	var b strings.Builder
	b.Grow(len(s))
	for i := 0; i < len(s); {
		r, size := utf8.DecodeRuneInString(s[i:])
		if r == utf8.RuneError && size == 1 {
			b.WriteRune(utf8.RuneError)
			i++
			continue
		}
		b.WriteString(s[i : i+size])
		i += size
	}
	return b.String()
}

func optionalWireEqual(disk, client *string) bool {
	if optionalStringsEqual(disk, client) {
		return true
	}
	if disk == nil || client == nil {
		return false
	}
	return coerceUTF8ForWire(*disk) == *client
}

func workflowJournalKey(path string) string {
	if runtime.GOOS == "darwin" || runtime.GOOS == "windows" {
		return strings.ToLower(path)
	}
	return path
}

func workflowHash(value *string) *string {
	if value == nil {
		return nil
	}
	hash := sha256.Sum256([]byte(*value))
	encoded := hex.EncodeToString(hash[:])
	return &encoded
}

func newWorkflowRunID(startedAt int64) string {
	var suffix [6]byte
	if _, err := rand.Read(suffix[:]); err != nil {
		return fmt.Sprintf("%013d-%d", startedAt, time.Now().UnixNano())
	}
	return fmt.Sprintf("%013d-%s", startedAt, hex.EncodeToString(suffix[:]))
}

func (v *Vault) resolveWorkflowLedgerPath(runID string) (string, error) {
	if !workflowRunIDPattern.MatchString(runID) {
		return "", fmt.Errorf("%w: invalid workflow run id", ErrInvalidWorkflow)
	}
	return SafeJoin(v.root, workflowRunsRelDir+"/"+runID+".json")
}

func (v *Vault) resolveWorkflowRunsDir() (string, error) {
	return SafeJoin(v.root, workflowRunsRelDir)
}

func (v *Vault) writeWorkflowLedgerLocked(ledger workflowRunLedger) error {
	abs, err := v.resolveWorkflowLedgerPath(ledger.RunID)
	if err != nil {
		return err
	}
	body, err := json.MarshalIndent(ledger, "", "  ")
	if err != nil {
		return err
	}
	body = append(body, '\n')
	return writeFileAtomic(abs, body, v.fileMode, v.dirMode)
}

func (v *Vault) readWorkflowLedgerLocked(runID string) (workflowRunLedger, error) {
	abs, err := v.resolveWorkflowLedgerPath(runID)
	if err != nil {
		return workflowRunLedger{}, err
	}
	body, err := os.ReadFile(abs)
	if err != nil {
		return workflowRunLedger{}, err
	}
	var ledger workflowRunLedger
	if err := json.Unmarshal(body, &ledger); err != nil {
		return workflowRunLedger{}, err
	}
	if ledger.Version != workflowLedgerVersion || ledger.RunID != runID {
		return workflowRunLedger{}, fmt.Errorf("%w: unsupported workflow run ledger", ErrInvalidWorkflow)
	}
	return ledger, nil
}

func (v *Vault) restoreWorkflowJournalLocked(journal []workflowJournalEntry) (int, []error) {
	return v.restoreWorkflowJournalSnapshotLocked(journal, nil, nil)
}

// restoreWorkflowJournalSnapshotLocked restores the journal, consulting an
// optional pre-read snapshot (liveByPath/absByPath) so a caller that already
// read every file, like undo's drift check, does not read the whole run a
// second time while holding the exclusive vault lock. Entries missing from
// the snapshot fall back to resolving and reading here.
func (v *Vault) restoreWorkflowJournalSnapshotLocked(
	journal []workflowJournalEntry,
	liveByPath map[string]*string,
	absByPath map[string]string,
) (int, []error) {
	restored := 0
	failures := []error{}
	for _, entry := range journal {
		abs, haveAbs := absByPath[entry.Path]
		if !haveAbs {
			resolved, err := v.resolveWorkflowNotePath(entry.Path)
			if err != nil {
				failures = append(failures, fmt.Errorf("%s: %w", entry.Path, err))
				continue
			}
			abs = resolved
		}
		live, haveLive := liveByPath[entry.Path]
		if !haveLive {
			read, err := readOptionalText(abs)
			if err != nil {
				failures = append(failures, fmt.Errorf("%s: %w", entry.Path, err))
				continue
			}
			live = read
		}
		if optionalStringsEqual(live, entry.Before) {
			continue
		}
		var err error
		if entry.Before == nil {
			err = os.Remove(abs)
			if errors.Is(err, os.ErrNotExist) {
				err = nil
			}
		} else {
			err = writeFileAtomic(abs, []byte(*entry.Before), v.fileMode, v.dirMode)
		}
		if err != nil {
			failures = append(failures, fmt.Errorf("%s: %w", entry.Path, err))
			continue
		}
		restored++
	}
	return restored, failures
}

func workflowFailureMessage(failures []error) string {
	parts := make([]string, len(failures))
	for index, err := range failures {
		parts[index] = err.Error()
	}
	return strings.Join(parts, "; ")
}

// requiredWorkflowOpFields is the Go mirror of the workflow op schema. Three
// synced copies exist and MUST change together (the stripCodeContent rule):
// the op types in packages/shared-domain/src/workflows/types.ts, the
// parseWorkflowOp validator in packages/shared-domain/src/workflows/
// prepare-run.ts (duplicated into apps/desktop/src/main/workflow-apply.ts),
// and this map. Miss this one and every web run carrying the new op kind
// 400s as "not valid" while desktop applies it fine.
var requiredWorkflowOpFields = map[string][]string{
	"set-frontmatter": {"path", "field", "value"},
	"add-tag":         {"path", "tag"},
	"remove-tag":      {"path", "tag"},
	"move":            {"path", "to"},
	"rename":          {"path", "to"},
	"append":          {"path", "text"},
	"prepend":         {"path", "text"},
	"write-section":   {"path", "heading", "text"},
	"write-note":      {"path", "text"},
	"create-note":     {"path", "body"},
	"apply-template":  {"path", "template"},
	"archive":         {"path"},
	"trash":           {"path"},
	"notify":          {"message"},
	"clipboard":       {"text"},
}

func validatePreparedWorkflowOps(ops []json.RawMessage) (int, error) {
	irreversible := 0
	for index, raw := range ops {
		var op map[string]json.RawMessage
		if err := json.Unmarshal(raw, &op); err != nil {
			return 0, fmt.Errorf("%w: workflow op %d is not valid", ErrInvalidWorkflow, index)
		}
		var kind string
		if err := json.Unmarshal(op["kind"], &kind); err != nil {
			return 0, fmt.Errorf("%w: workflow op %d is not valid", ErrInvalidWorkflow, index)
		}
		required, valid := requiredWorkflowOpFields[kind]
		if !valid {
			return 0, fmt.Errorf("%w: workflow op %d is not valid", ErrInvalidWorkflow, index)
		}
		for _, field := range required {
			var value string
			if err := json.Unmarshal(op[field], &value); err != nil {
				return 0, fmt.Errorf("%w: workflow op %d is missing string field %s", ErrInvalidWorkflow, index, field)
			}
		}
		if kind == "notify" || kind == "clipboard" {
			irreversible++
		}
	}
	return irreversible, nil
}

func (v *Vault) ApplyPreparedWorkflow(input PreparedWorkflowRun) (WorkflowRunReceipt, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	startedAt := time.Now().UnixMilli()
	workflowID := strings.TrimSpace(input.WorkflowID)
	if workflowID == "" {
		workflowID = "unknown"
	}
	if len(workflowID) > maxWorkflowIDLength {
		return WorkflowRunReceipt{}, fmt.Errorf("%w: workflow id is too long", ErrInvalidWorkflow)
	}
	// Name the cap when a run is over it: the dry run just promised success,
	// so a bare "invalid counts" read as a client bug instead of a server
	// limit the user can see and reason about.
	if len(input.Ops) > maxWorkflowOps {
		return WorkflowRunReceipt{}, fmt.Errorf("%w: this run has %d operations, over the server limit of %d; split the workflow or run it from the desktop app", ErrInvalidWorkflow, len(input.Ops), maxWorkflowOps)
	}
	if len(input.Changes) > maxWorkflowChanges {
		return WorkflowRunReceipt{}, fmt.Errorf("%w: this run touches %d files, over the server limit of %d; split the workflow or run it from the desktop app", ErrInvalidWorkflow, len(input.Changes), maxWorkflowChanges)
	}
	if input.Applied < 0 || input.Irreversible < 0 || input.Applied > len(input.Ops) || input.Irreversible > len(input.Ops) {
		return WorkflowRunReceipt{}, fmt.Errorf("%w: invalid workflow run counts", ErrInvalidWorkflow)
	}
	irreversible, err := validatePreparedWorkflowOps(input.Ops)
	if err != nil {
		return WorkflowRunReceipt{}, err
	}
	if input.Irreversible != irreversible || input.Applied != len(input.Ops)-irreversible || (len(input.Changes) > 0 && input.Applied == 0) {
		return WorkflowRunReceipt{}, fmt.Errorf("%w: workflow operation counts do not match the prepared changes", ErrInvalidWorkflow)
	}

	paths := make([]string, 0, len(input.Changes))
	journal := make([]workflowJournalEntry, 0, len(input.Changes))
	hashes := make(map[string]*string, len(input.Changes))
	resolved := make([]string, 0, len(input.Changes))
	seen := map[string]struct{}{}
	for _, change := range input.Changes {
		path := filepath.ToSlash(filepath.Clean(filepath.FromSlash(change.Path)))
		abs, err := v.resolveWorkflowNotePath(path)
		if err != nil {
			return WorkflowRunReceipt{}, err
		}
		key := workflowJournalKey(path)
		if _, exists := seen[key]; exists {
			return WorkflowRunReceipt{}, fmt.Errorf("%w: duplicate workflow path %s", ErrInvalidWorkflow, path)
		}
		seen[key] = struct{}{}
		live, err := readOptionalText(abs)
		if err != nil {
			return WorkflowRunReceipt{}, err
		}
		// Compare against the client's WIRE view of the file: JSON coerced any
		// invalid UTF-8 to U+FFFD on the way out, so a note carrying one stray
		// non-UTF-8 byte would otherwise 409 on every apply, forever, and
		// re-planning reads the same lossy view so the loop never resolved.
		if !optionalWireEqual(live, change.Before) {
			return WorkflowRunReceipt{}, fmt.Errorf("%w: %s changed after the dry run", ErrWorkflowConflict, path)
		}
		paths = append(paths, path)
		journal = append(journal, workflowJournalEntry{Path: path, Before: change.Before})
		hashes[path] = workflowHash(change.After)
		resolved = append(resolved, abs)
	}

	runID := newWorkflowRunID(startedAt)
	ledger := workflowRunLedger{
		Version:      workflowLedgerVersion,
		RunID:        runID,
		WorkflowID:   workflowID,
		StartedAt:    startedAt,
		FinishedAt:   startedAt,
		Applied:      0,
		Irreversible: input.Irreversible,
		Paths:        paths,
		Ops:          input.Ops,
		Journal:      journal,
		Hashes:       map[string]*string{},
		Undone:       false,
		Interrupted:  &WorkflowRollback{Reason: "ZenNotes stopped while this run was still applying, so part of it may have landed. Undo restores every file it had recorded."},
	}
	if len(input.Ops) > 0 {
		if err := v.writeWorkflowLedgerLocked(ledger); err != nil {
			return WorkflowRunReceipt{}, err
		}
	}
	if len(input.Changes) > 0 {
		defer v.invalidateTextSearchCache()
	}

	for index, change := range input.Changes {
		var err error
		if change.After == nil {
			err = os.Remove(resolved[index])
			if errors.Is(err, os.ErrNotExist) {
				err = nil
			}
		} else {
			err = writeFileAtomic(resolved[index], []byte(*change.After), v.fileMode, v.dirMode)
		}
		if err == nil {
			continue
		}
		_, failures := v.restoreWorkflowJournalLocked(journal)
		reason := fmt.Sprintf("%v. The run was rolled back; your vault is unchanged.", err)
		if len(failures) == 0 {
			if abs, pathErr := v.resolveWorkflowLedgerPath(runID); pathErr == nil {
				_ = os.Remove(abs)
			}
			return WorkflowRunReceipt{RunID: runID, WorkflowID: workflowID, StartedAt: startedAt, Paths: []string{}, Irreversible: input.Irreversible, RolledBack: &WorkflowRollback{Reason: reason}}, nil
		}
		reason = fmt.Sprintf("%v. ROLLBACK INCOMPLETE: %s", err, workflowFailureMessage(failures))
		ledger.FinishedAt = time.Now().UnixMilli()
		ledger.RolledBack = &WorkflowRollback{Reason: reason}
		ledger.Interrupted = nil
		_ = v.writeWorkflowLedgerLocked(ledger)
		return WorkflowRunReceipt{RunID: runID, WorkflowID: workflowID, StartedAt: startedAt, Paths: paths, Irreversible: input.Irreversible, RolledBack: &WorkflowRollback{Reason: reason}}, nil
	}

	if len(input.Ops) > 0 {
		ledger.FinishedAt = time.Now().UnixMilli()
		ledger.Applied = input.Applied
		ledger.Hashes = hashes
		ledger.Interrupted = nil
		if err := v.writeWorkflowLedgerLocked(ledger); err != nil {
			_, failures := v.restoreWorkflowJournalLocked(journal)
			if len(failures) == 0 {
				if abs, pathErr := v.resolveWorkflowLedgerPath(runID); pathErr == nil {
					_ = os.Remove(abs)
				}
				return WorkflowRunReceipt{RunID: runID, WorkflowID: workflowID, StartedAt: startedAt, Paths: []string{}, Irreversible: input.Irreversible, RolledBack: &WorkflowRollback{Reason: fmt.Sprintf("The run could not be recorded, so it was rolled back (%v).", err)}}, nil
			}
			return WorkflowRunReceipt{}, fmt.Errorf("record workflow run: %w; rollback: %s", err, workflowFailureMessage(failures))
		}
		v.pruneWorkflowRunsLocked()
	}
	return WorkflowRunReceipt{RunID: runID, WorkflowID: workflowID, StartedAt: startedAt, Applied: input.Applied, Paths: paths, Irreversible: input.Irreversible}, nil
}

func (v *Vault) pruneWorkflowRunsLocked() {
	runsDir, err := v.resolveWorkflowRunsDir()
	if err != nil {
		return
	}
	entries, err := os.ReadDir(runsDir)
	if err != nil {
		return
	}
	type retainedFile struct {
		name string
		size int64
	}
	files := []retainedFile{}
	for _, entry := range entries {
		if entry.IsDir() || !strings.EqualFold(filepath.Ext(entry.Name()), ".json") {
			continue
		}
		info, err := entry.Info()
		if err == nil {
			files = append(files, retainedFile{name: entry.Name(), size: info.Size()})
		}
	}
	sort.Slice(files, func(i, j int) bool { return files[i].name > files[j].name })
	var total int64
	for index, file := range files {
		total += file.size
		// The newest ledger is the run the user is being shown right now. Keep
		// it even when one whole-vault run exceeds the history byte budget, or
		// pruning would remove Undo from the run that just completed.
		if index == 0 || (index < maxRetainedWorkflowRuns && total <= maxRetainedWorkflowRunByte) {
			continue
		}
		_ = os.Remove(filepath.Join(runsDir, file.name))
	}
}

func (v *Vault) UndoWorkflowRun(runID string) (WorkflowUndoResult, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	ledger, err := v.readWorkflowLedgerLocked(runID)
	if errors.Is(err, os.ErrNotExist) {
		return WorkflowUndoResult{}, fmt.Errorf("%w: unknown workflow run %s", ErrInvalidWorkflow, runID)
	}
	if err != nil {
		return WorkflowUndoResult{}, err
	}
	if ledger.Undone {
		return WorkflowUndoResult{}, fmt.Errorf("%w: workflow run was already undone", ErrInvalidWorkflow)
	}
	// One read per journaled file: the drift check and the restore both need
	// the live bytes, and reading a whole-vault run twice under the exclusive
	// lock doubled how long every other request stayed blocked. The lock
	// guarantees nothing changes between this pass and the restore.
	liveByPath := make(map[string]*string, len(ledger.Journal))
	absByPath := make(map[string]string, len(ledger.Journal))
	drifted := []string{}
	for _, entry := range ledger.Journal {
		abs, err := v.resolveWorkflowNotePath(entry.Path)
		if err != nil {
			continue
		}
		absByPath[entry.Path] = abs
		live, err := readOptionalText(abs)
		if err != nil {
			continue
		}
		liveByPath[entry.Path] = live
		if expected, tracked := ledger.Hashes[entry.Path]; tracked {
			if !optionalStringsEqual(workflowHash(live), expected) {
				drifted = append(drifted, entry.Path)
			}
		}
	}
	restored, failures := v.restoreWorkflowJournalSnapshotLocked(ledger.Journal, liveByPath, absByPath)
	if len(failures) > 0 {
		return WorkflowUndoResult{}, fmt.Errorf("undo of run %s is incomplete: %s", runID, workflowFailureMessage(failures))
	}
	ledger.Undone = true
	ledger.UndoneAt = time.Now().UnixMilli()
	if err := v.writeWorkflowLedgerLocked(ledger); err != nil {
		return WorkflowUndoResult{}, err
	}
	v.invalidateTextSearchCache()
	return WorkflowUndoResult{RunID: runID, Restored: restored, DriftedPaths: drifted}, nil
}

func (v *Vault) ListWorkflowRuns() ([]WorkflowRunSummary, error) {
	v.mu.RLock()
	defer v.mu.RUnlock()
	runsDir, err := v.resolveWorkflowRunsDir()
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(runsDir)
	if errors.Is(err, os.ErrNotExist) {
		return []WorkflowRunSummary{}, nil
	}
	if err != nil {
		return nil, err
	}
	runs := []WorkflowRunSummary{}
	for _, entry := range entries {
		if entry.IsDir() || !strings.EqualFold(filepath.Ext(entry.Name()), ".json") {
			continue
		}
		runID := strings.TrimSuffix(entry.Name(), filepath.Ext(entry.Name()))
		ledger, err := v.readWorkflowLedgerLocked(runID)
		if err != nil {
			continue
		}
		runs = append(runs, WorkflowRunSummary{
			RunID:       ledger.RunID,
			WorkflowID:  ledger.WorkflowID,
			StartedAt:   ledger.StartedAt,
			Applied:     ledger.Applied,
			Paths:       ledger.Paths,
			Undoable:    !ledger.Undone && len(ledger.Journal) > 0,
			Interrupted: ledger.Interrupted != nil,
		})
	}
	sort.Slice(runs, func(i, j int) bool {
		if runs[i].StartedAt != runs[j].StartedAt {
			return runs[i].StartedAt > runs[j].StartedAt
		}
		return runs[i].RunID > runs[j].RunID
	})
	return runs, nil
}

func (v *Vault) DeleteWorkflowRuns(workflowID string) (int, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	runsDir, err := v.resolveWorkflowRunsDir()
	if err != nil {
		return 0, err
	}
	entries, err := os.ReadDir(runsDir)
	if errors.Is(err, os.ErrNotExist) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	removed := 0
	for _, entry := range entries {
		if entry.IsDir() || !strings.EqualFold(filepath.Ext(entry.Name()), ".json") {
			continue
		}
		runID := strings.TrimSuffix(entry.Name(), filepath.Ext(entry.Name()))
		ledger, err := v.readWorkflowLedgerLocked(runID)
		if err != nil || ledger.WorkflowID != workflowID {
			continue
		}
		if err := os.Remove(filepath.Join(runsDir, entry.Name())); err == nil || errors.Is(err, os.ErrNotExist) {
			removed++
		}
	}
	return removed, nil
}

package vault

import (
	"regexp"
	"strings"
	"unicode"
)

// Regexes below mirror the TS extractors in src/main/vault.ts. They are
// intentionally the same shape so the extracted metadata matches the
// desktop build byte-for-byte for the common cases.

var (
	fenceLineRe   = regexp.MustCompile("^[ \t]*(`{3,}|~{3,})(.*)$")
	inlineCodeRe  = regexp.MustCompile("`[^`\n]*`")
	tagRe         = regexp.MustCompile(`(?:^|\s)#(\p{L}[\p{L}\d_/-]*)`)
	wikilinkRe    = regexp.MustCompile(`(!?)\[\[([^\]|]+?)(?:\|[^\]]+)?\]\]`)
	linkRe        = regexp.MustCompile(`(!?)\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)`)
	embedRe       = regexp.MustCompile(`!\[\[([^\]|]+?)(?:\|[^\]]+)?\]\]`)
	frontmatterRe = regexp.MustCompile(`(?s)\A---\r?\n(.*?)\r?\n---\r?\n?`)
	headingRe     = regexp.MustCompile(`(?m)^#{1,6}\s+`)
	imageMdRe     = regexp.MustCompile(`!\[[^\]]*\]\([^)]*\)`)
	mdLinkRe      = regexp.MustCompile(`\[([^\]]+)\]\([^)]*\)`)
	mdEmbedAltRe  = regexp.MustCompile(`!\[\[([^\]|]+)(?:\|([^\]]+))?\]\]`)
	mdWikiAltRe   = regexp.MustCompile(`\[\[([^\]|]+)(?:\|([^\]]+))?\]\]`)
	markupTrimRe  = regexp.MustCompile(`[*_~>]+`)
	wsCollapseRe  = regexp.MustCompile(`\s+`)
)

var attachmentExts = map[string]bool{
	".apng": true, ".avif": true, ".gif": true, ".jpeg": true, ".jpg": true,
	".png": true, ".svg": true, ".webp": true, ".pdf": true,
	".aac": true, ".flac": true, ".m4a": true, ".mp3": true, ".ogg": true, ".wav": true,
	".m4v": true, ".mov": true, ".mp4": true, ".ogv": true, ".webm": true,
}

// stripCodeContent blanks fenced and inline code so the tag/link/excerpt
// scanners never read code as content. Fence detection is line-based and
// indentation-tolerant: a fence nested under a list item is still a code block,
// so its contents (e.g. a C "#include" line) must not be scanned. A
// column-0-anchored regex missed indented fences and leaked them as tags (#293).
// Mirrors stripCodeContent in apps/desktop/src/main/vault.ts and
// packages/app-core/src/lib/tags.ts — keep the three in sync.
func stripCodeContent(body string) string {
	if !strings.Contains(body, "`") && !strings.Contains(body, "~") {
		return body
	}
	lines := strings.Split(body, "\n")
	inFence := false
	var fenceChar byte
	fenceLen := 0
	for i, line := range lines {
		if m := fenceLineRe.FindStringSubmatch(line); m != nil {
			marker := m[1]
			char := marker[0]
			rest := m[2]
			if !inFence {
				// A backtick fence's info string may not contain a backtick (CommonMark).
				if char == '~' || !strings.Contains(rest, "`") {
					inFence = true
					fenceChar = char
					fenceLen = len(marker)
					lines[i] = " "
					continue
				}
			} else if char == fenceChar && len(marker) >= fenceLen && strings.TrimSpace(rest) == "" {
				inFence = false
				lines[i] = " "
				continue
			}
		}
		if inFence {
			lines[i] = " "
		}
	}
	out := strings.Join(lines, "\n")
	out = inlineCodeRe.ReplaceAllString(out, " ")
	return out
}

// ExtractTags returns unique tags from first-class frontmatter `tags` and inline #tags.
func ExtractTags(body string) []string {
	seen := map[string]bool{}
	out := []string{}
	if m := frontmatterRe.FindStringSubmatch(body); len(m) >= 2 {
		fm := parseTaskFrontmatter(m[1])
		for _, raw := range fm["tags"] {
			// A bare scalar splits on commas and whitespace: `tags: daily, work`
			// is two tags and a tag can contain neither. Kept in sync with
			// frontmatterTags in packages/shared-domain/src/frontmatter.ts.
			for _, part := range strings.FieldsFunc(raw, func(r rune) bool {
				return r == ',' || unicode.IsSpace(r)
			}) {
				tag := strings.TrimPrefix(part, "#")
				if tag != "" && !seen[tag] {
					seen[tag] = true
					out = append(out, tag)
				}
			}
		}
	}

	markdownBody := frontmatterRe.ReplaceAllString(body, "")
	if !strings.Contains(markdownBody, "#") {
		return out
	}
	stripped := stripCodeContent(markdownBody)
	for _, m := range tagRe.FindAllStringSubmatch(stripped, -1) {
		if len(m) >= 2 {
			tag := m[1]
			if !seen[tag] {
				seen[tag] = true
				out = append(out, tag)
			}
		}
	}
	return out
}

// ExtractWikilinks returns unique [[wikilink]] targets, ignoring code.
func ExtractWikilinks(body string) []string {
	if !strings.Contains(body, "[[") {
		return []string{}
	}
	stripped := stripCodeContent(body)
	seen := map[string]bool{}
	out := []string{}
	for _, m := range wikilinkRe.FindAllStringSubmatch(stripped, -1) {
		if len(m) >= 3 {
			bang := m[1]
			target := strings.TrimSpace(m[2])
			if target == "" {
				continue
			}
			if bang == "!" && localAssetTargetKind(target) != "" {
				continue
			}
			if !seen[target] {
				seen[target] = true
				out = append(out, target)
			}
		}
	}
	return out
}

// BodyHasLocalAsset is the same cheap heuristic as the TS version.
func BodyHasLocalAsset(body string) bool {
	if !strings.Contains(body, "](") && !strings.Contains(body, "![[") {
		return false
	}
	stripped := stripCodeContent(body)
	for _, m := range linkRe.FindAllStringSubmatch(stripped, -1) {
		if len(m) < 3 {
			continue
		}
		href := strings.TrimSpace(m[2])
		if href == "" || strings.HasPrefix(href, "#") || strings.HasPrefix(href, "//") {
			continue
		}
		if matched, _ := regexpMatchScheme(href); matched {
			continue
		}
		if localAssetTargetKind(href) != "" {
			return true
		}
	}
	for _, m := range embedRe.FindAllStringSubmatch(stripped, -1) {
		if len(m) < 2 {
			continue
		}
		if localAssetTargetKind(strings.TrimSpace(m[1])) != "" {
			return true
		}
	}
	return false
}

var schemeRe = regexp.MustCompile(`^[a-zA-Z][a-zA-Z\d+.\-]*:`)

func regexpMatchScheme(href string) (bool, error) {
	return schemeRe.MatchString(href), nil
}

// BuildExcerpt makes a short plaintext preview from markdown.
func BuildExcerpt(body string) string {
	withoutFront := body
	if strings.HasPrefix(body, "---\n") {
		withoutFront = frontmatterRe.ReplaceAllString(body, "")
	}
	text := stripCodeContent(withoutFront)
	if strings.Contains(text, "](") {
		text = imageMdRe.ReplaceAllString(text, " ")
		text = mdLinkRe.ReplaceAllString(text, "$1")
	}
	if strings.Contains(text, "![[") {
		text = mdEmbedAltRe.ReplaceAllStringFunc(text, func(s string) string {
			m := mdEmbedAltRe.FindStringSubmatch(s)
			if len(m) >= 3 && m[2] != "" {
				return m[2]
			}
			if len(m) >= 2 {
				return m[1]
			}
			return ""
		})
	}
	if strings.Contains(text, "[[") {
		text = mdWikiAltRe.ReplaceAllStringFunc(text, func(s string) string {
			m := mdWikiAltRe.FindStringSubmatch(s)
			if len(m) >= 3 && m[2] != "" {
				return m[2]
			}
			if len(m) >= 2 {
				return m[1]
			}
			return ""
		})
	}
	if strings.Contains(text, "#") {
		text = headingRe.ReplaceAllString(text, "")
	}
	if strings.ContainsAny(text, "*_~>") {
		text = markupTrimRe.ReplaceAllString(text, "")
	}
	text = wsCollapseRe.ReplaceAllString(text, " ")
	text = strings.TrimSpace(text)
	if len(text) > 220 {
		text = text[:220]
	}
	return text
}

func localAssetTargetKind(target string) string {
	clean := target
	if i := strings.IndexAny(clean, "#?"); i >= 0 {
		clean = clean[:i]
	}
	dot := strings.LastIndexByte(clean, '.')
	if dot < 0 {
		return ""
	}
	ext := strings.ToLower(clean[dot:])
	if attachmentExts[ext] {
		return ext
	}
	return ""
}

// --- Task parsing (mirrors shared/tasks.ts parseTasksFromBody) ---

var (
	taskLineRe      = regexp.MustCompile(`^(\s*(?:[-*+]|\d+\.)\s+)\[( |x|X|>|-|/)\](.*)$`)
	inlineDueRe     = regexp.MustCompile(`(?i)(?:^|\s)due:\s*(\S+)`)
	inlinePriority  = regexp.MustCompile(`(?i)(?:^|\s)!(high|med|medium|low|h|m|l)\b`)
	inlineWaitingRe = regexp.MustCompile(`(?i)(?:^|\s)@waiting\b`)
	inlineFieldRe   = regexp.MustCompile(`(?i)(?:^|\s)@([a-z][a-z0-9_-]*):([\p{L}\d][\p{L}\d/_-]*)`)
	inlineTagRe     = regexp.MustCompile(`(?:^|\s)#([\p{L}\d][\p{L}\d/_\-]*)`)
	isoDateRe       = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
)

func isValidIsoDate(s string) bool {
	if !isoDateRe.MatchString(s) {
		return false
	}
	return true
}

func normalizePriority(raw string) string {
	v := strings.ToLower(strings.TrimSpace(raw))
	switch v {
	case "high", "h":
		return "high"
	// `normal` is the TaskNotes default priority; map it onto ZenNotes' `med`.
	// The inline `!prio` regex never emits `normal`, so inline parsing is
	// unaffected; only frontmatter file-tasks reach this arm.
	case "med", "medium", "normal", "m":
		return "med"
	case "low", "l":
		return "low"
	}
	return ""
}

type noteDefaults struct {
	Due       string
	Priority  string
	Status    string
	TasksMode string
}

// Note-level participation in the Tasks system, from the frontmatter `tasks:`
// key (#458). Mirrors noteTasksMode in packages/shared-domain/src/tasks.ts;
// keep the accepted values byte-identical. No runtime in this app types YAML
// scalars, so `tasks: false` arrives as the string "false"; matching is exact
// string comparison after lower-casing, anything unrecognized falls back to
// "all" (the pre-#458 behavior).
const (
	tasksModeAll      = "all"
	tasksModeNoteOnly = "note-only"
	tasksModeNone     = "none"
)

func noteTasksMode(val string) string {
	switch strings.ToLower(strings.TrimSpace(val)) {
	case "false", "off":
		return tasksModeNone
	case "note":
		return tasksModeNoteOnly
	}
	return tasksModeAll
}

func parseNoteDefaults(body string) noteDefaults {
	m := frontmatterRe.FindStringSubmatch(body)
	if len(m) < 2 {
		return noteDefaults{TasksMode: tasksModeAll}
	}
	d := noteDefaults{TasksMode: tasksModeAll}
	for _, line := range strings.Split(m[1], "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		colon := strings.IndexByte(trimmed, ':')
		if colon < 1 {
			continue
		}
		key := strings.ToLower(strings.TrimSpace(trimmed[:colon]))
		val := unquote(strings.TrimSpace(trimmed[colon+1:]))
		switch key {
		case "due":
			if isValidIsoDate(val) {
				d.Due = val
			}
		case "priority":
			if p := normalizePriority(val); p != "" {
				d.Priority = p
			}
		case "status":
			d.Status = strings.ToLower(val)
		case "tasks":
			d.TasksMode = noteTasksMode(val)
		}
	}
	return d
}

func unquote(v string) string {
	t := strings.TrimSpace(v)
	if len(t) >= 2 {
		first, last := t[0], t[len(t)-1]
		if (first == '"' || first == '\'') && first == last {
			return t[1 : len(t)-1]
		}
	}
	return t
}

// --- File tasks (TaskNotes-style: one task per note, metadata in frontmatter) ---

// taskFileTag is the frontmatter tag that marks a whole note as a task
// (TaskNotes convention, interoperable with TaskForge / Obsidian TaskNotes).
const taskFileTag = "task"

// doneStatuses are frontmatter `status:` values treated as complete (checked).
var doneStatuses = map[string]bool{
	"done": true, "complete": true, "completed": true, "x": true,
}

// cancelledStatuses are frontmatter `status:` values treated as cancelled (#450).
var cancelledStatuses = map[string]bool{
	"cancelled": true, "canceled": true,
}

// inProgressStatuses are frontmatter `status:` values treated as in progress
// (#512). `in-progress` is TaskNotes' spelling; the rest are what people type
// by hand. These stay open work, unlike done/cancelled.
var inProgressStatuses = map[string]bool{
	"in-progress": true, "in progress": true, "inprogress": true,
	"doing": true, "started": true, "wip": true,
}

var (
	taskFmListItemRe = regexp.MustCompile(`^\s*-\s+(.*)$`)
	taskFmKvRe       = regexp.MustCompile(`^([A-Za-z0-9_][\w-]*)\s*:\s*(.*)$`)
	taskFmLeadWsRe   = regexp.MustCompile(`^\s`)
)

// parseTaskFrontmatter parses a leading frontmatter block into flat fields,
// handling scalars, inline arrays (`tags: [a, b]`) and block lists (`tags:`
// then indented `  - a`). Keys are lower-cased; every value is stored as a
// slice (a scalar becomes a single-element slice). Best-effort and never
// panics: just enough YAML for task files, not a full parser. Mirrors
// parseFrontmatterFields in packages/shared-domain/src/frontmatter.ts.
func parseTaskFrontmatter(block string) map[string][]string {
	data := map[string][]string{}
	listKey := ""
	for _, rawLine := range strings.Split(block, "\n") {
		trimmed := strings.TrimSpace(rawLine)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		item := taskFmListItemRe.FindStringSubmatch(rawLine)
		if listKey != "" && taskFmLeadWsRe.MatchString(rawLine) && item != nil {
			data[listKey] = append(data[listKey], unquote(item[1]))
			continue
		}
		kv := taskFmKvRe.FindStringSubmatch(rawLine)
		if kv == nil {
			listKey = ""
			continue
		}
		key := strings.ToLower(kv[1])
		rest := strings.TrimSpace(kv[2])
		if rest == "" {
			// Bare key: a block list may follow on indented `- item` lines.
			listKey = key
			data[key] = []string{}
			continue
		}
		listKey = ""
		if strings.HasPrefix(rest, "[") && strings.HasSuffix(rest, "]") {
			var arr []string
			for _, s := range strings.Split(rest[1:len(rest)-1], ",") {
				v := unquote(s)
				if v != "" {
					arr = append(arr, v)
				}
			}
			data[key] = arr
		} else {
			data[key] = []string{unquote(rest)}
		}
	}
	return data
}

// firstScalar returns the first value of a frontmatter field, or "" when absent.
func firstScalar(v []string) string {
	if len(v) == 0 {
		return ""
	}
	return v[0]
}

// normalizeDueDate unquotes/trims a frontmatter date and returns it only when it
// is a valid YYYY-MM-DD string, otherwise "". Reuses the same validation the
// inline due parser uses.
func normalizeDueDate(raw string) string {
	v := unquote(strings.TrimSpace(raw))
	if isValidIsoDate(v) {
		return v
	}
	return ""
}

// parseTaskFile returns a whole-note "file task" when body has a leading
// frontmatter block whose `tags` include `task`, and ok=false otherwise. All
// metadata comes from frontmatter; the note body is free-form. Mirrors
// parseTaskFile in packages/shared-domain/src/tasks.ts. `body` is expected to
// already be newline-normalized by the caller.
func parseTaskFile(path, title string, folder NoteFolder, body string) (Task, bool) {
	m := frontmatterRe.FindStringSubmatch(body)
	if len(m) < 2 {
		return Task{}, false
	}
	fm := parseTaskFrontmatter(m[1])

	tags := []string{}
	hasTaskTag := false
	for _, t := range fm["tags"] {
		tag := strings.ToLower(strings.TrimPrefix(t, "#"))
		if tag == taskFileTag {
			hasTaskTag = true
			continue
		}
		tags = append(tags, tag)
	}
	if !hasTaskTag {
		return Task{}, false
	}

	// "open" is the effective state of a note that says nothing, not a custom
	// status the author chose: only an explicit status: reaches Fields, so the
	// note sits in the board's "No status" column and a drop there (which
	// clears the key) survives the next rescan. Mirrors parseTaskFile in
	// packages/shared-domain/src/tasks.ts (#672).
	status := "open"
	fields := map[string]string{}
	if s := firstScalar(fm["status"]); s != "" {
		status = strings.ToLower(s)
		fields["status"] = status
	}
	content := title
	if t := strings.TrimSpace(firstScalar(fm["title"])); t != "" {
		content = t
	}

	return Task{
		ID:            path + "#task",
		SourcePath:    path,
		NoteTitle:     title,
		NoteFolder:    folder,
		LineNumber:    0,
		TaskIndex:     -1,
		RawText:       "",
		Content:       content,
		Checked:       doneStatuses[status],
		Cancelled:     cancelledStatuses[status],
		InProgress:    inProgressStatuses[status],
		Due:           normalizeDueDate(firstScalar(fm["due"])),
		Priority:      normalizePriority(firstScalar(fm["priority"])),
		Waiting:       status == "waiting",
		Fields:        fields,
		Status:        status,
		Tags:          tags,
		Kind:          "file",
		Scheduled:     normalizeDueDate(firstScalar(fm["scheduled"])),
		CompletedDate: normalizeDueDate(firstScalar(fm["completeddate"])),
	}, true
}

// ParseTasksOptions controls scanning past task exclusions (#458).
type ParseTasksOptions struct {
	// IncludeExcluded scans past the note-level frontmatter `tasks:` opt-out:
	// the GET /tasks?includeExcluded=1 escape hatch. Default listing never sets
	// it.
	IncludeExcluded bool
}

// ParseTasks walks a markdown body and returns every checkbox task.
func ParseTasks(path, title string, folder NoteFolder, body string) []Task {
	return ParseTasksWith(path, title, folder, body, ParseTasksOptions{})
}

// ParseTasksWith is ParseTasks honoring options. The frontmatter `tasks:`
// gate lives here rather than in the parse helpers (the TS mirrors gate
// inside parseTaskFile/parseTasksFromBody because their callers invoke the
// two separately); the semantics are identical: `tasks: false`/`off` emits
// nothing and wins over `tags: [task]`, `tasks: note` keeps only the file
// task, anything else emits everything.
func ParseTasksWith(path, title string, folder NoteFolder, body string, opts ParseTasksOptions) []Task {
	normalized := strings.ReplaceAll(body, "\r\n", "\n")
	defaults := parseNoteDefaults(normalized)
	lines := strings.Split(normalized, "\n")

	mode := defaults.TasksMode
	if opts.IncludeExcluded {
		mode = tasksModeAll
	}

	out := []Task{}
	// A whole-note "file task" (if the frontmatter is tagged `task`) is emitted
	// before the inline checkbox tasks in the same note, which act as subtasks.
	if mode != tasksModeNone {
		if fileTask, ok := parseTaskFile(path, title, folder, normalized); ok {
			out = append(out, fileTask)
		}
	}
	if mode != tasksModeAll {
		return out
	}
	taskIndex := 0
	inFence := false
	fenceMarker := ""

	fenceStart := regexp.MustCompile("^([ \t]*)(`{3,}|~{3,})")

	for i, line := range lines {
		if fm := fenceStart.FindStringSubmatch(line); fm != nil {
			marker := fm[2]
			if !inFence {
				inFence = true
				fenceMarker = marker
			} else if marker == fenceMarker {
				inFence = false
				fenceMarker = ""
			}
			continue
		}
		if inFence {
			continue
		}
		m := taskLineRe.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		checkedChar := m[2]
		tail := strings.TrimPrefix(m[3], "]")
		checked := checkedChar == "x" || checkedChar == "X"
		cancelled := checkedChar == "-"
		inProgress := checkedChar == "/"
		forwarded := checkedChar == ">"

		due := ""
		priority := ""
		waiting := false
		fields := map[string]string{}
		tags := []string{}
		stripped := tail

		if dm := inlineDueRe.FindStringSubmatch(stripped); dm != nil {
			if isValidIsoDate(dm[1]) {
				due = dm[1]
			}
			stripped = inlineDueRe.ReplaceAllString(stripped, " ")
		}
		if pm := inlinePriority.FindStringSubmatch(stripped); pm != nil {
			priority = normalizePriority(pm[1])
			stripped = inlinePriority.ReplaceAllString(stripped, " ")
		}
		if inlineWaitingRe.MatchString(stripped) {
			waiting = true
			stripped = inlineWaitingRe.ReplaceAllString(stripped, " ")
		}
		for _, fm := range inlineFieldRe.FindAllStringSubmatch(stripped, -1) {
			if len(fm) < 3 {
				continue
			}
			key := strings.ToLower(fm[1])
			if _, exists := fields[key]; !exists {
				fields[key] = strings.ToLower(fm[2])
			}
		}
		if len(fields) > 0 {
			stripped = inlineFieldRe.ReplaceAllString(stripped, " ")
		}
		for _, tm := range inlineTagRe.FindAllStringSubmatch(tail, -1) {
			if len(tm) >= 2 {
				tag := strings.ToLower(tm[1])
				dupe := false
				for _, t := range tags {
					if t == tag {
						dupe = true
						break
					}
				}
				if !dupe {
					tags = append(tags, tag)
				}
			}
		}
		stripped = strings.TrimSpace(wsCollapseRe.ReplaceAllString(stripped, " "))
		content := stripped
		if content == "" {
			content = strings.TrimSpace(tail)
		}

		if due == "" {
			due = defaults.Due
		}
		if priority == "" {
			priority = defaults.Priority
		}
		if _, hasStatus := fields["status"]; !hasStatus && defaults.Status != "" {
			fields["status"] = defaults.Status
		}

		task := Task{
			ID:         fmtTaskID(path, taskIndex),
			SourcePath: path,
			NoteTitle:  title,
			NoteFolder: folder,
			LineNumber: i,
			TaskIndex:  taskIndex,
			RawText:    line,
			Content:    content,
			Checked:    checked,
			Cancelled:  cancelled,
			InProgress: inProgress,
			Forwarded:  forwarded,
			Due:        due,
			Priority:   priority,
			Waiting:    waiting,
			Fields:     fields,
			Status:     fields["status"],
			Tags:       tags,
		}
		out = append(out, task)
		taskIndex++
	}
	return out
}

func fmtTaskID(path string, idx int) string {
	return path + "#" + itoa(idx)
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := false
	if n < 0 {
		neg = true
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

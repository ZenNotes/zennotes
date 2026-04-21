package vault

import (
	"regexp"
	"strings"
)

// Regexes below mirror the TS extractors in src/main/vault.ts. They are
// intentionally the same shape so the extracted metadata matches the
// desktop build byte-for-byte for the common cases.

var (
	fencedBlockRe = regexp.MustCompile("(?m)(^|\n)```[^\n]*\n[\\s\\S]*?\n```[ \t]*(?:\n|$)")
	inlineCodeRe  = regexp.MustCompile("`[^`\n]*`")
	tagRe         = regexp.MustCompile(`(?:^|\s)#([A-Za-z][\w\-/]*)`)
	wikilinkRe    = regexp.MustCompile(`(!?)\[\[([^\]|]+?)(?:\|[^\]]+)?\]\]`)
	linkRe        = regexp.MustCompile(`(!?)\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)`)
	embedRe       = regexp.MustCompile(`!\[\[([^\]|]+?)(?:\|[^\]]+)?\]\]`)
	frontmatterRe = regexp.MustCompile(`(?s)\A---\n(.*?)\n---\n?`)
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

func stripCodeContent(body string) string {
	out := fencedBlockRe.ReplaceAllString(body, "$1 ")
	out = inlineCodeRe.ReplaceAllString(out, " ")
	return out
}

// ExtractTags returns unique #tags from a markdown body, ignoring code.
func ExtractTags(body string) []string {
	stripped := stripCodeContent(body)
	seen := map[string]bool{}
	out := []string{}
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
	withoutFront := frontmatterRe.ReplaceAllString(body, "")
	text := stripCodeContent(withoutFront)
	text = imageMdRe.ReplaceAllString(text, " ")
	text = mdLinkRe.ReplaceAllString(text, "$1")
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
	text = headingRe.ReplaceAllString(text, "")
	text = markupTrimRe.ReplaceAllString(text, "")
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
	taskLineRe      = regexp.MustCompile(`^(\s*(?:[-*+]|\d+\.)\s+)\[( |x|X)\](.*)$`)
	inlineDueRe     = regexp.MustCompile(`(?i)(?:^|\s)due:(\S+)`)
	inlinePriority  = regexp.MustCompile(`(?i)(?:^|\s)!(high|med|medium|low|h|m|l)\b`)
	inlineWaitingRe = regexp.MustCompile(`(?i)(?:^|\s)@waiting\b`)
	inlineTagRe     = regexp.MustCompile(`(?i)(?:^|\s)#([a-z0-9][a-z0-9/_\-]*)`)
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
	case "med", "medium", "m":
		return "med"
	case "low", "l":
		return "low"
	}
	return ""
}

type noteDefaults struct {
	Due      string
	Priority string
	Status   string
}

func parseNoteDefaults(body string) noteDefaults {
	m := frontmatterRe.FindStringSubmatch(body)
	if len(m) < 2 {
		return noteDefaults{}
	}
	var d noteDefaults
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

// ParseTasks walks a markdown body and returns every checkbox task.
func ParseTasks(path, title string, folder NoteFolder, body string) []Task {
	normalized := strings.ReplaceAll(body, "\r\n", "\n")
	defaults := parseNoteDefaults(normalized)
	lines := strings.Split(normalized, "\n")

	out := []Task{}
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

		due := ""
		priority := ""
		waiting := false
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
			Due:        due,
			Priority:   priority,
			Waiting:    waiting,
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

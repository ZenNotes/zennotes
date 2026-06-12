package vault

import (
	"regexp"
	"strings"
)

// Rewriting inbound [[wikilinks]] when a note is renamed. The resolution here
// mirrors packages/app-core/src/lib/wikilinks.ts and the desktop main's
// wikilink-rename.ts: a target resolves by note title (case-insensitive) unless
// it looks like a path, in which case it resolves by explicit/suffix path match.

var wikilinkRewriteRe = regexp.MustCompile(`(!?)\[\[([^\]\n]+)\]\]`)

var wikiTopFolders = []string{"inbox", "quick", "archive", "trash"}

func wikiNormalizeSlashes(value string) string {
	value = strings.ReplaceAll(value, "\\", "/")
	for strings.Contains(value, "//") {
		value = strings.ReplaceAll(value, "//", "/")
	}
	return value
}

func wikiStripMd(value string) string {
	if strings.HasSuffix(strings.ToLower(value), ".md") {
		return value[:len(value)-3]
	}
	return value
}

func wikiNormCompare(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}

func wikiIsPathLike(target string) bool {
	t := strings.TrimSpace(target)
	return strings.HasPrefix(t, "/") || strings.Contains(t, "/") ||
		strings.HasSuffix(strings.ToLower(t), ".md")
}

func wikiResolveExplicitPath(notes []NoteMeta, target string) (NoteMeta, bool) {
	normalized := wikiNormalizeSlashes(strings.TrimSpace(target))
	if normalized == "" {
		return NoteMeta{}, false
	}
	trimmed := strings.Trim(wikiStripMd(normalized), "/")
	if trimmed == "" {
		return NoteMeta{}, false
	}
	relPath := ""
	if strings.HasPrefix(normalized, "/") {
		relPath = "inbox/" + trimmed + ".md"
	} else {
		lower := strings.ToLower(trimmed)
		for _, f := range wikiTopFolders {
			if strings.HasPrefix(lower, f+"/") {
				relPath = trimmed + ".md"
				break
			}
		}
	}
	if relPath == "" {
		return NoteMeta{}, false
	}
	needle := wikiNormCompare(relPath)
	for _, n := range notes {
		if wikiNormCompare(n.Path) == needle {
			return n, true
		}
	}
	return NoteMeta{}, false
}

func wikiResolvePathSuffix(notes []NoteMeta, target string) (NoteMeta, bool) {
	trimmed := strings.Trim(wikiStripMd(wikiNormalizeSlashes(strings.TrimSpace(target))), "/")
	if trimmed == "" {
		return NoteMeta{}, false
	}
	suffix := wikiNormCompare("/" + trimmed + ".md")
	exact := wikiNormCompare(trimmed + ".md")
	var match NoteMeta
	count := 0
	for _, n := range notes {
		p := wikiNormCompare(n.Path)
		if p == exact || strings.HasSuffix(p, suffix) {
			match = n
			count++
		}
	}
	if count == 1 {
		return match, true
	}
	return NoteMeta{}, false
}

func wikiResolveTarget(notes []NoteMeta, target string) (NoteMeta, bool) {
	visible := make([]NoteMeta, 0, len(notes))
	for _, n := range notes {
		if n.Folder != FolderTrash {
			visible = append(visible, n)
		}
	}
	if wikiIsPathLike(target) {
		if n, ok := wikiResolveExplicitPath(visible, target); ok {
			return n, true
		}
		return wikiResolvePathSuffix(visible, target)
	}
	needle := wikiNormCompare(wikiStripMd(target))
	for _, n := range visible {
		if wikiNormCompare(n.Title) == needle {
			return n, true
		}
	}
	return NoteMeta{}, false
}

func wikiSplitContent(content string) (target, anchor, alias string) {
	rest := content
	if pipe := strings.IndexByte(rest, '|'); pipe >= 0 {
		alias = rest[pipe:]
		rest = rest[:pipe]
	}
	if idx := strings.IndexAny(rest, "#^"); idx >= 0 {
		anchor = rest[idx:]
		rest = rest[:idx]
	}
	return rest, anchor, alias
}

func wikiSwapBasename(target, newTitle string) string {
	dir := ""
	base := target
	if slash := strings.LastIndexByte(target, '/'); slash >= 0 {
		dir = target[:slash+1]
		base = target[slash+1:]
	}
	md := ""
	if strings.HasSuffix(strings.ToLower(base), ".md") {
		md = base[len(base)-3:]
	}
	return dir + newTitle + md
}

// wikiCodeMask marks byte positions inside fenced (line-start ``` / ~~~) or
// inline (`...`) code so links there are left untouched. RE2 has no lazy
// quantifiers, so we scan rather than match the whole block with a regex.
func wikiCodeMask(body string) []bool {
	mask := make([]bool, len(body))
	lineStart := 0
	inFence := false
	for i := 0; i <= len(body); i++ {
		if i == len(body) || body[i] == '\n' {
			line := body[lineStart:i]
			trimmed := strings.TrimLeft(line, " \t")
			isFence := strings.HasPrefix(trimmed, "```") || strings.HasPrefix(trimmed, "~~~")
			switch {
			case inFence:
				for j := lineStart; j < i; j++ {
					mask[j] = true
				}
				if isFence {
					inFence = false
				}
			case isFence:
				inFence = true
				for j := lineStart; j < i; j++ {
					mask[j] = true
				}
			default:
				wikiMarkInlineCode(mask, line, lineStart)
			}
			lineStart = i + 1
		}
	}
	return mask
}

func wikiMarkInlineCode(mask []bool, line string, offset int) {
	open := -1
	for i := 0; i < len(line); i++ {
		if line[i] != '`' {
			continue
		}
		if open < 0 {
			open = i
		} else {
			for j := open; j <= i; j++ {
				mask[offset+j] = true
			}
			open = -1
		}
	}
}

// rewriteWikilinksForRename rewrites every [[target]] / ![[target]] in body
// whose target resolves to the note at oldPath, pointing it at newTitle. Aliases,
// #heading / ^block anchors, and embeds are preserved; code is skipped. notes
// must reflect the pre-rename vault so links resolve to what they currently target.
func rewriteWikilinksForRename(body string, notes []NoteMeta, oldPath, newTitle string) (string, int) {
	matches := wikilinkRewriteRe.FindAllStringSubmatchIndex(body, -1)
	if len(matches) == 0 {
		return body, 0
	}
	mask := wikiCodeMask(body)
	var sb strings.Builder
	last := 0
	changed := 0
	for _, m := range matches {
		start, end := m[0], m[1]
		if mask[start] {
			continue
		}
		embed := body[m[2]:m[3]]
		content := body[m[4]:m[5]]
		target, anchor, alias := wikiSplitContent(content)
		if n, ok := wikiResolveTarget(notes, target); !ok || n.Path != oldPath {
			continue
		}
		newTarget := wikiSwapBasename(target, newTitle)
		if newTarget == target {
			continue
		}
		sb.WriteString(body[last:start])
		sb.WriteString(embed + "[[" + newTarget + anchor + alias + "]]")
		last = end
		changed++
	}
	if changed == 0 {
		return body, 0
	}
	sb.WriteString(body[last:])
	return sb.String(), changed
}

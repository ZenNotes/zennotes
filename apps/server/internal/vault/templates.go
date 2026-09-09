package vault

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Custom-template file I/O for a vault served over HTTP. Templates are plain
// `.md` files in the flat `.zennotes/templates/` directory, and this layer is
// deliberately parse-free: it moves raw bytes, and the client owns the
// frontmatter format (`packages/shared-domain/src/template-files.ts`).
//
// SYNCED COPY: the filename rules here (safeTemplateSlug, uniqueTemplateSlug,
// resolveTemplatePath) mirror `apps/desktop/src/main/templates.ts` byte for
// byte. A vault served remotely today is opened locally tomorrow, and a
// template's id is `custom:<filename stem>`, so both sides must land the same
// bytes on the same filename. Change one, change both.

const templatesRelDir = ".zennotes/templates"

var ErrInvalidTemplate = errors.New("invalid template request")

// CustomTemplateFile matches bridge-contract's CustomTemplateFile.
type CustomTemplateFile struct {
	SourcePath string `json:"sourcePath"`
	Raw        string `json:"raw"`
}

// WriteTemplateInput matches bridge-contract's WriteTemplateInput.
type WriteTemplateInput struct {
	Slug               string `json:"slug"`
	Raw                string `json:"raw"`
	PreviousSourcePath string `json:"previousSourcePath,omitempty"`
}

func templateDir(root string) string {
	return filepath.Join(root, ".zennotes", "templates")
}

func templateSourcePath(name string) string {
	return templatesRelDir + "/" + name
}

func templateFilenameStem(sourcePath string) string {
	name := sourcePath[strings.LastIndex(sourcePath, "/")+1:]
	if strings.EqualFold(filepath.Ext(name), ".md") {
		return name[:len(name)-len(".md")]
	}
	return name
}

// safeTemplateSlug keeps lowercase letters, digits and dashes; every run of
// anything else becomes one dash, and leading and trailing dashes go. Dashes
// that were already there stay as typed (`a--b` remains `a--b`): that is what
// the desktop does, and the renderer's slugifyTemplateName has collapsed them
// before the request is made anyway.
func safeTemplateSlug(slug string) string {
	var out strings.Builder
	inRun := false
	for _, r := range strings.ToLower(slug) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-' {
			if inRun {
				out.WriteByte('-')
				inRun = false
			}
			out.WriteRune(r)
			continue
		}
		inRun = true
	}
	if inRun {
		out.WriteByte('-')
	}
	cleaned := strings.Trim(out.String(), "-")
	if cleaned == "" {
		return "template"
	}
	return cleaned
}

// resolveTemplatePath turns a vault-relative sourcePath into an absolute one,
// refusing anything outside the flat templates directory (no traversal, no
// subdirectories, no symlinked escape) and anything that is not a `.md` file.
func (v *Vault) resolveTemplatePath(sourcePath string) (string, error) {
	abs, err := SafeJoin(v.root, sourcePath)
	if err != nil {
		return "", err
	}
	rel, err := filepath.Rel(templateDir(v.root), abs)
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || strings.Contains(rel, string(filepath.Separator)) {
		return "", fmt.Errorf("%w: refusing template path outside templates dir: %s", ErrInvalidTemplate, sourcePath)
	}
	if !strings.EqualFold(filepath.Ext(rel), ".md") {
		return "", fmt.Errorf("%w: template path must be a .md file: %s", ErrInvalidTemplate, sourcePath)
	}
	return abs, nil
}

// uniqueTemplateSlug picks a free slug. Editing the same file keeps its slug
// (the write lands in place); otherwise the slug is de-duplicated against the
// files already there (adr, adr-2, adr-3, ...).
func uniqueTemplateSlug(dir, base, previousSourcePath string) string {
	prevStem := ""
	if previousSourcePath != "" {
		prevStem = templateFilenameStem(previousSourcePath)
	}
	candidate := base
	for n := 2; ; n++ {
		if candidate == prevStem {
			return candidate
		}
		if _, err := os.Lstat(filepath.Join(dir, candidate+".md")); errors.Is(err, os.ErrNotExist) {
			return candidate
		}
		candidate = fmt.Sprintf("%s-%d", base, n)
	}
}

// ListTemplates returns every custom template with its raw bytes. A vault
// without a templates directory has no templates rather than an error, and
// an unreadable file is skipped, as the desktop does.
func (v *Vault) ListTemplates() ([]CustomTemplateFile, error) {
	v.mu.RLock()
	defer v.mu.RUnlock()
	entries, err := os.ReadDir(templateDir(v.root))
	if errors.Is(err, os.ErrNotExist) {
		return []CustomTemplateFile{}, nil
	}
	if err != nil {
		return nil, err
	}
	out := make([]CustomTemplateFile, 0, len(entries))
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || strings.HasPrefix(name, ".") || !strings.EqualFold(filepath.Ext(name), ".md") {
			continue
		}
		sourcePath := templateSourcePath(name)
		abs, err := v.resolveTemplatePath(sourcePath)
		if err != nil {
			continue
		}
		raw, err := os.ReadFile(abs)
		if err != nil {
			continue
		}
		out = append(out, CustomTemplateFile{SourcePath: sourcePath, Raw: string(raw)})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].SourcePath < out[j].SourcePath })
	return out, nil
}

func (v *Vault) ReadTemplate(sourcePath string) (string, error) {
	v.mu.RLock()
	defer v.mu.RUnlock()
	abs, err := v.resolveTemplatePath(sourcePath)
	if err != nil {
		return "", err
	}
	raw, err := os.ReadFile(abs)
	if err != nil {
		return "", err
	}
	return string(raw), nil
}

// WriteTemplate saves a template under a slug derived from the request, and
// removes the file it replaces when an edit changed the slug. The previous
// path is validated before anything is written, so a bad one cannot leave a
// stray new file behind.
func (v *Vault) WriteTemplate(input WriteTemplateInput) (CustomTemplateFile, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	var previous string
	if input.PreviousSourcePath != "" {
		abs, err := v.resolveTemplatePath(input.PreviousSourcePath)
		if err != nil {
			return CustomTemplateFile{}, err
		}
		previous = abs
	}
	dir := templateDir(v.root)
	slug := uniqueTemplateSlug(dir, safeTemplateSlug(input.Slug), input.PreviousSourcePath)
	sourcePath := templateSourcePath(slug + ".md")
	abs, err := v.resolveTemplatePath(sourcePath)
	if err != nil {
		return CustomTemplateFile{}, err
	}
	if err := writeFileAtomic(abs, []byte(input.Raw), v.fileMode, v.dirMode); err != nil {
		return CustomTemplateFile{}, err
	}
	if previous != "" && previous != abs {
		// On a case-insensitive filesystem two differently-cased paths can name
		// the SAME file, and writeFileAtomic just landed the new content on it;
		// a spelling compare would then delete the template that was just
		// saved. Compare file identity, not path strings.
		sameFile := false
		if prevInfo, statErr := os.Stat(previous); statErr == nil {
			if newInfo, statErr := os.Stat(abs); statErr == nil && os.SameFile(prevInfo, newInfo) {
				sameFile = true
			}
		}
		if !sameFile {
			if err := os.Remove(previous); err != nil && !errors.Is(err, os.ErrNotExist) {
				return CustomTemplateFile{}, err
			}
		}
	}
	return CustomTemplateFile{SourcePath: sourcePath, Raw: input.Raw}, nil
}

// DeleteTemplate removes a template; a file that is already gone is a
// success, as it is on the desktop.
func (v *Vault) DeleteTemplate(sourcePath string) error {
	v.mu.Lock()
	defer v.mu.Unlock()
	abs, err := v.resolveTemplatePath(sourcePath)
	if err != nil {
		return err
	}
	if err := os.Remove(abs); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

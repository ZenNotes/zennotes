package vault

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

const (
	templatesRelDir       = ".zennotes/templates"
	maxTemplateSlugLength = 64
)

var (
	ErrInvalidTemplate      = errors.New("invalid template request")
	unsafeTemplateSlugChars = regexp.MustCompile(`[^a-z0-9-]+`)
)

type CustomTemplateFile struct {
	SourcePath string `json:"sourcePath"`
	Raw        string `json:"raw"`
}

type WriteTemplateInput struct {
	Slug               string `json:"slug"`
	Raw                string `json:"raw"`
	PreviousSourcePath string `json:"previousSourcePath,omitempty"`
}

func templateDir(root string) string {
	return filepath.Join(root, ".zennotes", "templates")
}

func safeTemplateSlug(value string) string {
	cleaned := strings.Trim(unsafeTemplateSlugChars.ReplaceAllString(strings.ToLower(value), "-"), "-")
	if len(cleaned) > maxTemplateSlugLength {
		cleaned = strings.TrimRight(cleaned[:maxTemplateSlugLength], "-")
	}
	if cleaned != "" {
		return cleaned
	}
	return "template"
}

func (v *Vault) resolveTemplateFilePath(sourcePath string) (string, error) {
	abs, err := SafeJoin(v.root, sourcePath)
	if err != nil {
		return "", err
	}
	rel, err := filepath.Rel(templateDir(v.root), abs)
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || strings.Contains(rel, string(filepath.Separator)) {
		return "", fmt.Errorf("%w: refusing template path outside templates dir", ErrInvalidTemplate)
	}
	if !strings.EqualFold(filepath.Ext(rel), ".md") {
		return "", fmt.Errorf("%w: template path must be a .md file", ErrInvalidTemplate)
	}
	return abs, nil
}

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
	files := make([]CustomTemplateFile, 0, len(entries))
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || strings.HasPrefix(name, ".") || !strings.EqualFold(filepath.Ext(name), ".md") {
			continue
		}
		sourcePath := templatesRelDir + "/" + name
		abs, err := v.resolveTemplateFilePath(sourcePath)
		if err != nil {
			continue
		}
		raw, err := os.ReadFile(abs)
		if err != nil {
			continue
		}
		files = append(files, CustomTemplateFile{SourcePath: sourcePath, Raw: string(raw)})
	}
	sort.Slice(files, func(i, j int) bool { return files[i].SourcePath < files[j].SourcePath })
	return files, nil
}

func (v *Vault) ReadTemplate(sourcePath string) (string, error) {
	v.mu.RLock()
	defer v.mu.RUnlock()
	abs, err := v.resolveTemplateFilePath(sourcePath)
	if err != nil {
		return "", err
	}
	raw, err := os.ReadFile(abs)
	return string(raw), err
}

func (v *Vault) WriteTemplate(input WriteTemplateInput) (CustomTemplateFile, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	dir := templateDir(v.root)
	base := safeTemplateSlug(input.Slug)
	previousStem := strings.TrimSuffix(filepath.Base(input.PreviousSourcePath), filepath.Ext(input.PreviousSourcePath))
	slug := base
	for suffix := 2; ; suffix++ {
		if slug == previousStem {
			break
		}
		_, err := os.Stat(filepath.Join(dir, slug+".md"))
		if errors.Is(err, os.ErrNotExist) {
			break
		}
		if err != nil {
			return CustomTemplateFile{}, err
		}
		slug = fmt.Sprintf("%s-%d", base, suffix)
	}
	sourcePath := templatesRelDir + "/" + slug + ".md"
	abs, err := v.resolveTemplateFilePath(sourcePath)
	if err != nil {
		return CustomTemplateFile{}, err
	}
	var previous string
	if input.PreviousSourcePath != "" {
		previous, err = v.resolveTemplateFilePath(input.PreviousSourcePath)
		if err != nil {
			return CustomTemplateFile{}, err
		}
	}
	if err := writeFileAtomic(abs, []byte(input.Raw), v.fileMode, v.dirMode); err != nil {
		return CustomTemplateFile{}, err
	}
	if previous != "" && previous != abs {
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

func (v *Vault) DeleteTemplate(sourcePath string) error {
	v.mu.Lock()
	defer v.mu.Unlock()
	abs, err := v.resolveTemplateFilePath(sourcePath)
	if err != nil {
		return err
	}
	if err := os.Remove(abs); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

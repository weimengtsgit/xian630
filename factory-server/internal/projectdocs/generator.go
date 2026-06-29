package projectdocs

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

const IndexPath = ".factory/project-docs.json"

type Source struct {
	ProjectRoot      string
	JobID            string
	StepID           string
	Attempt          int
	AgentKey         string
	StepKind         string
	SourceArtifactID string
	OutputPath       string
	GeneratedAt      time.Time
}

type Index struct {
	SchemaVersion int             `json:"schemaVersion"`
	Documents     []DocumentEntry `json:"documents"`
}

type DocumentEntry struct {
	Path             string `json:"path"`
	Type             string `json:"type"`
	DisplayOrder     int    `json:"displayOrder"`
	SourceJobID      string `json:"sourceJobId"`
	SourceStepID     string `json:"sourceStepId"`
	Attempt          int    `json:"attempt"`
	AgentKey         string `json:"agentKey"`
	SourceArtifactID string `json:"sourceArtifactId"`
	SourceChecksum   string `json:"sourceChecksum"`
	GeneratedAt      string `json:"generatedAt"`
	DraftState       string `json:"draftState"`
}

type Generator struct{}

func (Generator) ProjectStep(src Source) (DocumentEntry, error) {
	if src.ProjectRoot == "" || src.OutputPath == "" {
		return DocumentEntry{}, fmt.Errorf("projectdocs: missing project root or output path")
	}
	raw, err := os.ReadFile(src.OutputPath)
	if err != nil {
		return DocumentEntry{}, err
	}
	var data any
	if err := json.Unmarshal(raw, &data); err != nil {
		return DocumentEntry{}, fmt.Errorf("parse output contract: %w", err)
	}
	spec := docSpecFor(src.StepKind, src.AgentKey)
	entry := DocumentEntry{
		Path:             spec.Path,
		Type:             spec.Type,
		DisplayOrder:     spec.Order,
		SourceJobID:      src.JobID,
		SourceStepID:     src.StepID,
		Attempt:          src.Attempt,
		AgentKey:         src.AgentKey,
		SourceArtifactID: src.SourceArtifactID,
		SourceChecksum:   checksum(raw),
		GeneratedAt:      generatedAt(src.GeneratedAt),
		DraftState:       "none",
	}
	body := renderMarkdown(spec.Title, entry, data)
	if err := writeFile(src.ProjectRoot, entry.Path, []byte(body)); err != nil {
		return DocumentEntry{}, err
	}
	idx, err := LoadIndex(src.ProjectRoot)
	if err != nil {
		return DocumentEntry{}, err
	}
	idx.upsert(entry)
	if err := SaveIndex(src.ProjectRoot, idx); err != nil {
		return DocumentEntry{}, err
	}
	return entry, nil
}

func (Generator) GenerateSummary(projectRoot string) error {
	idx, err := LoadIndex(projectRoot)
	if err != nil {
		return err
	}
	sort.Slice(idx.Documents, func(i, j int) bool { return idx.Documents[i].DisplayOrder < idx.Documents[j].DisplayOrder })
	var b strings.Builder
	b.WriteString("# 项目摘要\n\n")
	if len(idx.Documents) == 0 {
		b.WriteString("暂无已生成项目文档。\n")
	} else {
		b.WriteString("## 文档索引\n\n")
		for _, doc := range idx.Documents {
			if doc.Type == "summary" {
				continue
			}
			b.WriteString(fmt.Sprintf("- [%s](%s) — %s / attempt %d\n", doc.Path, strings.TrimPrefix(doc.Path, "docs/"), doc.AgentKey, doc.Attempt))
		}
	}
	content := []byte(b.String())
	if err := writeFile(projectRoot, "docs/00-summary.md", content); err != nil {
		return err
	}
	if err := writeFile(projectRoot, "README.md", content); err != nil {
		return err
	}
	summary := DocumentEntry{Path: "docs/00-summary.md", Type: "summary", DisplayOrder: 0, GeneratedAt: generatedAt(time.Now()), DraftState: "none"}
	idx.upsert(summary)
	return SaveIndex(projectRoot, idx)
}

func LoadIndex(projectRoot string) (Index, error) {
	path := filepath.Join(projectRoot, filepath.FromSlash(IndexPath))
	raw, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return Index{SchemaVersion: 1, Documents: []DocumentEntry{}}, nil
	}
	if err != nil {
		return Index{}, err
	}
	var idx Index
	if err := json.Unmarshal(raw, &idx); err != nil {
		return Index{}, err
	}
	if idx.SchemaVersion == 0 {
		idx.SchemaVersion = 1
	}
	return idx, nil
}

func SaveIndex(projectRoot string, idx Index) error {
	if idx.SchemaVersion == 0 {
		idx.SchemaVersion = 1
	}
	sort.Slice(idx.Documents, func(i, j int) bool {
		if idx.Documents[i].DisplayOrder != idx.Documents[j].DisplayOrder {
			return idx.Documents[i].DisplayOrder < idx.Documents[j].DisplayOrder
		}
		return idx.Documents[i].Path < idx.Documents[j].Path
	})
	raw, err := json.MarshalIndent(idx, "", "  ")
	if err != nil {
		return err
	}
	return writeFile(projectRoot, IndexPath, append(raw, '\n'))
}

func (idx *Index) upsert(entry DocumentEntry) {
	for i := range idx.Documents {
		if idx.Documents[i].Path == entry.Path {
			idx.Documents[i] = entry
			return
		}
	}
	idx.Documents = append(idx.Documents, entry)
}

type docSpec struct {
	Path, Type, Title string
	Order             int
}

func docSpecFor(kind, agentKey string) docSpec {
	switch kind {
	case "requirement_analysis":
		return docSpec{"docs/01-requirements.md", "requirements", "需求文档", 10}
	case "solution_design":
		return docSpec{"docs/02-solution.md", "solution", "方案文档", 20}
	case "design_contract":
		return docSpec{"docs/03-design.md", "design", "设计文档", 30}
	case "code_generation":
		return docSpec{"docs/04-implementation.md", "implementation", "实现文档", 40}
	case "test_verification", "product_acceptance":
		return docSpec{"docs/05-acceptance.md", "acceptance", "验收文档", 50}
	case "domain_analysis":
		return docSpec{"docs/domain-analysis.md", "domain-analysis", "领域分析", 60}
	case "data_integration":
		return docSpec{"docs/data-integration.md", "data-integration", "数据接入", 70}
	case "code_review":
		return docSpec{"docs/code-review.md", "code-review", "代码审查", 80}
	case "security_review":
		return docSpec{"docs/security-review.md", "security-review", "安全审查", 90}
	default:
		slug := slugify(agentKey)
		if slug == "" {
			slug = slugify(kind)
		}
		if slug == "" {
			slug = "extension"
		}
		return docSpec{"docs/" + slug + ".md", "extension", slug, 100}
	}
}

func renderMarkdown(title string, entry DocumentEntry, data any) string {
	var b strings.Builder
	b.WriteString("# " + title + "\n\n")
	b.WriteString("## 来源\n\n")
	b.WriteString(fmt.Sprintf("| 字段 | 值 |\n|---|---|\n| Job | `%s` |\n| Step | `%s` |\n| Attempt | %d |\n| Agent | `%s` |\n| Artifact | `%s` |\n| Checksum | `%s` |\n\n", entry.SourceJobID, entry.SourceStepID, entry.Attempt, entry.AgentKey, entry.SourceArtifactID, entry.SourceChecksum))
	b.WriteString("## 内容\n\n")
	renderValue(&b, data, 3)
	return b.String()
}

func renderValue(b *strings.Builder, value any, level int) {
	switch v := value.(type) {
	case map[string]any:
		keys := make([]string, 0, len(v))
		for k := range v {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			b.WriteString(strings.Repeat("#", level) + " " + k + "\n\n")
			renderValue(b, v[k], level+1)
		}
	case []any:
		for _, item := range v {
			if s, ok := item.(string); ok {
				b.WriteString("- " + s + "\n")
			} else {
				raw, _ := json.MarshalIndent(item, "", "  ")
				b.WriteString("```json\n" + string(raw) + "\n```\n\n")
			}
		}
		b.WriteString("\n")
	case string:
		b.WriteString(v + "\n\n")
	default:
		raw, _ := json.MarshalIndent(v, "", "  ")
		b.WriteString("```json\n" + string(raw) + "\n```\n\n")
	}
}

func writeFile(root, rel string, content []byte) error {
	path := filepath.Join(root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, content, 0o644)
}

func checksum(raw []byte) string {
	sum := sha256.Sum256(raw)
	return "sha256:" + hex.EncodeToString(sum[:])
}

func generatedAt(t time.Time) string {
	if t.IsZero() {
		t = time.Now()
	}
	return t.UTC().Format(time.RFC3339)
}

var slugRe = regexp.MustCompile(`[^a-zA-Z0-9_-]+`)

func slugify(value string) string {
	return strings.Trim(strings.ToLower(slugRe.ReplaceAllString(value, "-")), "-")
}

package dialogue

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"sort"
	"strings"

	"github.com/weimengtsgit/xian630/factory-server/internal/runner"
)

// DocumentDraftConverterInput is the input to the document draft converter.
type DocumentDraftConverterInput struct {
	Path           string
	SourceMarkdown string
	DraftMarkdown  string
	SourceChecksum string
}

// DocumentDraftConverterOutput is the output from the document draft converter.
type DocumentDraftConverterOutput struct {
	UserFacingText    string
	ChangeDescription string
	StructuredChanges json.RawMessage `json:",omitempty"`
}

// DocumentDraftConverter is the interface for converting document drafts to user-facing change summaries.
type DocumentDraftConverter interface {
	ConvertDraft(ctx context.Context, input DocumentDraftConverterInput) (*DocumentDraftConverterOutput, error)
}

// DeterministicDocumentDraftConverter is the default, deterministic converter that produces
// the same output given the same input. This is the fallback when no other converter is available
// or when the primary converter fails.
type DeterministicDocumentDraftConverter struct{}

func NewDeterministicDocumentDraftConverter() *DeterministicDocumentDraftConverter {
	return &DeterministicDocumentDraftConverter{}
}

func (c *DeterministicDocumentDraftConverter) ConvertDraft(ctx context.Context, input DocumentDraftConverterInput) (*DocumentDraftConverterOutput, error) {
	added, removed := lineDelta(input.SourceMarkdown, input.DraftMarkdown)
	excerpt := draftExcerpt(input.SourceMarkdown, input.DraftMarkdown, 600)

	return &DocumentDraftConverterOutput{
		UserFacingText:    "已根据文档草稿生成变更建议，请确认后应用。",
		ChangeDescription: fmt.Sprintf("基于 %s 的文档草稿生成变更需求：新增 %d 行、删除 %d 行。关键修改内容：%s", input.Path, added, removed, excerpt),
	}, nil
}

// FakeDocumentDraftConverter is a test/fake converter that returns predefined outputs.
type FakeDocumentDraftConverter struct {
	Output        *DocumentDraftConverterOutput
	Err           error
	ReturnNilOnly bool // If true, returns (nil, nil) instead of falling back to deterministic
}

func NewFakeDocumentDraftConverter(output *DocumentDraftConverterOutput, err error) *FakeDocumentDraftConverter {
	return &FakeDocumentDraftConverter{
		Output: output,
		Err:    err,
	}
}

func (c *FakeDocumentDraftConverter) ConvertDraft(ctx context.Context, input DocumentDraftConverterInput) (*DocumentDraftConverterOutput, error) {
	if c.Err != nil {
		return nil, c.Err
	}
	if c.ReturnNilOnly {
		return nil, nil
	}
	if c.Output != nil {
		return c.Output, nil
	}
	// Fall back to deterministic if no predefined output and not ReturnNilOnly
	return NewDeterministicDocumentDraftConverter().ConvertDraft(ctx, input)
}

// LLMDocumentDraftConverter is an LLM-backed converter that uses the Claude CLI to generate
// change summaries.
type LLMDocumentDraftConverter struct {
	runner        Runner
}

func NewLLMDocumentDraftConverter(runner Runner) *LLMDocumentDraftConverter {
	return &LLMDocumentDraftConverter{
		runner: runner,
	}
}

func (c *LLMDocumentDraftConverter) ConvertDraft(ctx context.Context, input DocumentDraftConverterInput) (*DocumentDraftConverterOutput, error) {
	// Create a temporary directory for artifacts
	dir := filepath.Join(c.runner.artifactRoot(), "document-draft-converter")

	// Build the input structure
	inputJSON := struct {
		Path           string `json:"path"`
		SourceMarkdown string `json:"source_markdown"`
		DraftMarkdown  string `json:"draft_markdown"`
		SourceChecksum string `json:"source_checksum"`
	}{
		Path:           input.Path,
		SourceMarkdown: input.SourceMarkdown,
		DraftMarkdown:  input.DraftMarkdown,
		SourceChecksum: input.SourceChecksum,
	}

	// Use runModel helper
	jsonStr, err := c.runner.runModel(ctx, dir, "", "document-draft-convert", inputJSON, c.buildPrompt, func(_ StreamEvent) {}, "document-draft-convert")
	if err != nil {
		return nil, err
	}

	// Parse JSON output
	var output DocumentDraftConverterOutput
	if err := json.Unmarshal([]byte(jsonStr), &output); err != nil {
		return nil, fmt.Errorf("unmarshal output: %w", runner.ErrOutputInvalidJSON)
	}

	// Validate required fields
	if output.UserFacingText == "" || output.ChangeDescription == "" {
		return nil, fmt.Errorf("missing required fields: %w", runner.ErrOutputInvalidJSON)
	}

	return &output, nil
}

func (c *LLMDocumentDraftConverter) buildPrompt(inputPath string) string {
	return fmt.Sprintf(`You are a document change summarizer. Your task is to analyze the changes between a source document and a draft document, then produce a user-facing summary of the changes.

The document draft converter input is at the absolute path %s — read it with the Read tool. The input contains:
- path: The file path of the document
- source_markdown: The original source document content (Markdown)
- draft_markdown: The modified draft document content (Markdown)
- source_checksum: The SHA-256 checksum of the source document

Analyze the differences and produce ONLY a valid JSON output with the following structure:
{
  "userFacingText": "A concise, user-friendly description of what changed (in Chinese)",
  "changeDescription": "A detailed summary of the changes including what was added, removed, or modified (in Chinese)",
  "structuredChanges": {
    "added": ["list of major additions"],
    "removed": ["list of major removals"],
    "modified": ["list of major modifications"]
  }
}

Make the summaries clear and actionable for a developer who will implement these changes. Always respond in Chinese.
`, inputPath)
}

// lineDelta counts the number of added and removed lines between source and draft.
func lineDelta(source, draft string) (int, int) {
	src := map[string]int{}
	for _, line := range strings.Split(source, "\n") {
		src[line]++
	}
	added, removed := 0, 0
	for _, line := range strings.Split(draft, "\n") {
		if src[line] > 0 {
			src[line]--
		} else {
			added++
		}
	}
	for _, n := range src {
		removed += n
	}
	return added, removed
}

// draftExcerpt creates a concise excerpt of the changes between source and draft.
func draftExcerpt(source, draft string, limit int) string {
	src := map[string]int{}
	for _, line := range strings.Split(source, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed != "" {
			src[trimmed]++
		}
	}
	var added []string
	for _, line := range strings.Split(draft, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		if src[trimmed] > 0 {
			src[trimmed]--
			continue
		}
		added = append(added, "+ "+trimmed)
	}
	var removed []string
	for line, count := range src {
		for i := 0; i < count; i++ {
			removed = append(removed, "- "+line)
		}
	}
	sort.Strings(removed)
	changed := append(added, removed...)
	if len(changed) == 0 {
		changed = []string{strings.TrimSpace(draft)}
	}
	text := strings.Join(changed, "；")
	if len([]rune(text)) > limit {
		runes := []rune(text)
		text = string(runes[:limit]) + "…"
	}
	return text
}

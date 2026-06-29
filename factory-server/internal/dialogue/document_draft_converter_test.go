package dialogue

import (
	"context"
	"fmt"
	"strings"
	"testing"
)

func TestDeterministicDocumentDraftConverter(t *testing.T) {
	converter := NewDeterministicDocumentDraftConverter()

	input := DocumentDraftConverterInput{
		Path:           "docs/test.md",
		SourceMarkdown: "original\nline 2\n",
		DraftMarkdown:  "modified\nline 2\nnew line\n",
		SourceChecksum: "sha256:abc123",
	}

	// First conversion
	output1, err := converter.ConvertDraft(context.Background(), input)
	if err != nil {
		t.Fatalf("convert 1: %v", err)
	}
	if output1 == nil {
		t.Fatal("output1 is nil")
	}

	// Verify the deterministic converter does NOT stuff the full content
	fullContent := "modified\nline 2\nnew line\n"
	if strings.Contains(output1.ChangeDescription, fullContent) {
		t.Errorf("changeDescription should contain only excerpt, not full content: %q", output1.ChangeDescription)
	}

	// Second conversion with same input should produce same output
	output2, err := converter.ConvertDraft(context.Background(), input)
	if err != nil {
		t.Fatalf("convert 2: %v", err)
	}
	if output2 == nil {
		t.Fatal("output2 is nil")
	}

	if output1.UserFacingText != output2.UserFacingText {
		t.Errorf("userFacingText mismatch: %q != %q", output1.UserFacingText, output2.UserFacingText)
	}
	if output1.ChangeDescription != output2.ChangeDescription {
		t.Errorf("changeDescription mismatch: %q != %q", output1.ChangeDescription, output2.ChangeDescription)
	}
}

func TestFakeDocumentDraftConverter(t *testing.T) {
	// Test with custom output
	expectedOutput := &DocumentDraftConverterOutput{
		UserFacingText:    "Custom user text",
		ChangeDescription: "Custom change desc",
	}
	fake := NewFakeDocumentDraftConverter(expectedOutput, nil)
	output, err := fake.ConvertDraft(context.Background(), DocumentDraftConverterInput{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if output.UserFacingText != expectedOutput.UserFacingText {
		t.Errorf("userFacingText=%q want=%q", output.UserFacingText, expectedOutput.UserFacingText)
	}
	if output.ChangeDescription != expectedOutput.ChangeDescription {
		t.Errorf("changeDescription=%q want=%q", output.ChangeDescription, expectedOutput.ChangeDescription)
	}

	// Test with error
	testErr := fmt.Errorf("test error")
	fake = NewFakeDocumentDraftConverter(nil, testErr)
	output, err = fake.ConvertDraft(context.Background(), DocumentDraftConverterInput{})
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if err != testErr {
		t.Errorf("err=%v want=%v", err, testErr)
	}

	// Test with nil output falls back to deterministic
	fake = NewFakeDocumentDraftConverter(nil, nil)
	output, err = fake.ConvertDraft(context.Background(), DocumentDraftConverterInput{
		Path:           "docs/test.md",
		SourceMarkdown: "original",
		DraftMarkdown:  "modified",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if output == nil {
		t.Fatal("output is nil, should have fallen back to deterministic")
	}
	if output.UserFacingText == "" {
		t.Error("userFacingText is empty")
	}

	// Test with ReturnNilOnly=true
	fake = &FakeDocumentDraftConverter{ReturnNilOnly: true}
	output, err = fake.ConvertDraft(context.Background(), DocumentDraftConverterInput{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if output != nil {
		t.Errorf("output=%#v want nil", output)
	}
}

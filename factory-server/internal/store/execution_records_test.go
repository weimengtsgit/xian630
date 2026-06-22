package store

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

// appendRecord is a tiny test helper that inserts a StepExecutionRecord with
// only the fields the brief's tests care about filled in. It calls the real
// Store.AppendStepExecutionRecord method under test.
func appendRecord(t *testing.T, st *Store, jobID, stepID string, attempt, sequence int, kind model.ExecutionRecordKind, content string) {
	t.Helper()
	rec := model.StepExecutionRecord{
		ID:        fmt.Sprintf("%s:%s:%d:%d", jobID, stepID, attempt, sequence),
		JobID:     jobID,
		StepID:    stepID,
		Attempt:   attempt,
		Sequence:  sequence,
		Kind:      kind,
		Content:   content,
		CreatedAt: time.Now(),
	}
	if err := st.AppendStepExecutionRecord(context.Background(), rec); err != nil {
		t.Fatalf("append record %s:%s attempt=%d seq=%d: %v", jobID, stepID, attempt, sequence, err)
	}
}

func TestStepExecutionSummaryAndPageAreAttemptScoped(t *testing.T) {
	st := newTestStore(t)
	appendRecord(t, st, "job_1", "step_1", 2, 2, "command_stdout", "second")
	appendRecord(t, st, "job_1", "step_1", 1, 1, "system", "started")
	appendRecord(t, st, "job_2", "step_2", 1, 1, "system", "other job")

	got, err := st.ListStepExecutionRecordPage(context.Background(), "job_1", "step_1", 1, 0, 200)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Attempt != 1 || got[0].Sequence != 1 {
		t.Fatalf("records = %#v", got)
	}
	summaries, _ := st.ListStepExecutionSummaries(context.Background(), "job_1")
	if len(summaries) != 1 || summaries[0].LatestAttempt != 2 || summaries[0].LatestRecord.Content != "second" {
		t.Fatalf("summaries = %#v", summaries)
	}
	// Prove the summary is scoped by job_id: job_2 has its own record and must
	// not leak into (nor be starved by) the job_1 summary above.
	job2Summaries, _ := st.ListStepExecutionSummaries(context.Background(), "job_2")
	if len(job2Summaries) != 1 || job2Summaries[0].StepID != "step_2" {
		t.Fatalf("job_2 summaries = %#v", job2Summaries)
	}
}

// TestStepExecutionRecordPageOrderAndLimit exercises the limit cap (200) and
// the ascending-sequence return order even when pagination selects newest-first.
func TestStepExecutionRecordPageOrderAndLimit(t *testing.T) {
	st := newTestStore(t)
	// Insert 250 records; the page query must cap at 200 and return ascending.
	for i := 1; i <= 250; i++ {
		appendRecord(t, st, "job_x", "step_a", 1, i, "activity", fmt.Sprintf("ev-%d", i))
	}
	got, err := st.ListStepExecutionRecordPage(context.Background(), "job_x", "step_a", 1, 0, 1000)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 200 {
		t.Fatalf("limit cap: want 200 rows, got %d", len(got))
	}
	// beforeSequence=0 returns the latest page (newest 200 rows), in ascending
	// order: seqs 51..250. The cap prevented loading all 250.
	if got[0].Sequence != 51 || got[199].Sequence != 250 {
		t.Fatalf("ascending latest page: first=%d last=%d, want 51/250", got[0].Sequence, got[199].Sequence)
	}
	// beforeSequence=100 (exclusive upper bound) with limit 50 -> the newest 50
	// sequences strictly less than 100, ascending: seqs 50..99.
	page, err := st.ListStepExecutionRecordPage(context.Background(), "job_x", "step_a", 1, 100, 50)
	if err != nil {
		t.Fatal(err)
	}
	if len(page) != 50 || page[0].Sequence != 50 || page[49].Sequence != 99 {
		t.Fatalf("page before=100: len=%d first=%d last=%d", len(page), page[0].Sequence, page[49].Sequence)
	}
	// Walk all the way back to the oldest page: before=51 with limit 200 -> seqs 1..50.
	oldest, err := st.ListStepExecutionRecordPage(context.Background(), "job_x", "step_a", 1, 51, 200)
	if err != nil {
		t.Fatal(err)
	}
	if len(oldest) != 50 || oldest[0].Sequence != 1 || oldest[49].Sequence != 50 {
		t.Fatalf("oldest page: len=%d first=%d last=%d", len(oldest), oldest[0].Sequence, oldest[49].Sequence)
	}
}

// TestStepExecutionRecordPageAttemptIsolation confirms the page query is scoped
// to a single attempt (records from other attempts of the same step are excluded).
func TestStepExecutionRecordPageAttemptIsolation(t *testing.T) {
	st := newTestStore(t)
	appendRecord(t, st, "job_y", "step_b", 1, 1, "system", "a1")
	appendRecord(t, st, "job_y", "step_b", 2, 1, "system", "a2")
	appendRecord(t, st, "job_y", "step_b", 2, 2, "system", "a2b")
	got, err := st.ListStepExecutionRecordPage(context.Background(), "job_y", "step_b", 2, 0, 200)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("attempt isolation: want 2 rows for attempt=2, got %d", len(got))
	}
}

package store

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

// TestDialogueCreateGetReplay covers create → get → append messages → latest.
func TestDialogueCreateGetReplay(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	now := time.Now()

	sess := model.DialogueSession{
		ID:            "dlg_1",
		InitialPrompt: "生成一个航母编队复盘应用",
		Status:        model.DialogueStatusRouting,
		Intent:        model.DialogueIntentRouting,
		CreatedAt:     now,
		UpdatedAt:     now,
	}
	if err := st.CreateDialogueSession(ctx, sess); err != nil {
		t.Fatalf("CreateDialogueSession: %v", err)
	}
	got, err := st.GetDialogueSession(ctx, "dlg_1")
	if err != nil || got == nil {
		t.Fatalf("GetDialogueSession = %#v, %v", got, err)
	}
	if got.InitialPrompt != sess.InitialPrompt || got.Status != model.DialogueStatusRouting {
		t.Fatalf("session = %#v", got)
	}

	// Append two messages and fetch latest (capped).
	for i, c := range []string{"first", "second"} {
		if err := st.AppendDialogueMessage(ctx, model.DialogueMessage{
			ID: "msg_" + string(rune('a'+i)), DialogueID: "dlg_1", Role: "agent",
			Kind: "analysis", Content: c, CreatedAt: now.Add(time.Duration(i) * time.Second),
		}); err != nil {
			t.Fatalf("AppendDialogueMessage(%d): %v", i, err)
		}
	}
	latest, err := st.LatestDialogueMessages(ctx, "dlg_1", 1)
	if err != nil {
		t.Fatalf("LatestDialogueMessages: %v", err)
	}
	if len(latest) != 1 || latest[0].Content != "second" {
		t.Fatalf("latest = %#v", latest)
	}
	// Cap > row count returns everything, oldest-first.
	all, err := st.LatestDialogueMessages(ctx, "dlg_1", 10)
	if err != nil {
		t.Fatalf("LatestDialogueMessages(all): %v", err)
	}
	if len(all) != 2 || all[0].Content != "first" || all[1].Content != "second" {
		t.Fatalf("all = %#v", all)
	}
}

// TestDialogueUpdateRouteIntentStatusDraft exercises the route/intent/status/
// draft update path.
func TestDialogueUpdateRouteIntentStatusDraft(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	now := time.Now()
	if err := st.CreateDialogueSession(ctx, model.DialogueSession{
		ID: "dlg_u", InitialPrompt: "x", Status: model.DialogueStatusRouting,
		Intent: model.DialogueIntentRouting, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := st.UpdateDialogueRoute(ctx, "dlg_u",
		model.DialogueIntentApplicationGeneration,
		model.DialogueStatusDraftingApplication,
		`{"existingApps":[]}`, true); err != nil {
		t.Fatalf("UpdateDialogueRoute: %v", err)
	}
	got, _ := st.GetDialogueSession(ctx, "dlg_u")
	if got.Intent != model.DialogueIntentApplicationGeneration ||
		got.Status != model.DialogueStatusDraftingApplication ||
		got.DraftJSON != `{"existingApps":[]}` || !got.RouteLocked {
		t.Fatalf("after route update = %#v", got)
	}
}

// TestDialogueTerminalLinks checks resolved app / created agent / terminal
// times are set and readable.
func TestDialogueTerminalLinks(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	now := time.Now()
	if err := st.CreateDialogueSession(ctx, model.DialogueSession{
		ID: "dlg_t", InitialPrompt: "x", Status: model.DialogueStatusDraftingApplication,
		Intent: model.DialogueIntentApplicationGeneration, RouteLocked: true,
		CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := st.SetDialogueResolved(ctx, "dlg_t", "app_42", "agent_biz_1"); err != nil {
		t.Fatalf("SetDialogueResolved: %v", err)
	}
	got, _ := st.GetDialogueSession(ctx, "dlg_t")
	if got.ResolvedApplicationID != "app_42" || got.CreatedAgentID != "agent_biz_1" {
		t.Fatalf("terminal links = %#v", got)
	}
	if got.Status != model.DialogueStatusResolved {
		t.Fatalf("status = %q, want resolved", got.Status)
	}
	if got.ResolvedAt == nil {
		t.Fatalf("resolved_at not set")
	}
}

// TestDeleteDialogueSessionDeletesMessages verifies the transactional delete
// removes the session and its messages together.
func TestDeleteDialogueSessionDeletesMessages(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	now := time.Now()
	if err := st.CreateDialogueSession(ctx, model.DialogueSession{
		ID: "dlg_d", InitialPrompt: "x", Status: model.DialogueStatusRouting,
		Intent: model.DialogueIntentRouting, CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := st.AppendDialogueMessage(ctx, model.DialogueMessage{
		ID: "msg_d", DialogueID: "dlg_d", Role: "agent", Kind: "k", Content: "c", CreatedAt: now,
	}); err != nil {
		t.Fatalf("append: %v", err)
	}
	if err := st.DeleteDialogueSession(ctx, "dlg_d"); err != nil {
		t.Fatalf("DeleteDialogueSession: %v", err)
	}
	if got, _ := st.GetDialogueSession(ctx, "dlg_d"); got != nil {
		t.Fatalf("session still exists: %#v", got)
	}
	latest, _ := st.LatestDialogueMessages(ctx, "dlg_d", 10)
	if len(latest) != 0 {
		t.Fatalf("messages still exist: %#v", latest)
	}
}

// TestDeleteDialogueSessionClearsClarification verifies deleting a dialogue also
// removes its source clarification session, so the startup backfill
// (BackfillClarificationDialogues) cannot resurrect the deleted dialogue on the
// next restart. Regression for "deleted dialogue reappears after service restart".
func TestDeleteDialogueSessionClearsClarification(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	now := time.Now()

	if err := st.CreateClarificationSession(ctx, model.ClarificationSession{
		ID: "clar_a", Status: model.ClarificationStatusConfirmed, InitialPrompt: "做一个看板",
		CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatalf("create clarification: %v", err)
	}
	if err := st.CreateDialogueSession(ctx, model.DialogueSession{
		ID: "dlg_a", Status: model.DialogueStatusResolved, InitialPrompt: "做一个看板",
		Intent: model.DialogueIntentApplicationGeneration, ClarificationSessionID: "clar_a",
		CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatalf("create dialogue: %v", err)
	}

	if err := st.DeleteDialogueSession(ctx, "dlg_a"); err != nil {
		t.Fatalf("DeleteDialogueSession: %v", err)
	}

	// Source clarification must be gone — otherwise BackfillClarificationDialogues
	// recreates the dialogue from it on the next startup.
	if sess, _ := st.GetClarificationSession(ctx, "clar_a"); sess != nil {
		t.Fatalf("clarification session still exists — backfill will resurrect the deleted dialogue")
	}

	if err := st.BackfillClarificationDialogues(ctx); err != nil {
		t.Fatalf("backfill: %v", err)
	}
	if id, ok := st.FindDialogueByClarificationID(ctx, "clar_a"); ok || id != "" {
		t.Fatalf("backfill resurrected the deleted dialogue: id=%q ok=%v", id, ok)
	}
}

// TestFindDialogueByClarificationID covers the idempotency guard used by the
// legacy backfill.
func TestFindDialogueByClarificationID(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	now := time.Now()
	if got, ok := st.FindDialogueByClarificationID(ctx, "clar_none"); ok || got != "" {
		t.Fatalf("miss = %q,%v, want empty,false", got, ok)
	}
	if err := st.CreateDialogueSession(ctx, model.DialogueSession{
		ID: "dlg_c", InitialPrompt: "x", Status: model.DialogueStatusResolved,
		Intent: model.DialogueIntentApplicationGeneration, RouteLocked: true,
		ClarificationSessionID: "clar_9", CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatalf("create: %v", err)
	}
	got, ok := st.FindDialogueByClarificationID(ctx, "clar_9")
	if !ok || got != "dlg_c" {
		t.Fatalf("hit = %q,%v, want dlg_c,true", got, ok)
	}
}

// TestListDialogueSessionsNewestFirst asserts the list ordering and limit cap.
func TestListDialogueSessionsNewestFirst(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	base := time.Now()
	for i, id := range []string{"dlg_old", "dlg_new"} {
		if err := st.CreateDialogueSession(ctx, model.DialogueSession{
			ID: id, InitialPrompt: "x", Status: model.DialogueStatusRouting,
			Intent:    model.DialogueIntentRouting,
			CreatedAt: base.Add(time.Duration(i) * time.Second),
			UpdatedAt: base.Add(time.Duration(i) * time.Second),
		}); err != nil {
			t.Fatalf("create %s: %v", id, err)
		}
	}
	got, err := st.ListDialogueSessions(ctx, 50)
	if err != nil {
		t.Fatalf("ListDialogueSessions: %v", err)
	}
	if len(got) != 2 || got[0].ID != "dlg_new" || got[1].ID != "dlg_old" {
		t.Fatalf("order = %#v", got)
	}
}

// TestAgentCategoryPromptRoundTrip verifies the new category/prompt columns
// persist and round-trip through upsert/get/list.
func TestAgentCategoryPromptRoundTrip(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	a := model.Agent{
		ID: "agent_biz_1", Key: "ops-helper", Name: "作战助手", Role: "business_processing",
		Description: "业务处理代理", Category: model.AgentCategoryBusinessProcessing,
		Prompt: "你是作战值班助手", Enabled: true, SortOrder: 100,
	}
	if err := st.CreateAgent(ctx, a); err != nil {
		t.Fatalf("CreateAgent: %v", err)
	}
	got, err := st.GetAgent(ctx, "agent_biz_1")
	if err != nil || got == nil {
		t.Fatalf("GetAgent: %#v %v", got, err)
	}
	if got.Category != model.AgentCategoryBusinessProcessing || got.Prompt != "你是作战值班助手" {
		t.Fatalf("round-trip = %#v", got)
	}
	// Upsert of a software-development agent backfills its category.
	sw := model.Agent{
		ID: "agent_legacy", Key: "legacy", Name: "Legacy", Role: "code_generation",
		Description: "old", Category: model.AgentCategorySoftwareDevelopment, Prompt: "",
		Enabled: true, SortOrder: 1,
	}
	if err := st.UpsertAgent(ctx, sw); err != nil {
		t.Fatalf("UpsertAgent: %v", err)
	}
	gotSw, _ := st.GetAgent(ctx, "agent_legacy")
	if gotSw.Category != model.AgentCategorySoftwareDevelopment || gotSw.Prompt != "" {
		t.Fatalf("sw round-trip = %#v", gotSw)
	}
}

// TestLegacyClarificationBackfillDialogue asserts BackfillClarificationDialogues
// creates exactly one application_generation dialogue per legacy session with a
// sensible parent status, links it, and is idempotent on a second run.
func TestLegacyClarificationBackfillDialogue(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	now := time.Now()
	sessions := []model.ClarificationSession{
		{ID: "clar_active", Status: model.ClarificationStatusActive, InitialPrompt: "进行中", Round: 1, MaxRounds: 3, RequirementJSON: `{}`, CreatedAt: now, UpdatedAt: now},
		{ID: "clar_conf", Status: model.ClarificationStatusConfirmed, InitialPrompt: "已确认", Round: 2, MaxRounds: 3, RequirementJSON: `{}`, CreatedJobID: "job_conf", CreatedAt: now, UpdatedAt: now},
		{ID: "clar_fail", Status: model.ClarificationStatusFailed, InitialPrompt: "失败", Round: 1, MaxRounds: 3, RequirementJSON: `{}`, CreatedAt: now, UpdatedAt: now},
		{ID: "clar_aban", Status: model.ClarificationStatusAbandoned, InitialPrompt: "放弃", Round: 1, MaxRounds: 3, RequirementJSON: `{}`, CreatedAt: now, UpdatedAt: now},
	}
	for _, s := range sessions {
		if err := st.CreateClarificationSession(ctx, s); err != nil {
			t.Fatalf("create %s: %v", s.ID, err)
		}
	}

	if err := st.BackfillClarificationDialogues(ctx); err != nil {
		t.Fatalf("BackfillClarificationDialogues: %v", err)
	}
	// Each session linked to exactly one dialogue.
	wantStatus := map[string]model.DialogueStatus{
		"clar_active": model.DialogueStatusDraftingApplication,
		"clar_conf":   model.DialogueStatusResolved,
		"clar_fail":   model.DialogueStatusFailed,
		"clar_aban":   model.DialogueStatusAbandoned,
	}
	for clarID, want := range wantStatus {
		dlgID, ok := st.FindDialogueByClarificationID(ctx, clarID)
		if !ok {
			t.Fatalf("no dialogue linked for %s", clarID)
		}
		got, _ := st.GetDialogueSession(ctx, dlgID)
		if got == nil {
			t.Fatalf("dialogue %s missing", dlgID)
		}
		if got.Intent != model.DialogueIntentApplicationGeneration {
			t.Fatalf("%s intent = %q", clarID, got.Intent)
		}
		if got.Status != want {
			t.Fatalf("%s status = %q, want %q", clarID, got.Status, want)
		}
		if !got.RouteLocked {
			t.Fatalf("%s route not locked", clarID)
		}
	}

	// Idempotent: re-running must not duplicate.
	if err := st.BackfillClarificationDialogues(ctx); err != nil {
		t.Fatalf("second backfill: %v", err)
	}
	all, _ := st.ListDialogueSessions(ctx, 200)
	if len(all) != 4 {
		t.Fatalf("after re-run len = %d, want 4", len(all))
	}
}

func TestReconcileDialogueClarificationFailures(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	now := time.Now()
	child := model.ClarificationSession{
		ID: "clar_failed_linked", Status: model.ClarificationStatusFailed,
		InitialPrompt: "生成一个todo", Round: 5, MaxRounds: 6, RequirementJSON: `{}`,
		ErrorCode: string(model.ErrorOutputInvalidJSON), ErrorMessage: "decode clarification output",
		CreatedAt: now, UpdatedAt: now,
	}
	if err := st.CreateClarificationSession(ctx, child); err != nil {
		t.Fatalf("create clarification: %v", err)
	}
	dlg := model.DialogueSession{
		ID: "dlg_failed_linked", InitialPrompt: "生成一个todo",
		Status: model.DialogueStatusDraftingApplication, Intent: model.DialogueIntentApplicationGeneration,
		RouteLocked: true, ClarificationSessionID: child.ID, CreatedAt: now, UpdatedAt: now,
	}
	if err := st.CreateDialogueSession(ctx, dlg); err != nil {
		t.Fatalf("create dialogue: %v", err)
	}

	if err := st.ReconcileDialogueClarificationFailures(ctx); err != nil {
		t.Fatalf("ReconcileDialogueClarificationFailures: %v", err)
	}
	got, err := st.GetDialogueSession(ctx, dlg.ID)
	if err != nil || got == nil {
		t.Fatalf("get dialogue: %v", err)
	}
	if got.Status != model.DialogueStatusFailed {
		t.Fatalf("status = %q, want failed", got.Status)
	}
	if got.ErrorCode != string(model.ErrorOutputInvalidJSON) || got.ErrorMessage == "" {
		t.Fatalf("error = %q/%q, want child failure propagated", got.ErrorCode, got.ErrorMessage)
	}
}

// TestLegacyClarificationBackfillExceedsListCap asserts the backfill visits
// EVERY legacy session even when there are more than the ListClarificationSessions
// cap of 200. A deployment with >200 rows must not silently leave the oldest
// sessions without a parent dialogue, and re-running must stay idempotent.
func TestLegacyClarificationBackfillExceedsListCap(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	now := time.Now()

	// Insert more than the 200-row list cap.
	const total = 250
	for i := 0; i < total; i++ {
		cs := model.ClarificationSession{
			ID:            fmt.Sprintf("clar_cap_%03d", i),
			Status:        model.ClarificationStatusActive,
			InitialPrompt: "legacy prompt",
			Round:         0,
			MaxRounds:     3,
			CreatedAt:     now.Add(time.Duration(i) * time.Microsecond),
			UpdatedAt:     now.Add(time.Duration(i) * time.Microsecond),
		}
		if err := st.CreateClarificationSession(ctx, cs); err != nil {
			t.Fatalf("create %s: %v", cs.ID, err)
		}
	}

	// Sanity: the capped list would miss rows.
	capped, _ := st.ListClarificationSessions(ctx, 200)
	if len(capped) != 200 {
		t.Fatalf("capped list len = %d, want 200 (test precondition)", len(capped))
	}

	// First backfill: every one of the 250 sessions gets a dialogue.
	if err := st.BackfillClarificationDialogues(ctx); err != nil {
		t.Fatalf("BackfillClarificationDialogues: %v", err)
	}
	for i := 0; i < total; i++ {
		clarID := fmt.Sprintf("clar_cap_%03d", i)
		dlgID, ok := st.FindDialogueByClarificationID(ctx, clarID)
		if !ok {
			t.Fatalf("no dialogue linked for %s (oldest rows not backfilled)", clarID)
		}
		if _, err := st.GetDialogueSession(ctx, dlgID); err != nil {
			t.Fatalf("dialogue %s for %s missing: %v", dlgID, clarID, err)
		}
	}

	// Second backfill: idempotent, count unchanged, no duplicates.
	if err := st.BackfillClarificationDialogues(ctx); err != nil {
		t.Fatalf("second backfill: %v", err)
	}
	gotCount := 0
	for i := 0; i < total; i++ {
		clarID := fmt.Sprintf("clar_cap_%03d", i)
		if _, ok := st.FindDialogueByClarificationID(ctx, clarID); ok {
			gotCount++
		}
	}
	if gotCount != total {
		t.Fatalf("dialogue count after re-run = %d, want %d (not idempotent or missing rows)", gotCount, total)
	}
}

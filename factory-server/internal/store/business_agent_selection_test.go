package store

import (
	"context"
	"strings"
	"testing"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

func TestReplaceClarificationBusinessAgentsPersistsOrder(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	for _, a := range []model.Agent{
		{ID: "agent_a", Key: "a", Name: "A", Role: "business", Category: model.AgentCategoryBusiness, Prompt: "A prompt", Editable: true, Enabled: true, SortOrder: 100},
		{ID: "agent_b", Key: "b", Name: "B", Role: "business", Category: model.AgentCategoryBusiness, Prompt: "B prompt", Editable: true, Enabled: true, SortOrder: 101},
	} {
		if err := st.CreateAgent(ctx, a); err != nil {
			t.Fatalf("create agent %s: %v", a.ID, err)
		}
	}
	if err := st.ReplaceClarificationBusinessAgents(ctx, "clar_1", []string{"agent_b", "agent_a"}); err != nil {
		t.Fatalf("replace: %v", err)
	}
	got, err := st.ListClarificationBusinessAgents(ctx, "clar_1")
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(got) != 2 || got[0].ID != "agent_b" || got[1].ID != "agent_a" {
		t.Fatalf("got = %+v", got)
	}
}

func TestReplaceClarificationBusinessAgentsRejectsInvalidSelections(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	if err := st.CreateAgent(ctx, model.Agent{
		ID: "agent_disabled", Key: "disabled", Name: "Disabled", Role: "business",
		Category: model.AgentCategoryBusiness, Prompt: "prompt", Editable: true, Enabled: false, SortOrder: 100,
	}); err != nil {
		t.Fatalf("create disabled: %v", err)
	}
	if err := st.UpsertAgent(ctx, model.Agent{
		ID: "agent_requirement_analyst", Key: "requirement-analyst", Name: "需求分析", Role: "requirement_analysis",
		Category: model.AgentCategorySoftware, Prompt: "prompt", Editable: false, Enabled: true, SortOrder: 1,
	}); err != nil {
		t.Fatalf("create software: %v", err)
	}

	if err := st.ReplaceClarificationBusinessAgents(ctx, "clar_1", []string{"agent_disabled"}); err == nil {
		t.Fatal("disabled business agent selection succeeded, want error")
	}
	if err := st.ReplaceClarificationBusinessAgents(ctx, "clar_1", []string{"agent_requirement_analyst"}); err == nil {
		t.Fatal("software agent selection succeeded, want error")
	}
	if err := st.ReplaceClarificationBusinessAgents(ctx, "clar_1", []string{"missing"}); err == nil {
		t.Fatal("missing agent selection succeeded, want error")
	}
	if err := st.ReplaceClarificationBusinessAgents(ctx, "clar_1", []string{"agent_disabled", "agent_disabled"}); err == nil {
		t.Fatal("duplicate selection succeeded, want error")
	}
}

func TestBusinessAgentSnapshotsJSON(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	for _, a := range []model.Agent{
		{ID: "agent_a", Key: "a", Name: "A", Description: "A desc", Role: "business", Category: model.AgentCategoryBusiness, Prompt: "A prompt", Editable: true, Enabled: true, SortOrder: 100},
		{ID: "agent_b", Key: "b", Name: "B", Description: "B desc", Role: "business", Category: model.AgentCategoryBusiness, Prompt: "B prompt", Editable: true, Enabled: true, SortOrder: 101},
	} {
		if err := st.CreateAgent(ctx, a); err != nil {
			t.Fatalf("create agent %s: %v", a.ID, err)
		}
	}
	if err := st.ReplaceClarificationBusinessAgents(ctx, "clar_1", []string{"agent_b", "agent_a"}); err != nil {
		t.Fatalf("replace: %v", err)
	}
	raw, err := st.BusinessAgentSnapshotsJSON(ctx, "clar_1")
	if err != nil {
		t.Fatalf("snapshot: %v", err)
	}
	if !strings.Contains(raw, `"id":"agent_b"`) || !strings.Contains(raw, `"prompt":"A prompt"`) {
		t.Fatalf("snapshot json = %s", raw)
	}
	if strings.Index(raw, `"id":"agent_b"`) > strings.Index(raw, `"id":"agent_a"`) {
		t.Fatalf("snapshot order = %s, want agent_b before agent_a", raw)
	}
}

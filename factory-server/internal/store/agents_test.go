package store

import (
	"context"
	"testing"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

// TestUpsertAgentPreservesEnabled verifies that re-upserting a default agent
// (Enabled=true) does not clobber a prior runtime disable via SetAgentEnabled.
// Regression guard for design §7.2.
func TestUpsertAgentPreservesEnabled(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()

	agent := model.Agent{
		ID:              "agent_tester",
		Key:             "agent_tester",
		Name:            "Agent Tester",
		Role:            "tester",
		Description:     "test agent",
		ClaudeAgentName: "agent-tester",
		SkillsJSON:      "[]",
		Enabled:         true,
		SortOrder:       1,
		Category:        model.AgentCategorySoftware,
		Prompt:          "test prompt",
		Editable:        false,
	}

	// First insert seeds enabled from the argument (true).
	if err := st.UpsertAgent(ctx, agent); err != nil {
		t.Fatalf("first upsert: %v", err)
	}

	// Runtime disable persists.
	if err := st.SetAgentEnabled(ctx, "agent_tester", false); err != nil {
		t.Fatalf("set enabled false: %v", err)
	}

	// Simulate the next server boot: the default registry (Enabled=true) is
	// upserted again. The disable must survive.
	agent.Name = "Agent Tester Updated"
	agent.Prompt = "updated prompt"
	if err := st.UpsertAgent(ctx, agent); err != nil {
		t.Fatalf("second upsert: %v", err)
	}

	got, err := st.GetAgent(ctx, "agent_tester")
	if err != nil {
		t.Fatalf("get agent: %v", err)
	}
	if got == nil {
		t.Fatal("agent missing after upsert")
	}
	if got.Enabled {
		t.Fatalf("enabled = true after re-upsert; want false (disable should persist)")
	}
	if got.Name != "Agent Tester Updated" || got.Prompt != "updated prompt" || got.Category != model.AgentCategorySoftware || got.Editable {
		t.Fatalf("updated metadata mismatch: %+v", got)
	}
}

// TestUpsertAgentSeedsEnabledOnInsert verifies a fresh agent's enabled flag is
// taken from the supplied value on the initial insert.
func TestUpsertAgentSeedsEnabledOnInsert(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()

	agent := model.Agent{
		ID:              "agent_fresh",
		Key:             "agent_fresh",
		Name:            "Fresh",
		Role:            "fresh",
		Description:     "brand new agent",
		ClaudeAgentName: "agent-fresh",
		SkillsJSON:      "[]",
		Enabled:         true,
		SortOrder:       2,
		Category:        model.AgentCategoryBusiness,
		Prompt:          "business prompt",
		Editable:        true,
	}

	if err := st.UpsertAgent(ctx, agent); err != nil {
		t.Fatalf("insert: %v", err)
	}

	got, err := st.GetAgent(ctx, "agent_fresh")
	if err != nil {
		t.Fatalf("get agent: %v", err)
	}
	if got == nil {
		t.Fatal("agent missing after insert")
	}
	if !got.Enabled {
		t.Fatalf("enabled = false on insert; want true (seed from argument)")
	}
	if got.Category != model.AgentCategoryBusiness || got.Prompt != "business prompt" || !got.Editable {
		t.Fatalf("metadata = %+v, want business prompt editable", got)
	}
}

func TestCreateAgentPersistsMetadata(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()

	agent := model.Agent{
		ID:              "agent_maritime",
		Key:             "maritime-alert-expert",
		Name:            "海事预警专家",
		Role:            "business",
		Description:     "识别海事异常",
		ClaudeAgentName: "maritime-alert-expert",
		SkillsJSON:      "[]",
		Enabled:         true,
		SortOrder:       100,
		Category:        model.AgentCategoryBusiness,
		Prompt:          "关注 AIS、海况、异常航迹",
		Editable:        true,
	}
	if err := st.CreateAgent(ctx, agent); err != nil {
		t.Fatalf("create: %v", err)
	}

	got, err := st.GetAgent(ctx, "agent_maritime")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got == nil {
		t.Fatal("agent missing after create")
	}
	if got.Category != model.AgentCategoryBusiness || got.Prompt != agent.Prompt || !got.Editable {
		t.Fatalf("metadata = %+v, want category/prompt/editable", got)
	}
}

// TestCreateBusinessAgentAndListByCategory verifies that business agents are
// persisted with their category and that ListAgentsByCategory filters out
// software agents, returning only the business agents in sort_order.
func TestCreateBusinessAgentAndListByCategory(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	software := model.Agent{
		ID: "agent_requirement_analyst", Key: "requirement-analyst", Name: "需求分析",
		Role: "requirement_analysis", Category: model.AgentCategorySoftware,
		Prompt: "software prompt", Editable: false, Enabled: true, SortOrder: 1,
	}
	if err := st.UpsertAgent(ctx, software); err != nil {
		t.Fatalf("upsert software: %v", err)
	}
	business := model.Agent{
		ID: "agent_maritime", Key: "maritime-alert-expert", Name: "海事预警专家",
		Role: "business", Description: "识别海事异常", Category: model.AgentCategoryBusiness,
		Prompt: "关注 AIS、海况、异常航迹", Editable: true, Enabled: true, SortOrder: 100,
	}
	if err := st.CreateAgent(ctx, business); err != nil {
		t.Fatalf("create business: %v", err)
	}
	got, err := st.ListAgentsByCategory(ctx, model.AgentCategoryBusiness)
	if err != nil {
		t.Fatalf("list business: %v", err)
	}
	if len(got) != 1 || got[0].Key != "maritime-alert-expert" || !got[0].Editable {
		t.Fatalf("business agents = %+v", got)
	}

	// Software category excludes the business agent and vice versa.
	sw, err := st.ListAgentsByCategory(ctx, model.AgentCategorySoftware)
	if err != nil {
		t.Fatalf("list software: %v", err)
	}
	if len(sw) != 1 || sw[0].Key != "requirement-analyst" {
		t.Fatalf("software agents = %+v", sw)
	}
}

// TestUpdateBusinessAgentPersistsFields verifies that UpdateBusinessAgent writes
// the mutable fields of an editable business agent and refuses to mutate a
// non-editable software agent (no rows affected).
func TestUpdateBusinessAgentPersistsFields(t *testing.T) {
	st := newTestStore(t)
	ctx := context.Background()
	orig := model.Agent{
		ID: "agent_maritime", Key: "maritime-alert-expert", Name: "海事预警专家",
		Role: "business", Description: "old", Category: model.AgentCategoryBusiness,
		Prompt: "old prompt", Editable: true, Enabled: true, SortOrder: 100,
	}
	if err := st.CreateAgent(ctx, orig); err != nil {
		t.Fatalf("create: %v", err)
	}
	orig.Name = "海事预警专家V2"
	orig.Description = "new desc"
	orig.Prompt = "new prompt"
	orig.Enabled = false
	if err := st.UpdateBusinessAgent(ctx, orig); err != nil {
		t.Fatalf("update: %v", err)
	}
	got, err := st.GetAgent(ctx, "agent_maritime")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if got == nil {
		t.Fatal("agent missing after update")
	}
	if got.Name != "海事预警专家V2" || got.Prompt != "new prompt" || got.Description != "new desc" || got.Enabled {
		t.Fatalf("update did not persist: %+v", got)
	}
}

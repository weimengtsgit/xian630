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

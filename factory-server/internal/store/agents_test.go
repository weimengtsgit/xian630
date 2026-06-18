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
}

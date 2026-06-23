package agents

import (
	"strings"
	"testing"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

func TestDefaultRegistryContainsSixSoftwareAgents(t *testing.T) {
	agents := DefaultRegistry()
	keys := map[string]bool{}
	for _, agent := range agents {
		keys[agent.Key] = true
		if agent.Category != model.AgentCategorySoftware {
			t.Fatalf("%s category = %q, want software", agent.Key, agent.Category)
		}
		if agent.Editable {
			t.Fatalf("%s editable = true, want false", agent.Key)
		}
		if strings.TrimSpace(agent.Prompt) == "" {
			t.Fatalf("%s prompt is empty", agent.Key)
		}
	}
	for _, key := range []string{
		"requirement-analyst",
		"solution-designer",
		"code-generator",
		"tester",
		"image-builder",
		"deployer",
	} {
		if !keys[key] {
			t.Fatalf("missing agent key %s", key)
		}
	}
	if len(agents) != 6 {
		t.Fatalf("len = %d, want 6", len(agents))
	}
}

// TestDefaultRegistryOrderAndClaudeNames asserts the stable id, sort_order, and
// claude_agent_name values that the design pins for the six software agents.
func TestDefaultRegistryOrderAndClaudeNames(t *testing.T) {
	agents := DefaultRegistry()
	want := []struct {
		id, key, claude string
		sortOrder       int
	}{
		{"agent_requirement_analyst", "requirement-analyst", "requirement-analyst", 1},
		{"agent_solution_designer", "solution-designer", "solution-designer", 2},
		{"agent_code_generator", "code-generator", "code-generator", 3},
		{"agent_tester", "tester", "tester", 4},
		{"agent_image_builder", "image-builder", "image-builder", 5},
		{"agent_deployer", "deployer", "deployer", 6},
	}
	for i, w := range want {
		got := agents[i]
		if got.ID != w.id || got.Key != w.key || got.ClaudeAgentName != w.claude || got.SortOrder != w.sortOrder {
			t.Fatalf("agent[%d] = {ID:%s Key:%s Claude:%s Sort:%d}, want {%s %s %s %d}",
				i, got.ID, got.Key, got.ClaudeAgentName, got.SortOrder,
				w.id, w.key, w.claude, w.sortOrder)
		}
		if !got.Enabled {
			t.Fatalf("agent %s: Enabled = false, want true", got.Key)
		}
	}
}

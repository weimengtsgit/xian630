package agents

import (
	"testing"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

func TestDefaultRegistryContainsFixedAgents(t *testing.T) {
	as := DefaultRegistry()
	keys := map[string]bool{}
	for _, agent := range as {
		keys[agent.Key] = true
	}
	for _, key := range []string{
		"collaboration-orchestrator",
		"requirement-analyst",
		"domain-analyst",
		"designer",
		"data-integration",
		"solution-designer",
		"code-generator",
		"code-reviewer",
		"security-reviewer",
		"tester",
		"product-acceptance",
		"image-builder",
		"deployer",
	} {
		if !keys[key] {
			t.Fatalf("missing agent key %s", key)
		}
	}
}

// TestDefaultRegistryStableIDsAndOrder asserts the stable id, sort_order,
// claude_agent_name and category values that the design pins for the
// collaboration pipeline agents. The combined build-deploy agent was split back
// into image-builder (image_build role) and deployer (deployment role).
func TestDefaultRegistryStableIDsAndOrder(t *testing.T) {
	as := DefaultRegistry()
	if len(as) != 13 {
		t.Fatalf("len = %d, want 13", len(as))
	}
	want := []struct {
		id, key, claude string
		sortOrder       int
	}{
		{"agent_collaboration_orchestrator", "collaboration-orchestrator", "collaboration-orchestrator", 1},
		{"agent_requirement_analyst", "requirement-analyst", "requirement-analyst", 2},
		{"agent_domain_analyst", "domain-analyst", "domain-analyst", 3},
		{"agent_designer", "designer", "designer", 4},
		{"agent_data_integration", "data-integration", "data-integration", 5},
		{"agent_solution_designer", "solution-designer", "solution-designer", 6},
		{"agent_code_generator", "code-generator", "code-generator", 7},
		{"agent_code_reviewer", "code-reviewer", "code-reviewer", 8},
		{"agent_security_reviewer", "security-reviewer", "security-reviewer", 9},
		{"agent_tester", "tester", "tester", 10},
		{"agent_product_acceptance", "product-acceptance", "product-acceptance", 11},
		{"agent_image_builder", "image-builder", "image-builder", 12},
		{"agent_deployer", "deployer", "deployer", 13},
	}
	for i, w := range want {
		got := as[i]
		if got.ID != w.id || got.Key != w.key || got.ClaudeAgentName != w.claude || got.SortOrder != w.sortOrder {
			t.Fatalf("agent[%d] = {ID:%s Key:%s Claude:%s Sort:%d}, want {%s %s %s %d}",
				i, got.ID, got.Key, got.ClaudeAgentName, got.SortOrder,
				w.id, w.key, w.claude, w.sortOrder)
		}
		if !got.Enabled {
			t.Fatalf("agent %s: Enabled = false, want true", got.Key)
		}
		if got.Category != model.AgentCategorySoftwareDevelopment {
			t.Fatalf("agent %s: Category = %q, want %q", got.Key, got.Category, model.AgentCategorySoftwareDevelopment)
		}
	}
}

func TestDefaultRegistryCarriesSelectedSkills(t *testing.T) {
	as := DefaultRegistry()
	skills := map[string]string{}
	for _, a := range as {
		skills[a.Key] = a.SkillsJSON
	}
	if skills["designer"] != `["defense-operations-ui","command-dashboard"]` {
		t.Fatalf("designer skills = %q", skills["designer"])
	}
	if skills["code-generator"] != `["software-factory-app"]` {
		t.Fatalf("code-generator skills = %q", skills["code-generator"])
	}
}

// TestDefaultRegistrySplitRoles asserts the image-builder/deployer split gives
// each its own distinct role (image_build vs deployment).
func TestDefaultRegistrySplitRoles(t *testing.T) {
	as := DefaultRegistry()
	roles := map[string]string{} // key -> role
	for _, a := range as {
		roles[a.Key] = a.Role
	}
	if roles["image-builder"] != "image_build" {
		t.Fatalf("image-builder role = %q, want image_build", roles["image-builder"])
	}
	if roles["deployer"] != "deployment" {
		t.Fatalf("deployer role = %q, want deployment", roles["deployer"])
	}
}

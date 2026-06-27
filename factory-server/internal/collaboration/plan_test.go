package collaboration

import "testing"

func TestDefaultPlanIncludesRequiredAgentsAndEdges(t *testing.T) {
	plan := DefaultPlan(RequirementContext{
		ConfirmedRequirementJSON: `{"appName":"航母复盘","judgementBoundary":{"dataSources":["ontology","public_web_search"]}}`,
	})
	keys := plan.AgentKeys()
	for _, want := range []string{
		"collaboration-orchestrator",
		"requirement-analyst",
		"domain-analyst",
		"designer",
		"data-integration",
		"solution-designer",
		"code-generator",
		"code-reviewer",
		"tester",
		"product-acceptance",
		"image-builder",
		"deployer",
	} {
		if !keys[want] {
			t.Fatalf("missing agent %s in plan: %+v", want, plan.Agents)
		}
	}
	if !plan.HasEdge("code-generator", "code-reviewer") {
		t.Fatalf("missing code-generator -> code-reviewer edge: %+v", plan.Edges)
	}
	if !plan.HasEdge("tester", "product-acceptance") {
		t.Fatalf("missing tester -> product-acceptance edge: %+v", plan.Edges)
	}
}

func TestDefaultPlanAddsSecurityReviewConditionally(t *testing.T) {
	plain := DefaultPlan(RequirementContext{ConfirmedRequirementJSON: `{"appName":"纯静态演示"}`})
	if plain.AgentKeys()["security-reviewer"] {
		t.Fatalf("plain plan should not include security-reviewer: %+v", plain.Agents)
	}
	secured := DefaultPlan(RequirementContext{ConfirmedRequirementJSON: `{"appName":"公网数据接入","judgementBoundary":{"dataSources":["public_web_search"]}}`})
	if !secured.AgentKeys()["security-reviewer"] {
		t.Fatalf("public web plan should include security-reviewer: %+v", secured.Agents)
	}
	if !secured.HasEdge("code-reviewer", "security-reviewer") {
		t.Fatalf("security reviewer must follow code reviewer: %+v", secured.Edges)
	}
	assertAgentBefore(t, secured, "security-reviewer", "tester")
}

func TestDefaultPlanAppliesRemoveAgentAdjustment(t *testing.T) {
	plan := DefaultPlan(RequirementContext{ConfirmedRequirementJSON: `{
		"appName":"跳过代码审查演示",
		"collaborationAdjustments":[{"action":"remove_agent","agentKey":"code-reviewer","warning":"用户确认跳过代码审查"}]
	}`})
	if plan.AgentKeys()["code-reviewer"] {
		t.Fatalf("code-reviewer should be removed by adjustment: %+v", plan.Agents)
	}
	if plan.HasEdge("code-generator", "code-reviewer") || plan.HasEdge("code-reviewer", "tester") {
		t.Fatalf("removed code-reviewer must not remain in edges: %+v", plan.Edges)
	}
	if !plan.HasEdge("code-generator", "tester") {
		t.Fatalf("remove adjustment should bridge code-generator -> tester: %+v", plan.Edges)
	}
}

func TestDefaultPlanAppliesAddSecurityReviewerAdjustment(t *testing.T) {
	plan := DefaultPlan(RequirementContext{ConfirmedRequirementJSON: `{
		"appName":"静态演示但要求安全审查",
		"collaborationAdjustments":[{"action":"add_agent","agentKey":"security-reviewer","warning":"用户要求增加安全审查"}]
	}`})
	if !plan.AgentKeys()["security-reviewer"] {
		t.Fatalf("security-reviewer should be added by adjustment: %+v", plan.Agents)
	}
	if !plan.HasEdge("code-reviewer", "security-reviewer") || !plan.HasEdge("security-reviewer", "tester") {
		t.Fatalf("added security reviewer should sit between code-reviewer and tester: %+v", plan.Edges)
	}
	assertAgentBefore(t, plan, "security-reviewer", "tester")
}

func TestDefaultPlanRecordsUnsupportedAddAgentAdjustment(t *testing.T) {
	plan := DefaultPlan(RequirementContext{ConfirmedRequirementJSON: `{
		"appName":"要求性能分析",
		"collaborationAdjustments":[{"action":"add_agent","agentKey":"performance-analyst","warning":"用户要求增加性能分析"}]
	}`})
	if plan.AgentKeys()["performance-analyst"] {
		t.Fatalf("unsupported agent should not be added: %+v", plan.Agents)
	}
	if len(plan.Adjustments) != 1 {
		t.Fatalf("adjustments = %+v, want one unsupported adjustment record", plan.Adjustments)
	}
	if got := plan.Adjustments[0].Message; got != "unsupported_add_agent:performance-analyst:用户要求增加性能分析" {
		t.Fatalf("adjustment message = %q", got)
	}
}

func TestDefaultPlanSerializesValidJSON(t *testing.T) {
	plan := DefaultPlan(RequirementContext{ConfirmedRequirementJSON: `{"appName":"demo"}`})
	raw, err := plan.JSON()
	if err != nil {
		t.Fatalf("JSON: %v", err)
	}
	if raw == "" || raw[0] != '{' {
		t.Fatalf("json = %q", raw)
	}
}

func assertAgentBefore(t *testing.T, plan Plan, before, after string) {
	t.Helper()
	beforeIdx, afterIdx := -1, -1
	for i, a := range plan.Agents {
		switch a.Key {
		case before:
			beforeIdx = i
		case after:
			afterIdx = i
		}
	}
	if beforeIdx < 0 || afterIdx < 0 || beforeIdx >= afterIdx {
		t.Fatalf("agent order should place %s before %s: %+v", before, after, plan.Agents)
	}
}

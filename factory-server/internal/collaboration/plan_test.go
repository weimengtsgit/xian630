package collaboration

import "testing"

func TestDefaultPlanTemporarilyDisablesGates(t *testing.T) {
	plan := DefaultPlan(RequirementContext{ConfirmedRequirementJSON: `{"appName":"demo"}`})
	keys := plan.AgentKeys()
	for _, disabled := range disabledGates {
		if keys[disabled] {
			t.Fatalf("%s should be temporarily disabled but is present: %+v", disabled, plan.Agents)
		}
	}
	// Connectivity must be preserved around each removed gate.
	if !plan.HasEdge("designer", "code-generator") || !plan.HasEdge("data-integration", "code-generator") {
		t.Fatalf("removed solution-designer must bridge designer/data-integration -> code-generator: %+v", plan.Edges)
	}
	if !plan.HasEdge("code-generator", "tester") {
		t.Fatalf("removed code-reviewer must bridge code-generator -> tester: %+v", plan.Edges)
	}
	if !plan.HasEdge("tester", "image-builder") {
		t.Fatalf("removed product-acceptance must bridge tester -> image-builder: %+v", plan.Edges)
	}
}

func TestDefaultPlanIncludesRequiredAgentsAndEdges(t *testing.T) {
	plan := DefaultPlan(RequirementContext{
		ConfirmedRequirementJSON: `{"appName":"航母复盘","judgementBoundary":{"dataSources":["ontology"]}}`,
	})
	keys := plan.AgentKeys()
	for _, want := range []string{
		"requirement-analyst",
		"designer",
		"data-integration",
		"code-generator",
		"tester",
		"image-builder",
		"deployer",
	} {
		if !keys[want] {
			t.Fatalf("missing agent %s in plan: %+v", want, plan.Agents)
		}
	}
	// The disabled gates (solution-designer/code-reviewer/product-acceptance)
	// are bridged: code-generator flows straight into tester, tester into image-builder.
	if !plan.HasEdge("code-generator", "tester") {
		t.Fatalf("missing code-generator -> tester edge: %+v", plan.Edges)
	}
	if !plan.HasEdge("tester", "image-builder") {
		t.Fatalf("missing tester -> image-builder edge: %+v", plan.Edges)
	}
	for _, agent := range plan.Agents {
		if agent.Key == "designer" && agent.Name != "界面设计" {
			t.Fatalf("designer agent name = %q, want 界面设计", agent.Name)
		}
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
	if !secured.HasEdge("code-generator", "security-reviewer") {
		t.Fatalf("security reviewer must follow code-generator (code-reviewer is disabled): %+v", secured.Edges)
	}
	assertAgentBefore(t, secured, "security-reviewer", "tester")
}

func TestDefaultPlanAppliesRemoveAgentAdjustment(t *testing.T) {
	plan := DefaultPlan(RequirementContext{ConfirmedRequirementJSON: `{
		"appName":"跳过测试验证演示",
		"collaborationAdjustments":[{"action":"remove_agent","agentKey":"tester","warning":"用户确认跳过测试验证"}]
	}`})
	if plan.AgentKeys()["tester"] {
		t.Fatalf("tester should be removed by adjustment: %+v", plan.Agents)
	}
	if plan.HasEdge("code-generator", "tester") || plan.HasEdge("tester", "image-builder") {
		t.Fatalf("removed tester must not remain in edges: %+v", plan.Edges)
	}
	if !plan.HasEdge("code-generator", "image-builder") {
		t.Fatalf("remove adjustment should bridge code-generator -> image-builder: %+v", plan.Edges)
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
	if !plan.HasEdge("code-generator", "security-reviewer") || !plan.HasEdge("security-reviewer", "tester") {
		t.Fatalf("added security reviewer should sit between code-generator and tester (code-reviewer is disabled): %+v", plan.Edges)
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

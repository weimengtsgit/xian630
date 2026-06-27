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

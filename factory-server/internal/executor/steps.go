// Package executor drives the fixed six-step factory pipeline: it picks the
// oldest queued job, advances its current step through the runner, and records
// the resulting transitions (queued → running → succeeded|failed|waiting_user|
// canceled) in the store. The actual step runners (Claude agents, factory build
// & deploy) land in Tasks 11/12 and satisfy StepRunner; until then the server
// injects a stub.
package executor

import "github.com/weimengtsgit/xian630/factory-server/internal/model"

// Step mode: which engine runs a step. design §4.
const (
	ModeClaude                            = "claude"
	ModeFactory                           = "factory"
	ModeFactoryWithOptionalClaudeAnalysis = "factory_with_optional_claude_analysis"
)

// StepDefinition is one fixed slot in the pipeline. Seq is 1-indexed; Mode is
// one of the Mode* constants.
type StepDefinition struct {
	Kind     model.StepKind
	Seq      int
	AgentKey string
	Mode     string
}

// FixedSteps returns the canonical six-step pipeline in execution order. The
// kind/seq/agent_key mirror the job-step seeding in the createJob handler; the
// mode tells the (future) runner how to dispatch each step.
func FixedSteps() []StepDefinition {
	return []StepDefinition{
		{Kind: model.StepRequirementAnalysis, Seq: 1, AgentKey: "requirement-analyst", Mode: ModeClaude},
		{Kind: model.StepSolutionDesign, Seq: 2, AgentKey: "solution-designer", Mode: ModeClaude},
		{Kind: model.StepCodeGeneration, Seq: 3, AgentKey: "code-generator", Mode: ModeClaude},
		{Kind: model.StepTestVerification, Seq: 4, AgentKey: "tester", Mode: ModeFactoryWithOptionalClaudeAnalysis},
		{Kind: model.StepImageBuild, Seq: 5, AgentKey: "image-builder", Mode: ModeFactory},
		{Kind: model.StepDeployment, Seq: 6, AgentKey: "deployer", Mode: ModeFactory},
	}
}

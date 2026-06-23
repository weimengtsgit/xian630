package executor

import (
	"testing"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

func TestFixedSteps(t *testing.T) {
	steps := FixedSteps()
	if len(steps) != 6 {
		t.Fatalf("len = %d", len(steps))
	}
	if steps[0].Kind != model.StepRequirementAnalysis || steps[0].AgentKey != "requirement-analyst" {
		t.Fatalf("first step = %#v", steps[0])
	}
	if steps[4].Kind != model.StepImageBuild || steps[4].AgentKey != "image-builder" {
		t.Fatalf("image build step = %#v", steps[4])
	}
	if steps[5].Kind != model.StepDeployment || steps[5].AgentKey != "deployer" {
		t.Fatalf("last step = %#v", steps[5])
	}
}

// TestFixedStepsModes asserts the per-step dispatch mode (design §4).
func TestFixedStepsModes(t *testing.T) {
	steps := FixedSteps()
	want := []string{
		ModeClaude,
		ModeClaude,
		ModeClaude,
		ModeFactoryWithOptionalClaudeAnalysis,
		ModeFactory,
		ModeFactory,
	}
	for i, w := range want {
		if steps[i].Mode != w {
			t.Fatalf("step %d (%s) mode = %q, want %q", i, steps[i].Kind, steps[i].Mode, w)
		}
		if steps[i].Seq != i+1 {
			t.Fatalf("step %d seq = %d, want %d", i, steps[i].Seq, i+1)
		}
	}
}

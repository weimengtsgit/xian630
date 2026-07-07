package runner

import (
	"strings"
	"testing"
)

func TestPrototypeHardConstraints(t *testing.T) {
	contract := []byte(`{
		"prototypeStatus": "confirmed",
		"downstreamConstraintLevel": "hard_constraint",
		"prototype": {
			"constraints": ["需覆盖桌面和移动端", "不得伪装 mock 数据"],
			"responsiveRules": ["桌面端：三栏", "移动端（<768px）：底部 Tab 导航，地图首屏 60%"]
		}
	}`)
	got := PrototypeHardConstraints(contract)
	// 2 constraints + 2 responsiveRules.
	if len(got) != 4 {
		t.Fatalf("expected 4 hard constraints, got %d: %v", len(got), got)
	}
	joined := strings.Join(got, "|")
	for _, want := range []string{"需覆盖桌面和移动端", "底部 Tab 导航"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("hard constraints must preserve source text; missing %q in %q", want, joined)
		}
	}
}

func TestPrototypeHardConstraintsEmpty(t *testing.T) {
	if got := PrototypeHardConstraints(nil); got != nil {
		t.Fatalf("nil input → nil, got %v", got)
	}
	if got := PrototypeHardConstraints([]byte("{}")); len(got) != 0 {
		t.Fatalf("empty contract → empty, got %v", got)
	}
}

func TestFormatPrototypeConstraintBlock(t *testing.T) {
	s := FormatPrototypeConstraintBlock([]string{"移动端（<768px）：底部 Tab 导航", "不得 mock"}, "hard_constraint")
	if s == "" {
		t.Fatalf("expected non-empty block")
	}
	if !strings.Contains(s, "底部 Tab 导航") {
		t.Fatalf("block must inline the constraint text verbatim, got %q", s)
	}
	if !strings.Contains(s, "违反") {
		t.Fatalf("block must frame violation as generation failure, got %q", s)
	}
	if !strings.Contains(s, "acknowledgedConstraints") {
		t.Fatalf("block must tell the agent to echo into acknowledgedConstraints, got %q", s)
	}
}

func TestFormatPrototypeConstraintBlockEmpty(t *testing.T) {
	if s := FormatPrototypeConstraintBlock(nil, "hard_constraint"); s != "" {
		t.Fatalf("no constraints → empty block, got %q", s)
	}
}

func TestValidatePrototypeAck(t *testing.T) {
	constraints := []string{"rule A", "rule B", "rule C"}
	cases := []struct {
		name string
		ack  []string
		ok   bool
	}{
		{"covers all", []string{"ack A", "ack B", "ack C"}, true},
		{"too few", []string{"ack A", "ack B"}, false},
		{"empty entry", []string{"ack A", "", "ack C"}, false},
		{"none when required", nil, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := ValidatePrototypeAck(constraints, tc.ack)
			if tc.ok && err != nil {
				t.Fatalf("expected pass, got %v", err)
			}
			if !tc.ok && err == nil {
				t.Fatalf("expected fail for ack=%v, got pass", tc.ack)
			}
		})
	}
}

func TestValidatePrototypeAckNoConstraints(t *testing.T) {
	// No prototype contract → nothing to acknowledge → always passes.
	if err := ValidatePrototypeAck(nil, nil); err != nil {
		t.Fatalf("expected pass when no constraints, got %v", err)
	}
}

package runner

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
)

// prototypeContractShape is the slice of prototype-contract.json that is
// load-bearing for downstream code-generation hard constraints.
type prototypeContractShape struct {
	Prototype struct {
		Constraints     []string `json:"constraints"`
		ResponsiveRules []string `json:"responsiveRules"`
	} `json:"prototype"`
}

// PrototypeHardConstraints extracts the hard constraints from a
// prototype-contract.json byte slice: prototype.constraints followed by
// prototype.responsiveRules (the responsive viewport rules are where mobile
// bottom-tab / map-height requirements live). Returns nil when the bytes are
// empty/unreadable or the fields are absent.
func PrototypeHardConstraints(contract []byte) []string {
	if len(bytes.TrimSpace(contract)) == 0 {
		return nil
	}
	var shape prototypeContractShape
	if err := json.Unmarshal(contract, &shape); err != nil {
		return nil
	}
	out := make([]string, 0, len(shape.Prototype.Constraints)+len(shape.Prototype.ResponsiveRules))
	out = append(out, shape.Prototype.Constraints...)
	out = append(out, shape.Prototype.ResponsiveRules...)
	if len(out) == 0 {
		return nil
	}
	return out
}

// FormatPrototypeConstraintBlock formats the hard constraints into an INLINE
// prompt block so code_generation cannot skip them. Delivering only a file
// path (as the older prototypeContextPromptBlock did) lets the generating LLM
// skip the Read — observed in production as code_gen never opening
// prototype-contract.json and so omitting the mobile bottom-tab rule.
func FormatPrototypeConstraintBlock(constraints []string, level string) string {
	if len(constraints) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString("\n\n[prototype 原型硬约束 — 违反即判定生成失败]\n")
	b.WriteString("以下为已确认原型契约的硬约束（downstreamConstraintLevel=" + level + "），生成必须逐条遵循：\n")
	for i, c := range constraints {
		b.WriteString(fmt.Sprintf("- %d. %s\n", i+1, c))
	}
	b.WriteString("output.json 的 acknowledgedConstraints 必须逐条复述上述约束（每条一行，顺序对应），缺失即 schema_validation_failed。")
	return b.String()
}

// ValidatePrototypeAck returns an error if ack does not cover every hard
// constraint — one non-empty ack entry per constraint (the responsiveRules
// count as constraints here). This forces code_generation to actually read and
// echo the contract instead of skip-reading it. Returns nil when there are no
// contract constraints (no confirmed prototype → nothing to acknowledge).
func ValidatePrototypeAck(constraints, ack []string) error {
	if len(constraints) == 0 {
		return nil
	}
	if len(ack) < len(constraints) {
		return fmt.Errorf("acknowledgedConstraints covers %d of %d prototype hard constraints — echo each constraint/responsiveRule: %w", len(ack), len(constraints), ErrSchemaValidationFailed)
	}
	for i, a := range ack {
		if strings.TrimSpace(a) == "" {
			return fmt.Errorf("acknowledgedConstraints[%d] is empty — every prototype hard constraint must be echoed: %w", i, ErrSchemaValidationFailed)
		}
	}
	return nil
}

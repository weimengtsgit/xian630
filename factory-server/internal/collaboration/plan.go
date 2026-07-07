package collaboration

import (
	"encoding/json"
	"strings"
)

type RequirementContext struct {
	ConfirmedRequirementJSON string
}

type Plan struct {
	SchemaVersion           int                `json:"schemaVersion"`
	Mode                    string             `json:"mode"`
	Lanes                   []Lane             `json:"lanes"`
	ExecutionPolicy         ExecutionPolicy    `json:"executionPolicy"`
	RepairPolicy            RepairPolicy       `json:"repairPolicy"`
	Agents                  []Agent            `json:"agents"`
	Edges                   []Edge             `json:"edges"`
	HighImpactConfirmations []HighImpactRecord `json:"highImpactConfirmations,omitempty"`
	Adjustments             []Adjustment       `json:"adjustments,omitempty"`
}

type Lane struct {
	ID    string `json:"id"`
	Label string `json:"label"`
}

type RepairPolicy struct {
	MaxAutomaticRepairs                  int `json:"maxAutomaticRepairs"`
	MaxAutomaticRepairsPerBlockingReason int `json:"maxAutomaticRepairsPerBlockingReason"`
}

type ExecutionPolicy struct {
	ManualStepConfirmation bool `json:"manualStepConfirmation"`
}

type Agent struct {
	Key                  string   `json:"key"`
	Name                 string   `json:"name"`
	Role                 string   `json:"role"`
	Lane                 string   `json:"lane"`
	HighImpact           bool     `json:"highImpact"`
	DefaultParticipation string   `json:"defaultParticipation"`
	Description          string   `json:"description"`
	Snapshot             Snapshot `json:"snapshot"`
}

type Snapshot struct {
	AgentKey       string          `json:"agentKey,omitempty"`
	Name           string          `json:"name,omitempty"`
	Description    string          `json:"description,omitempty"`
	Lane           string          `json:"lane,omitempty"`
	Instructions   string          `json:"instructions"`
	SelectedSkills []string        `json:"selectedSkills"`
	SkillOverrides []SkillOverride `json:"skillOverrides"`
}

type SkillOverride struct {
	Path    string `json:"path"`
	Content string `json:"content"`
	Scope   string `json:"scope"`
}

type Edge struct {
	From string `json:"from"`
	To   string `json:"to"`
}

type HighImpactRecord struct {
	AgentKey  string `json:"agentKey"`
	Action    string `json:"action"`
	Confirmed bool   `json:"confirmed"`
	Reason    string `json:"reason"`
}

type Adjustment struct {
	Source    string `json:"source"`
	Message   string `json:"message"`
	AppliedAt string `json:"appliedAt"`
}

type AdjustmentRequest struct {
	Action     string `json:"action"`
	AgentKey   string `json:"agentKey"`
	HighImpact bool   `json:"highImpact,omitempty"`
	Warning    string `json:"warning,omitempty"`
}

func DefaultPlan(ctx RequirementContext) Plan {
	agents := []Agent{
		agent("collaboration-orchestrator", "协作编排", "collaboration_orchestration", "analysis", false, "生成默认协作计划、解释选择依据、记录用户调整。", "根据确认需求摘要生成协作计划，并记录用户调整。", nil),
		agent("requirement-analyst", "需求分析", "requirement_analysis", "analysis", true, "整理用户需求并形成确认需求摘要。", "校验确认需求摘要完整性和高影响事项。", nil),
		agent("domain-analyst", "领域分析", "domain_analysis", "analysis", false, "注入领域知识和客户判断口径。", "解释生成能力包、场景蓝本、数据来源边界和客户判断口径。", nil),
		agent("designer", "设计", "design_contract", "analysis", false, "产出结构化设计契约。", "输出视图、布局、组件、交互状态、数据绑定和响应式约束。", []string{"defense-operations-ui", "command-dashboard"}),
		agent("data-integration", "数据接入", "data_integration", "analysis", true, "产出真实数据接入计划和演示数据契约。", "区分真实数据来源、运行时连接器、不可用数据行为和演示数据契约。", nil),
		agent("solution-designer", "方案设计", "solution_design", "generation", false, "形成技术方案、文件计划和实现边界。", "汇总需求、领域、设计和数据契约。", nil),
		agent("code-generator", "代码生成", "code_generation", "generation", true, "写入应用代码并生成 manifest。", "根据确认需求和契约生成可构建应用。", []string{"software-factory-app"}),
		agent("code-reviewer", "代码审查", "code_review", "generation", true, "阻断式质量门禁。", "只阻断明确可执行且影响正确性、可部署性、数据诚实、安全或用户行为的问题。", nil),
		agent("tester", "测试验证", "test_verification", "delivery", true, "运行或分析构建与测试结果。", "执行测试验证并产出诊断摘要。", nil),
		agent("product-acceptance", "产品验收", "product_acceptance", "delivery", true, "检查生成结果是否满足需求、设计和数据契约。", "对照确认需求摘要、设计契约、数据契约和主要流程验收。", nil),
		agent("image-builder", "镜像构建", "image_build", "delivery", true, "构建应用容器镜像。", "构建容器镜像并记录构建输出。", nil),
		agent("deployer", "部署", "deployment", "delivery", true, "部署容器并完成健康验证。", "部署应用并验证运行时健康。", nil),
	}
	edges := []Edge{
		{"collaboration-orchestrator", "requirement-analyst"},
		{"requirement-analyst", "domain-analyst"},
		{"requirement-analyst", "designer"},
		{"requirement-analyst", "data-integration"},
		{"domain-analyst", "solution-designer"},
		{"designer", "solution-designer"},
		{"data-integration", "solution-designer"},
		{"solution-designer", "code-generator"},
		{"code-generator", "code-reviewer"},
		{"code-reviewer", "tester"},
		{"tester", "product-acceptance"},
		{"product-acceptance", "image-builder"},
		{"image-builder", "deployer"},
	}
	if needsSecurityReview(ctx.ConfirmedRequirementJSON) {
		agents = insertAgentAfter(agents, "code-reviewer", securityReviewerAgent())
		edges = insertBetween(edges, "code-reviewer", "security-reviewer", "tester")
	}
	plan := Plan{
		SchemaVersion: 1,
		Mode:          "topological_serial",
		Lanes: []Lane{
			{"analysis", "需求 / 领域 / 设计 / 数据"},
			{"generation", "生成 / 审查 / 修复"},
			{"delivery", "验证 / 构建 / 部署"},
		},
		ExecutionPolicy: executionPolicyFromRequirement(ctx.ConfirmedRequirementJSON),
		RepairPolicy:    RepairPolicy{MaxAutomaticRepairs: 2, MaxAutomaticRepairsPerBlockingReason: 1},
		Agents:          agents,
		Edges:           edges,
	}
	return applyAdjustments(plan, adjustmentsFromRequirement(ctx.ConfirmedRequirementJSON))
}

func agent(key, name, role, lane string, highImpact bool, desc, instructions string, skills []string) Agent {
	if skills == nil {
		skills = []string{}
	}
	return Agent{
		Key: key, Name: name, Role: role, Lane: lane, HighImpact: highImpact,
		DefaultParticipation: "required", Description: desc,
		Snapshot: Snapshot{
			AgentKey: key, Name: name, Description: desc, Lane: lane,
			Instructions: instructions, SelectedSkills: skills, SkillOverrides: []SkillOverride{},
		},
	}
}

func needsSecurityReview(raw string) bool {
	lower := strings.ToLower(raw)
	for _, needle := range []string{"public_web_search", "公网", "认证", "auth", "upload", "上传", "external", "敏感", "permission", "权限"} {
		if strings.Contains(lower, needle) {
			return true
		}
	}
	return false
}

func replaceEdge(edges []Edge, from, to string, replacement []Edge) []Edge {
	out := make([]Edge, 0, len(edges)+len(replacement))
	for _, edge := range edges {
		if edge.From == from && edge.To == to {
			out = append(out, replacement...)
			continue
		}
		out = append(out, edge)
	}
	return out
}

func adjustmentsFromRequirement(raw string) []AdjustmentRequest {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	var doc struct {
		CollaborationAdjustments []AdjustmentRequest `json:"collaborationAdjustments"`
	}
	if err := json.Unmarshal([]byte(raw), &doc); err != nil {
		return nil
	}
	return doc.CollaborationAdjustments
}

func executionPolicyFromRequirement(raw string) ExecutionPolicy {
	if strings.TrimSpace(raw) == "" {
		return ExecutionPolicy{}
	}
	var doc struct {
		ExecutionPolicy ExecutionPolicy `json:"executionPolicy"`
	}
	if err := json.Unmarshal([]byte(raw), &doc); err != nil {
		return ExecutionPolicy{}
	}
	return doc.ExecutionPolicy
}

func applyAdjustments(plan Plan, requests []AdjustmentRequest) Plan {
	for _, req := range requests {
		action := strings.ToLower(strings.TrimSpace(req.Action))
		key := strings.TrimSpace(req.AgentKey)
		if key == "" {
			continue
		}
		switch action {
		case "remove_agent", "remove":
			if plan.AgentKeys()[key] {
				plan = removeAgent(plan, key)
				plan.Adjustments = append(plan.Adjustments, Adjustment{Source: "requirement", Message: adjustmentMessage("remove_agent", key, req.Warning), AppliedAt: "plan_build"})
			}
		case "add_agent", "add":
			if plan.AgentKeys()[key] {
				continue
			}
			if key == "security-reviewer" {
				plan.Agents = insertAgentAfter(plan.Agents, "code-reviewer", securityReviewerAgent())
				plan.Edges = insertBetween(plan.Edges, "code-reviewer", "security-reviewer", "tester")
				plan.Adjustments = append(plan.Adjustments, Adjustment{Source: "requirement", Message: adjustmentMessage("add_agent", key, req.Warning), AppliedAt: "plan_build"})
				continue
			}
			plan.Adjustments = append(plan.Adjustments, Adjustment{Source: "requirement", Message: adjustmentMessage("unsupported_add_agent", key, req.Warning), AppliedAt: "plan_build"})
		}
	}
	return plan
}

func adjustmentMessage(action, key, warning string) string {
	if strings.TrimSpace(warning) != "" {
		return action + ":" + key + ":" + strings.TrimSpace(warning)
	}
	return action + ":" + key
}

func securityReviewerAgent() Agent {
	return agent("security-reviewer", "安全审查", "security_review", "generation", true, "检查安全和权限风险。", "检查公网数据、认证、上传、外部接口、敏感数据、权限和暴露部署面。", nil)
}

func insertAgentAfter(agents []Agent, afterKey string, newAgent Agent) []Agent {
	for _, a := range agents {
		if a.Key == newAgent.Key {
			return agents
		}
	}
	out := make([]Agent, 0, len(agents)+1)
	inserted := false
	for _, a := range agents {
		out = append(out, a)
		if a.Key == afterKey {
			out = append(out, newAgent)
			inserted = true
		}
	}
	if !inserted {
		out = append(out, newAgent)
	}
	return out
}

func insertBetween(edges []Edge, from, middle, to string) []Edge {
	return dedupeEdges(replaceEdge(edges, from, to, []Edge{{from, middle}, {middle, to}}))
}

func removeAgent(plan Plan, key string) Plan {
	preds := make([]string, 0)
	succs := make([]string, 0)
	for _, edge := range plan.Edges {
		if edge.To == key {
			preds = append(preds, edge.From)
		}
		if edge.From == key {
			succs = append(succs, edge.To)
		}
	}

	agents := make([]Agent, 0, len(plan.Agents))
	for _, a := range plan.Agents {
		if a.Key != key {
			agents = append(agents, a)
		}
	}
	plan.Agents = agents

	live := plan.AgentKeys()
	edges := make([]Edge, 0, len(plan.Edges)+len(preds)*len(succs))
	for _, edge := range plan.Edges {
		if edge.From == key || edge.To == key {
			continue
		}
		if live[edge.From] && live[edge.To] {
			edges = append(edges, edge)
		}
	}
	for _, pred := range preds {
		for _, succ := range succs {
			if pred != succ && live[pred] && live[succ] {
				edges = append(edges, Edge{From: pred, To: succ})
			}
		}
	}
	plan.Edges = dedupeEdges(edges)
	return plan
}

func dedupeEdges(edges []Edge) []Edge {
	out := make([]Edge, 0, len(edges))
	seen := map[Edge]bool{}
	for _, edge := range edges {
		if edge.From == "" || edge.To == "" || seen[edge] {
			continue
		}
		seen[edge] = true
		out = append(out, edge)
	}
	return out
}

func (p Plan) AgentKeys() map[string]bool {
	out := map[string]bool{}
	for _, a := range p.Agents {
		out[a.Key] = true
	}
	return out
}

func (p Plan) HasEdge(from, to string) bool {
	for _, e := range p.Edges {
		if e.From == from && e.To == to {
			return true
		}
	}
	return false
}

func (p Plan) JSON() (string, error) {
	b, err := json.Marshal(p)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

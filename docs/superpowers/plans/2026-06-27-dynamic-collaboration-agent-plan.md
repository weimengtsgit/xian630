# Dynamic Collaboration Agent Plan Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the user-visible fixed six-stage generation task surface with a persisted, user-confirmed collaboration-agent plan whose cards, dependencies, editable snapshots, gates, and bounded repair behavior can be replayed and audited.

**Architecture:** Keep `job_steps` as the execution node and audit anchor so existing execution records, artifacts, drawers, and SSE updates remain attached to `step_id`. Add task-level collaboration plan metadata plus explicit step dependency edges, then migrate creation, display, editing, gates, and repair in stages while preserving the current fixed six-step path as a compatibility baseline.

**Tech Stack:** Go 1.21, SQLite, `net/http`, existing factory executor/store patterns, React 18, Vite, local logic-check scripts, project-local Claude skills.

---

## Source References

- Glossary: `CONTEXT.md` (`协作智能体`, `协作智能体参与计划`, `协作智能体配置快照`, `高影响协作智能体`, `代码审查门禁`, `有界自动修复回路`).
- ADR: `docs/adr/0008-dynamic-collaboration-agent-plan.md`.
- Target design: `docs/claude-skills-and-agents.md` section `协作智能体目标模型`.
- Current registry: `factory-server/internal/agents/registry.go`.
- Current fixed step plan: `factory-server/internal/server/job_handlers.go` `stepPlan`.
- Executor step order: `factory-server/internal/executor/steps.go` `FixedSteps`.
- Job/store schema: `factory-server/internal/store/schema.sql`, `factory-server/internal/store/jobs.go`, `factory-server/internal/model/model.go`.
- Current task UI: `sf-portal-mvp/src/components/JobCenter.jsx`, `StepCard.jsx`, `StepExecutionDrawer.jsx`, `sf-portal-mvp/src/hooks/executionRecordState.js`.
- Current repair path: `factory-server/internal/executor/executor.go` `RepairFromFailure`, `repairableFailureKind`.
- Current API client: `sf-portal-mvp/src/api/client.js`.

## File Structure

Create:

```text
factory-server/internal/collaboration/plan.go
factory-server/internal/collaboration/plan_test.go
factory-server/internal/store/collaboration_plans.go
factory-server/internal/store/collaboration_plans_test.go
sf-portal-mvp/src/hooks/collaborationPlanState.js
sf-portal-mvp/scripts/check-collaboration-plan.mjs
```

Modify:

```text
factory-server/internal/model/model.go
factory-server/internal/store/schema.sql
factory-server/internal/store/store.go
factory-server/internal/store/jobs.go
factory-server/internal/store/jobs_test.go
factory-server/internal/server/job_handlers.go
factory-server/internal/server/job_handlers_test.go
factory-server/internal/server/clarification_handlers.go
factory-server/internal/server/dialogue_handlers.go
factory-server/internal/server/server.go
factory-server/internal/executor/steps.go
factory-server/internal/executor/executor.go
factory-server/internal/executor/executor_test.go
factory-server/internal/executor/claude_runner.go
factory-server/internal/executor/fake_claude.go
sf-portal-mvp/src/api/client.js
sf-portal-mvp/src/components/JobCenter.jsx
sf-portal-mvp/src/components/StepCard.jsx
sf-portal-mvp/src/components/StepExecutionDrawer.jsx
sf-portal-mvp/src/hooks/executionRecordState.js
sf-portal-mvp/package.json
docs/claude-skills-and-agents.md
```

## Data Contracts

Use these concrete JSON shapes consistently across backend, frontend, tests, and docs.

### `jobs.collaboration_plan_json`

```json
{
  "schemaVersion": 1,
  "mode": "topological_serial",
  "lanes": [
    {"id": "analysis", "label": "需求 / 领域 / 设计 / 数据"},
    {"id": "generation", "label": "生成 / 审查 / 修复"},
    {"id": "delivery", "label": "验证 / 构建 / 部署"}
  ],
  "repairPolicy": {
    "maxAutomaticRepairs": 2,
    "maxAutomaticRepairsPerBlockingReason": 1
  },
  "agents": [
    {
      "key": "collaboration-orchestrator",
      "name": "协作编排",
      "role": "collaboration_orchestration",
      "lane": "analysis",
      "highImpact": false,
      "defaultParticipation": "required",
      "description": "生成默认协作计划、解释选择依据、记录用户调整。",
      "snapshot": {
        "instructions": "根据确认需求摘要生成协作计划，并记录用户调整。",
        "selectedSkills": [],
        "skillOverrides": []
      }
    }
  ],
  "edges": [
    {"from": "collaboration-orchestrator", "to": "requirement-analyst"}
  ],
  "highImpactConfirmations": [
    {
      "agentKey": "code-reviewer",
      "action": "removed",
      "confirmed": true,
      "reason": "用户明确选择移除代码审查门禁。"
    }
  ],
  "adjustments": [
    {
      "source": "user",
      "message": "不需要安全审查",
      "appliedAt": "2026-06-27T00:00:00Z"
    }
  ]
}
```

### `job_step_edges`

```json
[
  {"from_step_id": "step_a", "to_step_id": "step_b"}
]
```

### `job_steps.snapshot_json`

```json
{
  "agentKey": "designer",
  "name": "设计",
  "description": "产出结构化设计契约。",
  "lane": "analysis",
  "highImpact": false,
  "instructions": "输出 viewInventory、layout、components、states、dataBindings。",
  "selectedSkills": ["defense-operations-ui", "command-dashboard"],
  "skillOverrides": [
    {
      "path": ".claude/skills/command-dashboard/SKILL.md",
      "content": "本次任务覆盖后的 skill 内容",
      "scope": "task"
    }
  ]
}
```

## Task 1: Persist collaboration plan metadata and dependency edges

**Files:**

- Modify: `factory-server/internal/model/model.go`
- Modify: `factory-server/internal/store/schema.sql`
- Modify: `factory-server/internal/store/store.go`
- Modify: `factory-server/internal/store/jobs.go`
- Create: `factory-server/internal/store/collaboration_plans.go`
- Create: `factory-server/internal/store/collaboration_plans_test.go`

- [ ] **Step 1: Write failing store tests for job plan and edges.**

Add `factory-server/internal/store/collaboration_plans_test.go`:

```go
package store

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

func TestCollaborationPlanRoundTrip(t *testing.T) {
	st, err := Open(":memory:")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })

	now := time.Now()
	job := model.Job{
		ID: "job_plan", UserPrompt: "生成复盘智能体", Status: model.JobStatusQueued,
		CurrentStepKind: model.StepKind("collaboration_orchestration"),
		ConfirmedRequirementJSON: `{"appName":"复盘智能体"}`,
		CollaborationPlanJSON: `{"schemaVersion":1,"mode":"topological_serial","agents":[],"edges":[]}`,
		CreatedAt: now, UpdatedAt: now,
	}
	if err := st.CreateJob(context.Background(), job); err != nil {
		t.Fatalf("CreateJob: %v", err)
	}

	got, err := st.GetJob(context.Background(), job.ID)
	if err != nil || got == nil {
		t.Fatalf("GetJob: got=%#v err=%v", got, err)
	}
	if got.CollaborationPlanJSON != job.CollaborationPlanJSON {
		t.Fatalf("CollaborationPlanJSON = %q, want %q", got.CollaborationPlanJSON, job.CollaborationPlanJSON)
	}
	var decoded map[string]any
	if err := json.Unmarshal([]byte(got.CollaborationPlanJSON), &decoded); err != nil {
		t.Fatalf("plan json invalid: %v", err)
	}
}

func TestJobStepSnapshotAndEdgesRoundTrip(t *testing.T) {
	st, err := Open(":memory:")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })

	now := time.Now()
	job := model.Job{
		ID: "job_edges", UserPrompt: "生成", Status: model.JobStatusQueued,
		CurrentStepKind: model.StepKind("collaboration_orchestration"),
		ConfirmedRequirementJSON: `{}`, CreatedAt: now, UpdatedAt: now,
	}
	if err := st.CreateJob(context.Background(), job); err != nil {
		t.Fatalf("CreateJob: %v", err)
	}
	stepA := model.JobStep{
		ID: "step_a", JobID: job.ID, Kind: model.StepKind("collaboration_orchestration"),
		Seq: 1, AgentKey: "collaboration-orchestrator", Status: model.StepStatusPending,
		SnapshotJSON: `{"agentKey":"collaboration-orchestrator","lane":"analysis"}`,
	}
	stepB := model.JobStep{
		ID: "step_b", JobID: job.ID, Kind: model.StepKind("requirement_analysis"),
		Seq: 2, AgentKey: "requirement-analyst", Status: model.StepStatusPending,
		SnapshotJSON: `{"agentKey":"requirement-analyst","lane":"analysis"}`,
	}
	if err := st.CreateJobStep(context.Background(), stepA); err != nil {
		t.Fatalf("CreateJobStep A: %v", err)
	}
	if err := st.CreateJobStep(context.Background(), stepB); err != nil {
		t.Fatalf("CreateJobStep B: %v", err)
	}
	if err := st.CreateJobStepEdge(context.Background(), model.JobStepEdge{
		JobID: job.ID, FromStepID: stepA.ID, ToStepID: stepB.ID,
	}); err != nil {
		t.Fatalf("CreateJobStepEdge: %v", err)
	}

	steps, err := st.ListJobSteps(context.Background(), job.ID)
	if err != nil {
		t.Fatalf("ListJobSteps: %v", err)
	}
	if len(steps) != 2 || steps[0].SnapshotJSON == "" || steps[1].SnapshotJSON == "" {
		t.Fatalf("steps snapshots not preserved: %+v", steps)
	}
	edges, err := st.ListJobStepEdges(context.Background(), job.ID)
	if err != nil {
		t.Fatalf("ListJobStepEdges: %v", err)
	}
	if len(edges) != 1 || edges[0].FromStepID != stepA.ID || edges[0].ToStepID != stepB.ID {
		t.Fatalf("edges = %+v, want A->B", edges)
	}
}
```

- [ ] **Step 2: Run tests and verify they fail.**

Run:

```bash
cd factory-server && go test ./internal/store -run 'TestCollaborationPlanRoundTrip|TestJobStepSnapshotAndEdgesRoundTrip'
```

Expected: compile fails because `CollaborationPlanJSON`, `SnapshotJSON`, `JobStepEdge`, and store methods do not exist.

- [ ] **Step 3: Add model fields and edge type.**

In `factory-server/internal/model/model.go`, extend `Job`, `JobStep`, and add `JobStepEdge`:

```go
// CollaborationPlanJSON is the persisted, user-confirmed collaboration-agent
// plan for this generation task. Empty means legacy fixed-step job.
CollaborationPlanJSON string `json:"collaboration_plan_json,omitempty"`
```

```go
// SnapshotJSON is the per-task collaboration-agent configuration snapshot
// used by this step. Empty means legacy fixed-step behavior.
SnapshotJSON string `json:"snapshot_json,omitempty"`
```

```go
type JobStepEdge struct {
	JobID      string `json:"job_id"`
	FromStepID string `json:"from_step_id"`
	ToStepID   string `json:"to_step_id"`
}
```

- [ ] **Step 4: Add schema and migrations.**

In `factory-server/internal/store/schema.sql`, add:

```sql
    collaboration_plan_json TEXT NOT NULL DEFAULT ''
```

to `jobs`, add:

```sql
    snapshot_json TEXT NOT NULL DEFAULT ''
```

to `job_steps`, and add:

```sql
CREATE TABLE IF NOT EXISTS job_step_edges (
    job_id       TEXT NOT NULL,
    from_step_id TEXT NOT NULL,
    to_step_id   TEXT NOT NULL,
    PRIMARY KEY(job_id, from_step_id, to_step_id)
);
CREATE INDEX IF NOT EXISTS idx_job_step_edges_job
ON job_step_edges(job_id);
```

In `factory-server/internal/store/store.go`, add `ensureColumn` migrations:

```go
if err := s.ensureColumn(ctx, "jobs", "collaboration_plan_json",
	`ALTER TABLE jobs ADD COLUMN collaboration_plan_json TEXT NOT NULL DEFAULT ''`); err != nil {
	return nil, fmt.Errorf("migrate jobs.collaboration_plan_json: %w", err)
}
if err := s.ensureColumn(ctx, "job_steps", "snapshot_json",
	`ALTER TABLE job_steps ADD COLUMN snapshot_json TEXT NOT NULL DEFAULT ''`); err != nil {
	return nil, fmt.Errorf("migrate job_steps.snapshot_json: %w", err)
}
```

and execute the `CREATE TABLE IF NOT EXISTS job_step_edges` statement during open.

- [ ] **Step 5: Wire create/scan SQL.**

Update `CreateJob`, `createJobInTx`, and job scan queries in `factory-server/internal/store/jobs.go` so `collaboration_plan_json` is inserted and scanned. Update `CreateJobStep`, `createJobStepInTx`, and step scan queries so `snapshot_json` is inserted and scanned.

The insert column lists must include:

```sql
collaboration_plan_json
```

for jobs and:

```sql
snapshot_json
```

for job steps.

- [ ] **Step 6: Implement edge store methods.**

Create `factory-server/internal/store/collaboration_plans.go`:

```go
package store

import (
	"context"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

func (s *Store) CreateJobStepEdge(ctx context.Context, edge model.JobStepEdge) error {
	_, err := s.db.ExecContext(ctx, `
INSERT INTO job_step_edges(job_id, from_step_id, to_step_id)
VALUES(?,?,?)`,
		edge.JobID, edge.FromStepID, edge.ToStepID)
	return err
}

func (s *Store) ListJobStepEdges(ctx context.Context, jobID string) ([]model.JobStepEdge, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT job_id, from_step_id, to_step_id
FROM job_step_edges
WHERE job_id = ?
ORDER BY from_step_id, to_step_id`, jobID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]model.JobStepEdge, 0)
	for rows.Next() {
		var edge model.JobStepEdge
		if err := rows.Scan(&edge.JobID, &edge.FromStepID, &edge.ToStepID); err != nil {
			return nil, err
		}
		out = append(out, edge)
	}
	return out, rows.Err()
}
```

- [ ] **Step 7: Run store tests.**

Run:

```bash
cd factory-server && go test ./internal/store
```

Expected: PASS.

- [ ] **Step 8: Commit.**

```bash
git add factory-server/internal/model/model.go factory-server/internal/store/schema.sql factory-server/internal/store/store.go factory-server/internal/store/jobs.go factory-server/internal/store/collaboration_plans.go factory-server/internal/store/collaboration_plans_test.go
git commit -m "feat: persist collaboration task plans"
```

## Task 2: Build default collaboration plans and seed dynamic steps

**Files:**

- Create: `factory-server/internal/collaboration/plan.go`
- Create: `factory-server/internal/collaboration/plan_test.go`
- Modify: `factory-server/internal/server/job_handlers.go`
- Modify: `factory-server/internal/server/job_handlers_test.go`
- Modify: `factory-server/internal/server/clarification_handlers.go`
- Modify: `factory-server/internal/server/dialogue_handlers.go`
- Modify: `docs/claude-skills-and-agents.md`

- [ ] **Step 1: Write failing collaboration plan tests.**

Create `factory-server/internal/collaboration/plan_test.go`:

```go
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
```

- [ ] **Step 2: Run tests and verify failure.**

Run:

```bash
cd factory-server && go test ./internal/collaboration
```

Expected: FAIL because the package does not exist.

- [ ] **Step 3: Implement collaboration plan builder.**

Create `factory-server/internal/collaboration/plan.go` with concrete plan types and defaults:

```go
package collaboration

import (
	"encoding/json"
	"strings"
)

type RequirementContext struct {
	ConfirmedRequirementJSON string
}

type Plan struct {
	SchemaVersion          int                  `json:"schemaVersion"`
	Mode                   string               `json:"mode"`
	Lanes                  []Lane               `json:"lanes"`
	RepairPolicy           RepairPolicy         `json:"repairPolicy"`
	Agents                 []Agent              `json:"agents"`
	Edges                  []Edge               `json:"edges"`
	HighImpactConfirmations []HighImpactRecord  `json:"highImpactConfirmations,omitempty"`
	Adjustments            []Adjustment         `json:"adjustments,omitempty"`
}

type Lane struct {
	ID    string `json:"id"`
	Label string `json:"label"`
}

type RepairPolicy struct {
	MaxAutomaticRepairs                  int `json:"maxAutomaticRepairs"`
	MaxAutomaticRepairsPerBlockingReason int `json:"maxAutomaticRepairsPerBlockingReason"`
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
		agents = append(agents, agent("security-reviewer", "安全审查", "security_review", "generation", true, "检查安全和权限风险。", "检查公网数据、认证、上传、外部接口、敏感数据、权限和暴露部署面。", nil))
		edges = replaceEdge(edges, "code-reviewer", "tester", []Edge{
			{"code-reviewer", "security-reviewer"},
			{"security-reviewer", "tester"},
		})
	}
	return Plan{
		SchemaVersion: 1,
		Mode: "topological_serial",
		Lanes: []Lane{
			{"analysis", "需求 / 领域 / 设计 / 数据"},
			{"generation", "生成 / 审查 / 修复"},
			{"delivery", "验证 / 构建 / 部署"},
		},
		RepairPolicy: RepairPolicy{MaxAutomaticRepairs: 2, MaxAutomaticRepairsPerBlockingReason: 1},
		Agents: agents,
		Edges: edges,
	}
}

func agent(key, name, role, lane string, highImpact bool, desc, instructions string, skills []string) Agent {
	if skills == nil {
		skills = []string{}
	}
	return Agent{
		Key: key, Name: name, Role: role, Lane: lane, HighImpact: highImpact,
		DefaultParticipation: "required", Description: desc,
		Snapshot: Snapshot{Instructions: instructions, SelectedSkills: skills, SkillOverrides: []SkillOverride{}},
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
```

- [ ] **Step 4: Run collaboration tests.**

Run:

```bash
cd factory-server && go test ./internal/collaboration
```

Expected: PASS.

- [ ] **Step 5: Write failing server test for dynamic job steps.**

In `factory-server/internal/server/job_handlers_test.go`, add:

```go
func TestCreateJobSeedsCollaborationPlanSteps(t *testing.T) {
	_, r, st := newJobsTestServer(t, config.Config{})

	rec := createJobViaAPI(t, r, "生成公网数据研判智能体")
	if rec.Code != http.StatusCreated {
		t.Fatalf("create status = %d, body=%s", rec.Code, rec.Body.String())
	}
	var job model.Job
	if err := json.NewDecoder(rec.Body).Decode(&job); err != nil {
		t.Fatalf("decode job: %v", err)
	}
	if job.CollaborationPlanJSON == "" {
		t.Fatalf("CollaborationPlanJSON empty")
	}
	steps, err := st.ListJobSteps(context.Background(), job.ID)
	if err != nil {
		t.Fatalf("ListJobSteps: %v", err)
	}
	if len(steps) < 12 {
		t.Fatalf("steps = %d, want collaboration plan steps", len(steps))
	}
	if steps[0].AgentKey != "collaboration-orchestrator" || steps[0].SnapshotJSON == "" {
		t.Fatalf("first step = %+v, want collaboration orchestrator with snapshot", steps[0])
	}
	edges, err := st.ListJobStepEdges(context.Background(), job.ID)
	if err != nil {
		t.Fatalf("ListJobStepEdges: %v", err)
	}
	if len(edges) == 0 {
		t.Fatalf("expected dependency edges")
	}
}
```

- [ ] **Step 6: Run server test and verify failure.**

Run:

```bash
cd factory-server && go test ./internal/server -run TestCreateJobSeedsCollaborationPlanSteps
```

Expected: FAIL because `createJob` still uses the fixed `stepPlan`.

- [ ] **Step 7: Add plan-to-steps seeding helper.**

In `factory-server/internal/server/job_handlers.go`, import `internal/collaboration` and add:

```go
func collaborationSteps(jobID string, plan collaboration.Plan) ([]model.JobStep, []model.JobStepEdge, error) {
	keyToStepID := make(map[string]string, len(plan.Agents))
	steps := make([]model.JobStep, 0, len(plan.Agents))
	for i, agent := range plan.Agents {
		stepID := "step_" + idpkg.New()
		keyToStepID[agent.Key] = stepID
		snapshotBytes, err := json.Marshal(agent.Snapshot)
		if err != nil {
			return nil, nil, err
		}
		steps = append(steps, model.JobStep{
			ID: stepID, JobID: jobID, Kind: model.StepKind(agent.Role), Seq: i + 1,
			AgentKey: agent.Key, Status: model.StepStatusPending, Attempt: 0,
			SnapshotJSON: string(snapshotBytes),
		})
	}
	edges := make([]model.JobStepEdge, 0, len(plan.Edges))
	for _, edge := range plan.Edges {
		fromID := keyToStepID[edge.From]
		toID := keyToStepID[edge.To]
		if fromID == "" || toID == "" {
			return nil, nil, fmt.Errorf("unknown collaboration edge %s -> %s", edge.From, edge.To)
		}
		edges = append(edges, model.JobStepEdge{JobID: jobID, FromStepID: fromID, ToStepID: toID})
	}
	return steps, edges, nil
}
```

- [ ] **Step 8: Seed dynamic plan in job creation paths.**

In `createJob`, `confirmClarification`, and dialogue confirmation job creation paths:

```go
plan := collaboration.DefaultPlan(collaboration.RequirementContext{ConfirmedRequirementJSON: body.ConfirmedRequirementJSON})
planJSON, err := plan.JSON()
if err != nil {
	writeError(w, http.StatusInternalServerError, "build collaboration plan")
	return
}
job.CollaborationPlanJSON = planJSON
steps, edges, err := collaborationSteps(jobID, plan)
if err != nil {
	writeError(w, http.StatusInternalServerError, "build collaboration steps")
	return
}
```

For paths that currently call `SeedJob` with only steps, add a store method or use an existing transaction variant that inserts both steps and edges. The call must commit the job, steps, and edges atomically.

- [ ] **Step 9: Preserve legacy compatibility tests by renaming expectations.**

Update `TestCreateJobCreatesFixedSteps` to assert the legacy fixed step plan only when `CollaborationPlanJSON == ""`, then add `TestCreateJobSeedsCollaborationPlanSteps` as the new default. Do not delete existing tests that protect status, prompt, and confirmed requirement behavior.

- [ ] **Step 10: Run backend tests.**

Run:

```bash
cd factory-server && go test ./internal/collaboration ./internal/store ./internal/server
```

Expected: PASS.

- [ ] **Step 11: Commit.**

```bash
git add factory-server/internal/collaboration/plan.go factory-server/internal/collaboration/plan_test.go factory-server/internal/server/job_handlers.go factory-server/internal/server/job_handlers_test.go factory-server/internal/server/clarification_handlers.go factory-server/internal/server/dialogue_handlers.go docs/claude-skills-and-agents.md
git commit -m "feat: seed dynamic collaboration plans"
```

## Task 3: Expose collaboration plans through the API

**Files:**

- Modify: `factory-server/internal/server/job_handlers.go`
- Modify: `factory-server/internal/server/job_handlers_test.go`
- Modify: `factory-server/internal/server/server.go`
- Modify: `sf-portal-mvp/src/api/client.js`

- [ ] **Step 1: Write failing API tests.**

Add to `factory-server/internal/server/job_handlers_test.go`:

```go
func TestGetJobCollaborationPlan(t *testing.T) {
	_, r, _ := newJobsTestServer(t, config.Config{})
	rec := createJobViaAPI(t, r, "生成公网数据研判智能体")
	if rec.Code != http.StatusCreated {
		t.Fatalf("create status = %d, body=%s", rec.Code, rec.Body.String())
	}
	var job model.Job
	if err := json.NewDecoder(rec.Body).Decode(&job); err != nil {
		t.Fatalf("decode job: %v", err)
	}

	planRec := doJSON(t, r, http.MethodGet, "/api/jobs/"+job.ID+"/collaboration-plan", nil)
	if planRec.Code != http.StatusOK {
		t.Fatalf("plan status = %d, body=%s", planRec.Code, planRec.Body.String())
	}
	var body struct {
		Plan  map[string]any        `json:"plan"`
		Edges []model.JobStepEdge   `json:"edges"`
		Steps []model.JobStep       `json:"steps"`
	}
	if err := json.NewDecoder(planRec.Body).Decode(&body); err != nil {
		t.Fatalf("decode plan response: %v", err)
	}
	if body.Plan["schemaVersion"] == nil || len(body.Steps) == 0 || len(body.Edges) == 0 {
		t.Fatalf("unexpected plan response: %+v", body)
	}
}

func TestGetJobCollaborationPlanMissingJob(t *testing.T) {
	_, r, _ := newJobsTestServer(t, config.Config{})
	rec := doJSON(t, r, http.MethodGet, "/api/jobs/missing/collaboration-plan", nil)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}
```

- [ ] **Step 2: Run API tests and verify failure.**

Run:

```bash
cd factory-server && go test ./internal/server -run 'TestGetJobCollaborationPlan'
```

Expected: FAIL because route does not exist.

- [ ] **Step 3: Implement handler and route.**

In `factory-server/internal/server/job_handlers.go`, add:

```go
func (s *Server) getJobCollaborationPlan(w http.ResponseWriter, r *http.Request) {
	id := Param(r, "id")
	job, err := s.store.GetJob(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "get job")
		return
	}
	if job == nil {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	steps, err := s.store.ListJobSteps(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "list steps")
		return
	}
	edges, err := s.store.ListJobStepEdges(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "list step edges")
		return
	}
	var plan any = map[string]any{}
	if strings.TrimSpace(job.CollaborationPlanJSON) != "" {
		if err := json.Unmarshal([]byte(job.CollaborationPlanJSON), &plan); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "invalid collaboration plan"})
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"job": job,
		"plan": plan,
		"steps": steps,
		"edges": edges,
	})
}
```

In `factory-server/internal/server/server.go`, add:

```go
r.Handle("GET", "/api/jobs/:id/collaboration-plan", s.getJobCollaborationPlan)
```

- [ ] **Step 4: Add frontend client method.**

In `sf-portal-mvp/src/api/client.js`, add:

```js
getJobCollaborationPlan: id => request(`/api/jobs/${id}/collaboration-plan`),
```

- [ ] **Step 5: Run backend tests.**

Run:

```bash
cd factory-server && go test ./internal/server -run 'TestGetJobCollaborationPlan'
```

Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add factory-server/internal/server/job_handlers.go factory-server/internal/server/job_handlers_test.go factory-server/internal/server/server.go sf-portal-mvp/src/api/client.js
git commit -m "feat: expose collaboration plans"
```

## Task 4: Render dynamic collaboration cards and lanes

**Files:**

- Create: `sf-portal-mvp/src/hooks/collaborationPlanState.js`
- Create: `sf-portal-mvp/scripts/check-collaboration-plan.mjs`
- Modify: `sf-portal-mvp/src/hooks/executionRecordState.js`
- Modify: `sf-portal-mvp/src/components/JobCenter.jsx`
- Modify: `sf-portal-mvp/src/components/StepCard.jsx`
- Modify: `sf-portal-mvp/package.json`

- [ ] **Step 1: Write failing frontend logic checks.**

Create `sf-portal-mvp/scripts/check-collaboration-plan.mjs`:

```js
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'

const jobCenter = readFileSync(new URL('../src/components/JobCenter.jsx', import.meta.url), 'utf8')
const state = readFileSync(new URL('../src/hooks/collaborationPlanState.js', import.meta.url), 'utf8')
const execState = readFileSync(new URL('../src/hooks/executionRecordState.js', import.meta.url), 'utf8')

assert.match(jobCenter, /collaborationLanes/, 'JobCenter should render collaboration lanes when a plan is available')
assert.match(jobCenter, /getJobCollaborationPlan|collaborationPlan/, 'JobCenter should consume collaboration plan data')
assert.match(state, /buildCollaborationCardView/, 'collaboration plan state helper should build card views')
assert.match(execState, /fixedSteps\s*=\s*\[\]/, 'execution record helper should accept dynamic step definitions')
assert.doesNotMatch(jobCenter, /3x2 matrix of the six fixed stages/, 'JobCenter should no longer describe only fixed six stages')
```

Update `sf-portal-mvp/package.json`:

```json
"test:logic": "node scripts/check-job-selection.mjs && node scripts/check-application-ordering.mjs && node scripts/check-agent-creation.mjs && node scripts/check-agent-panel-layout.mjs && node scripts/check-clarification.mjs && node scripts/check-chat-input-sizing.mjs && node scripts/check-clarification-layout.mjs && node scripts/check-execution-record-state.mjs && node scripts/check-task-observability-layout.mjs && node scripts/check-conversation-workbench.mjs && node scripts/check-dialogue-workbench.mjs && node scripts/check-visible-work-trace.mjs && node scripts/check-managed-agents.mjs && node scripts/check-side-panel-toggle.mjs && node scripts/check-collaboration-plan.mjs"
```

- [ ] **Step 2: Run logic test and verify failure.**

Run:

```bash
cd sf-portal-mvp && npm run test:logic
```

Expected: FAIL because `collaborationPlanState.js` does not exist and `JobCenter` still uses fixed six-step copy.

- [ ] **Step 3: Implement plan-state helper.**

Create `sf-portal-mvp/src/hooks/collaborationPlanState.js`:

```js
export function buildCollaborationCardView(steps = [], summary = [], planResponse = null) {
  const plan = planResponse && planResponse.plan
  const planAgents = plan && Array.isArray(plan.agents) ? plan.agents : []
  const lanes = plan && Array.isArray(plan.lanes) ? plan.lanes : []
  const stepByAgent = {}
  ;(steps || []).forEach(step => {
    if (!step) return
    const key = step.agent_key || step.agentKey
    if (key && !stepByAgent[key]) stepByAgent[key] = step
  })
  const summaryByStepId = {}
  ;(summary || []).forEach(item => {
    if (item && item.step_id != null && !summaryByStepId[item.step_id]) {
      summaryByStepId[item.step_id] = item
    }
  })
  return lanes.map(lane => {
    const cards = planAgents
      .filter(agent => agent.lane === lane.id)
      .map(agent => {
        const step = stepByAgent[agent.key] || null
        const stepId = step && step.id ? step.id : null
        return {
          kind: step ? step.kind : agent.role,
          label: agent.name,
          agent,
          stepId,
          step,
          summary: stepId ? summaryByStepId[stepId] || null : null,
        }
      })
    return { lane, cards }
  }).filter(group => group.cards.length > 0)
}
```

- [ ] **Step 4: Make execution helper accept dynamic definitions.**

Change `buildStepCardView` signature in `sf-portal-mvp/src/hooks/executionRecordState.js`:

```js
export function buildStepCardView(steps, summary, fixedSteps = []) {
```

Keep existing fixed fallback behavior for legacy jobs.

- [ ] **Step 5: Render collaboration lanes in JobCenter.**

In `JobCenter.jsx`, accept `collaborationPlan` prop and compute:

```js
const collaborationLanes = useMemo(
  () => buildCollaborationCardView(steps, summary, collaborationPlan),
  [steps, summary, collaborationPlan],
)
const hasCollaborationPlan = collaborationLanes.length > 0
```

Render:

```jsx
{hasCollaborationPlan ? (
  <div className="jc-collaboration-lanes">
    {collaborationLanes.map(group => (
      <section className="jc-lane" key={group.lane.id}>
        <h3 className="jc-lane-title">{group.lane.label}</h3>
        <div className="jc-step-matrix">
          {group.cards.map(view => (
            <StepCard
              key={view.agent.key}
              kind={view.kind}
              label={view.label}
              agent={view.agent}
              step={view.step}
              summary={view.summary}
              selected={!!view.stepId && selectedStepId === view.stepId}
              unreadCount={view.stepId && getUnreadCount ? getUnreadCount(view.stepId, view.summary?.latest_attempt) : 0}
              onSelect={() => openDrawerForStepId(view.stepId)}
            />
          ))}
        </div>
      </section>
    ))}
  </div>
) : (
  <div className="jc-step-matrix">{/* existing fixed cards */}</div>
)}
```

Add `openDrawerForStepId(stepId)` helper to avoid resolving by fixed kind:

```js
const openDrawerForStepId = stepId => {
  if (!stepId) return
  const sm = summaryByStepId[stepId]
  const step = (Array.isArray(steps) ? steps : []).find(s => s && s.id === stepId)
  const attempt = (sm && (sm.attempt ?? sm.latest_attempt)) ?? (step && step.attempt) ?? 1
  setDrawerOpen(true)
  if (selectStepAttempt) selectStepAttempt(stepId, attempt)
}
```

- [ ] **Step 6: Wire plan loading in the jobs hook or parent.**

Where `JobCenter` is instantiated in `sf-portal-mvp/src/App.jsx`, load the plan for `activeJob.id` with `factoryApi.getJobCollaborationPlan(activeJob.id)` in the existing job hook or a small local `useEffect`. Pass it as:

```jsx
collaborationPlan={jobs.collaborationPlan}
```

- [ ] **Step 7: Run frontend verification.**

Run:

```bash
cd sf-portal-mvp && npm run test:logic && npm run build
```

Expected: PASS.

- [ ] **Step 8: Commit.**

```bash
git add sf-portal-mvp/src/hooks/collaborationPlanState.js sf-portal-mvp/src/hooks/executionRecordState.js sf-portal-mvp/src/components/JobCenter.jsx sf-portal-mvp/src/components/StepCard.jsx sf-portal-mvp/src/App.jsx sf-portal-mvp/src/api/client.js sf-portal-mvp/scripts/check-collaboration-plan.mjs sf-portal-mvp/package.json
git commit -m "feat: render collaboration task cards"
```

## Task 5: Add collaboration-agent detail editing for per-task snapshots

**Files:**

- Modify: `factory-server/internal/store/jobs.go`
- Modify: `factory-server/internal/server/job_handlers.go`
- Modify: `factory-server/internal/server/job_handlers_test.go`
- Modify: `factory-server/internal/server/server.go`
- Modify: `sf-portal-mvp/src/api/client.js`
- Modify: `sf-portal-mvp/src/components/StepExecutionDrawer.jsx`

- [ ] **Step 1: Write failing snapshot patch API test.**

Add to `factory-server/internal/server/job_handlers_test.go`:

```go
func TestPatchJobStepSnapshotUpdatesOnlyTaskSnapshot(t *testing.T) {
	_, r, st := newJobsTestServer(t, config.Config{})
	rec := createJobViaAPI(t, r, "生成复盘智能体")
	var job model.Job
	if err := json.NewDecoder(rec.Body).Decode(&job); err != nil {
		t.Fatalf("decode job: %v", err)
	}
	steps, err := st.ListJobSteps(context.Background(), job.ID)
	if err != nil || len(steps) == 0 {
		t.Fatalf("steps err=%v len=%d", err, len(steps))
	}
	body := map[string]any{
		"snapshot": map[string]any{
			"agentKey": steps[0].AgentKey,
			"name": "协作编排（本次调整）",
			"description": "只影响本次任务",
			"lane": "analysis",
			"instructions": "本次任务使用调整后的说明",
			"selectedSkills": []string{},
			"skillOverrides": []map[string]string{},
		},
	}
	patch := doJSON(t, r, http.MethodPatch, "/api/jobs/"+job.ID+"/steps/"+steps[0].ID+"/snapshot", body)
	if patch.Code != http.StatusOK {
		t.Fatalf("patch status = %d, body=%s", patch.Code, patch.Body.String())
	}
	updated, err := st.ListJobSteps(context.Background(), job.ID)
	if err != nil {
		t.Fatalf("ListJobSteps: %v", err)
	}
	if !strings.Contains(updated[0].SnapshotJSON, "本次调整") {
		t.Fatalf("snapshot not updated: %s", updated[0].SnapshotJSON)
	}
}
```

- [ ] **Step 2: Run test and verify failure.**

Run:

```bash
cd factory-server && go test ./internal/server -run TestPatchJobStepSnapshotUpdatesOnlyTaskSnapshot
```

Expected: FAIL because PATCH route does not exist.

- [ ] **Step 3: Add store update method.**

In `factory-server/internal/store/jobs.go`:

```go
func (s *Store) SetStepSnapshot(ctx context.Context, stepID, snapshotJSON string) error {
	_, err := s.db.ExecContext(ctx, `
UPDATE job_steps
SET snapshot_json = ?
WHERE id = ?`, snapshotJSON, stepID)
	return err
}
```

- [ ] **Step 4: Add patch handler.**

In `factory-server/internal/server/job_handlers.go`:

```go
func (s *Server) patchJobStepSnapshot(w http.ResponseWriter, r *http.Request) {
	jobID := Param(r, "id")
	stepID := Param(r, "stepID")
	var body struct {
		Snapshot json.RawMessage `json:"snapshot"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid json")
		return
	}
	if len(body.Snapshot) == 0 || !json.Valid(body.Snapshot) {
		writeError(w, http.StatusBadRequest, "snapshot must be valid json")
		return
	}
	steps, err := s.store.ListJobSteps(r.Context(), jobID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "list steps")
		return
	}
	found := false
	for _, step := range steps {
		if step.ID == stepID {
			found = true
			break
		}
	}
	if !found {
		writeError(w, http.StatusNotFound, "step not found")
		return
	}
	if err := s.store.SetStepSnapshot(r.Context(), stepID, string(body.Snapshot)); err != nil {
		writeError(w, http.StatusInternalServerError, "update snapshot")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"step_id": stepID, "snapshot": json.RawMessage(body.Snapshot)})
}
```

Register:

```go
r.Handle("PATCH", "/api/jobs/:id/steps/:stepID/snapshot", s.patchJobStepSnapshot)
```

- [ ] **Step 5: Add frontend client and drawer editor.**

In `sf-portal-mvp/src/api/client.js`:

```js
patchJobStepSnapshot: (jobId, stepId, snapshot) =>
  request(`/api/jobs/${jobId}/steps/${stepId}/snapshot`, {
    method: 'PATCH',
    body: JSON.stringify({ snapshot }),
  }),
```

In `StepExecutionDrawer.jsx`, render a JSON textarea for `step.snapshot_json` when present:

```jsx
{step?.snapshot_json ? (
  <section className="sed-snapshot">
    <h4>本次配置快照</h4>
    <textarea value={snapshotDraft} onChange={event => setSnapshotDraft(event.target.value)} />
    <button type="button" onClick={saveSnapshot}>保存到本次任务</button>
  </section>
) : null}
```

`saveSnapshot` must parse JSON before calling the API:

```js
const saveSnapshot = async () => {
  const parsed = JSON.parse(snapshotDraft)
  await patchJobStepSnapshot(activeJob.id, step.id, parsed)
}
```

- [ ] **Step 6: Run tests.**

Run:

```bash
cd factory-server && go test ./internal/server -run TestPatchJobStepSnapshotUpdatesOnlyTaskSnapshot
cd sf-portal-mvp && npm run build
```

Expected: PASS.

- [ ] **Step 7: Commit.**

```bash
git add factory-server/internal/store/jobs.go factory-server/internal/server/job_handlers.go factory-server/internal/server/job_handlers_test.go factory-server/internal/server/server.go sf-portal-mvp/src/api/client.js sf-portal-mvp/src/components/StepExecutionDrawer.jsx
git commit -m "feat: edit collaboration step snapshots"
```

## Task 6: Add code review, product acceptance, security review, and bounded repair gates

**Files:**

- Modify: `factory-server/internal/model/model.go`
- Modify: `factory-server/internal/executor/steps.go`
- Modify: `factory-server/internal/executor/executor.go`
- Modify: `factory-server/internal/executor/executor_test.go`
- Modify: `factory-server/internal/executor/claude_runner.go`
- Modify: `factory-server/internal/executor/fake_claude.go`
- Modify: `factory-server/internal/collaboration/plan.go`
- Modify: `docs/claude-skills-and-agents.md`

- [ ] **Step 1: Write failing bounded repair tests.**

Add to `factory-server/internal/executor/executor_test.go`:

```go
func TestExecutorAutoRepairFromBlockingReviewOnce(t *testing.T) {
	runner := &fakeRunner{byKind: map[model.StepKind]StepResult{
		model.StepKind("code_review"): {
			Status: model.StepStatusFailed, ErrorCode: model.ErrorCode("blocking_review"),
			ErrorMessage: "数据接入契约未被代码使用",
		},
	}}
	e, st := newTestExecutor(t, runner)
	id := seedJob(t, st)
	// In the dynamic-plan task helper, seedJob should create a code_review step.
	drain(t, context.Background(), e)
	job := mustJob(t, st, id)
	if job.Status != model.JobStatusQueued || job.CurrentStepKind != model.StepCodeGeneration {
		t.Fatalf("job after blocking review = %s/%s, want queued/code_generation", job.Status, job.CurrentStepKind)
	}
}

func TestExecutorStopsAfterRepeatedBlockingReason(t *testing.T) {
	runner := &fakeRunner{byKind: map[model.StepKind]StepResult{
		model.StepKind("code_review"): {
			Status: model.StepStatusFailed, ErrorCode: model.ErrorCode("blocking_review"),
			ErrorMessage: "same:blocking-review:data-contract",
		},
	}}
	e, st := newTestExecutor(t, runner)
	id := seedJob(t, st)
	drain(t, context.Background(), e)
	drain(t, context.Background(), e)
	job := mustJob(t, st, id)
	if job.Status != model.JobStatusFailed {
		t.Fatalf("job status = %s, want failed after repeated blocking reason", job.Status)
	}
}
```

- [ ] **Step 2: Run tests and verify failure.**

Run:

```bash
cd factory-server && go test ./internal/executor -run 'TestExecutorAutoRepairFromBlockingReviewOnce|TestExecutorStopsAfterRepeatedBlockingReason'
```

Expected: FAIL because auto repair policy is not implemented.

- [ ] **Step 3: Add new step kind constants.**

In `factory-server/internal/model/model.go`:

```go
StepCollaborationOrchestration StepKind = "collaboration_orchestration"
StepDomainAnalysis             StepKind = "domain_analysis"
StepDesignContract             StepKind = "design_contract"
StepDataIntegration            StepKind = "data_integration"
StepCodeReview                 StepKind = "code_review"
StepSecurityReview             StepKind = "security_review"
StepProductAcceptance          StepKind = "product_acceptance"
```

- [ ] **Step 4: Teach executor modes about new Claude gates.**

In `factory-server/internal/executor/steps.go`, extend mode lookup for dynamic kinds:

```go
func modeForKind(k model.StepKind) string {
	for _, s := range FixedSteps() {
		if s.Kind == k {
			return s.Mode
		}
	}
	switch k {
	case model.StepCollaborationOrchestration, model.StepDomainAnalysis, model.StepDesignContract,
		model.StepDataIntegration, model.StepCodeReview, model.StepSecurityReview, model.StepProductAcceptance:
		return ModeClaude
	}
	return ModeClaude
}
```

- [ ] **Step 5: Add bounded repair state helpers.**

In `executor.go`, before marking a failed step terminal, inspect `job.CollaborationPlanJSON` repair policy and step kind. If the failure is repairable and under limit, call `RepairFromFailure` instead of `MarkJobFailed`.

Add helper signatures:

```go
func shouldAutoRepair(job model.Job, step model.JobStep, res StepResult) bool
func repairReasonKey(step model.JobStep, res StepResult) string
```

`shouldAutoRepair` returns true for:

```go
step.Kind == model.StepCodeReview ||
step.Kind == model.StepSecurityReview ||
step.Kind == model.StepProductAcceptance ||
step.Kind == model.StepTestVerification ||
step.Kind == model.StepImageBuild ||
(step.Kind == model.StepDeployment && res.ErrorCode == model.ErrorHealthCheckFailed)
```

and false for `ErrorPortUnavailable`, `ErrorPodmanRunFailed`, and repeated same reason. Store repair counters in `jobs.collaboration_plan_json` under:

```json
"repairState": {
  "totalAutomaticRepairs": 1,
  "byReason": {"code_review:blocking_review:same:blocking-review:data-contract": 1}
}
```

- [ ] **Step 6: Expand Claude runner prompts for new gates.**

In `factory-server/internal/executor/claude_runner.go`, add prompt cases:

```go
case model.StepCodeReview:
	return "你是软件工厂的代码审查门禁。只输出 JSON：{\"blockingFindings\":[],\"advisoryFindings\":[],\"status\":\"passed|blocked\"}。只有影响正确性、可部署性、数据诚实、安全或确认用户行为的问题可以 blocking。"
case model.StepProductAcceptance:
	return "你是软件工厂的产品验收智能体。对照确认需求摘要、设计契约、数据契约和主要用户流程验收。只输出 JSON：{\"blockingFindings\":[],\"advisoryFindings\":[],\"status\":\"passed|blocked\"}。"
case model.StepSecurityReview:
	return "你是软件工厂的安全审查智能体。检查公网数据、认证、上传、外部接口、敏感数据、权限和暴露部署面。只输出 JSON：{\"blockingFindings\":[],\"advisoryFindings\":[],\"status\":\"passed|blocked\"}。"
```

Map `status:"blocked"` to `StepStatusFailed` with an error code such as `blocking_review`, and `status:"passed"` to succeeded.

- [ ] **Step 7: Run executor tests.**

Run:

```bash
cd factory-server && go test ./internal/executor
```

Expected: PASS.

- [ ] **Step 8: Commit.**

```bash
git add factory-server/internal/model/model.go factory-server/internal/executor/steps.go factory-server/internal/executor/executor.go factory-server/internal/executor/executor_test.go factory-server/internal/executor/claude_runner.go factory-server/internal/executor/fake_claude.go factory-server/internal/collaboration/plan.go docs/claude-skills-and-agents.md
git commit -m "feat: add collaboration gates and bounded repair"
```

## Task 7: Confirm-summary collaboration plan preview and natural-language adjustments

**Files:**

- Modify: `.claude/skills/requirement-clarification/SKILL.md`
- Modify: `factory-server/internal/clarification/contracts.go`
- Modify: `factory-server/internal/server/clarification_handlers.go`
- Modify: `factory-server/internal/server/dialogue_handlers.go`
- Modify: `factory-server/internal/server/dialogue_handlers_test.go`
- Modify: `sf-portal-mvp/src/components/ConversationWorkbench.jsx`
- Modify: `sf-portal-mvp/src/hooks/dialogueTimeline.js`
- Modify: `sf-portal-mvp/scripts/check-collaboration-plan.mjs`

- [ ] **Step 1: Write failing dialogue test for confirmation summary plan.**

Add a dialogue handler test that creates an application-generation dialogue, drives clarification to `ready_to_confirm`, and asserts the composed view contains a collaboration plan preview in the route-specific confirmation payload:

```go
func TestDialogueReadyToConfirmIncludesCollaborationPlanPreview(t *testing.T) {
	srv, r, st := newDialogueTestServer(t, &fakeDialogueRunner{routeStdout: routeAmbiguousOutput})
	create := doJSON(t, r, http.MethodPost, "/api/dialogues", map[string]string{"prompt": "生成公网数据研判智能体"})
	if create.Code != http.StatusCreated {
		t.Fatalf("create = %d body=%s", create.Code, create.Body.String())
	}
	var created dialogueView
	if err := json.NewDecoder(create.Body).Decode(&created); err != nil {
		t.Fatalf("decode created view: %v", err)
	}
	routeRec := doJSON(t, r, http.MethodPost, "/api/dialogues/"+created.Session.ID+"/route", map[string]any{
		"intent": "application_generation",
	})
	if routeRec.Code != http.StatusOK {
		t.Fatalf("route = %d body=%s", routeRec.Code, routeRec.Body.String())
	}
	var routed dialogueView
	if err := json.NewDecoder(routeRec.Body).Decode(&routed); err != nil {
		t.Fatalf("decode routed view: %v", err)
	}
	childID := routed.Session.ClarificationSessionID
	if childID == "" {
		t.Fatalf("route did not create child clarification: %+v", routed.Session)
	}
	completeReq := `{"appType":"command_dashboard","appName":"公网数据研判智能体","targetUsers":["值班员"],"coreScenario":"监控公网动态","primaryView":"指挥看板","mainEntities":["目标"],"dataPolicy":"live_api","judgementBoundary":{"dataSources":["public_web_search"],"summary":"使用公网搜索研判目标动态"},"generationProfile":{"base":["software-factory-app"]},"acceptanceFocus":["显示数据来源"]}`
	if err := st.UpdateClarificationRequirement(context.Background(), childID, completeReq); err != nil {
		t.Fatalf("UpdateClarificationRequirement: %v", err)
	}
	if err := st.SetClarificationStatus(context.Background(), childID, model.ClarificationStatusReadyToConfirm, "", ""); err != nil {
		t.Fatalf("SetClarificationStatus: %v", err)
	}
	view, err := srv.composeDialogueView(context.Background(), created.Session.ID)
	if err != nil || view == nil {
		t.Fatalf("composeDialogueView: view=%v err=%v", view != nil, err)
	}
	if view.CollaborationPlanPreview == nil {
		t.Fatalf("missing collaboration plan preview in ready-to-confirm view")
	}
	if len(view.CollaborationPlanPreview.Agents) == 0 || len(view.CollaborationPlanPreview.Edges) == 0 {
		t.Fatalf("empty collaboration plan preview: %+v", view.CollaborationPlanPreview)
	}
}
```

- [ ] **Step 2: Extend contracts.**

Add a `CollaborationPlanPreview` field to `dialogueView` and any clarification composed view struct that renders the final confirmation surface:

```go
type collaborationPlanPreview struct {
	SchemaVersion      int                          `json:"schemaVersion"`
	Mode               string                       `json:"mode"`
	Lanes              []collaboration.Lane         `json:"lanes"`
	Agents             []collaboration.Agent        `json:"agents"`
	Edges              []collaboration.Edge         `json:"edges"`
	HighImpactWarnings []collaborationHighImpactWarning `json:"highImpactWarnings,omitempty"`
}

type collaborationHighImpactWarning struct {
	AgentKey string `json:"agentKey"`
	Action   string `json:"action"`
	Message  string `json:"message"`
}
```

In `dialogueView`, add:

```go
CollaborationPlanPreview *collaborationPlanPreview `json:"collaborationPlanPreview,omitempty"`
```

The JSON response must use lower-camel field names because the portal reads `view.collaborationPlanPreview.agents`.

- [ ] **Step 3: Build preview before confirm.**

In `clarification_handlers.go` and `dialogue_handlers.go`, when a session is `ready_to_confirm`, build `collaboration.DefaultPlan` from the current requirement JSON and include it in the composed view. Do not create a job yet.

- [ ] **Step 4: Render preview in ConversationWorkbench.**

In `ConversationWorkbench.jsx`, render the preview above the confirm button:

```jsx
{view.collaborationPlanPreview ? (
  <section className="cw-collaboration-preview">
    <h3>协作智能体参与计划</h3>
    {view.collaborationPlanPreview.lanes.map(lane => (
      <div key={lane.id} className="cw-collaboration-lane">
        <strong>{lane.label}</strong>
        <ul>
          {view.collaborationPlanPreview.agents.filter(agent => agent.lane === lane.id).map(agent => (
            <li key={agent.key}>{agent.name}</li>
          ))}
        </ul>
      </div>
    ))}
  </section>
) : null}
```

- [ ] **Step 5: Add natural-language adjustment contract.**

Extend the clarification skill output with:

```json
"collaborationAdjustments": [
  {"action":"remove_agent","agentKey":"code-reviewer","highImpact":true,"warning":"移除代码审查会取消阻断式质量门禁"}
]
```

Server applies adjustments only while still before task creation. If `highImpact:true`, keep the high-impact confirmation open until the user explicitly confirms the removal.

- [ ] **Step 6: Run tests.**

Run:

```bash
cd factory-server && go test ./internal/server ./internal/clarification
cd sf-portal-mvp && npm run test:logic && npm run build
```

Expected: PASS.

- [ ] **Step 7: Commit.**

```bash
git add .claude/skills/requirement-clarification/SKILL.md factory-server/internal/clarification/contracts.go factory-server/internal/server/clarification_handlers.go factory-server/internal/server/dialogue_handlers.go factory-server/internal/server/dialogue_handlers_test.go sf-portal-mvp/src/components/ConversationWorkbench.jsx sf-portal-mvp/src/hooks/dialogueTimeline.js sf-portal-mvp/scripts/check-collaboration-plan.mjs
git commit -m "feat: confirm collaboration plans before generation"
```

## Task 8: Final verification and documentation sync

**Files:**

- Modify: `docs/claude-skills-and-agents.md`
- Modify: `docs/software-factory-task-observability-design.md`
- Modify: `docs/software-factory-local-runbook.md`

- [ ] **Step 1: Update docs to mark implemented behavior.**

In `docs/claude-skills-and-agents.md`, change target-only wording only for features actually implemented by Tasks 1-7. Keep future DAG parallelism described as future work.

In `docs/software-factory-task-observability-design.md`, replace the fixed `3 x 2` language with dynamic collaboration lanes, while noting legacy fixed jobs may still render six cards.

In `docs/software-factory-local-runbook.md`, add a smoke-test section:

```bash
curl http://127.0.0.1:8787/api/jobs/<job-id>/collaboration-plan
```

Expected: response contains `plan.schemaVersion`, `steps`, and `edges`.

- [ ] **Step 2: Run full backend tests.**

Run:

```bash
cd factory-server && go test ./...
```

Expected: PASS.

- [ ] **Step 3: Run full frontend checks.**

Run:

```bash
cd sf-portal-mvp && npm run test:logic && npm run build
```

Expected: PASS.

- [ ] **Step 4: Manual smoke with fake Claude.**

Run the local factory according to `docs/software-factory-local-runbook.md` with fake Claude enabled, create a generation request, and verify:

```text
1. Confirmation summary shows collaboration plan preview.
2. Generated job exposes /api/jobs/:id/collaboration-plan.
3. Task area renders lanes and agent cards.
4. Opening a card shows execution records and the task snapshot.
5. A failed repairable gate enters bounded repair at most twice.
```

- [ ] **Step 5: Commit docs and verification updates.**

```bash
git add docs/claude-skills-and-agents.md docs/software-factory-task-observability-design.md docs/software-factory-local-runbook.md
git commit -m "docs: document dynamic collaboration task flow"
```

## Self-Review

- Spec coverage: The plan covers persisted collaboration plans, default agents, pre-generation confirmation, natural-language adjustment, dynamic task cards, snapshot editing, code/product/security gates, bounded repair, and documentation updates.
- Placeholder scan: No task uses `TBD`, unspecified validation, or generic “write tests” steps. Each task includes concrete files, example tests, commands, and expected results.
- Type consistency: The plan consistently uses `CollaborationPlanJSON`, `SnapshotJSON`, `JobStepEdge`, `collaboration_plan_json`, `snapshot_json`, and `job_step_edges`. Frontend plan rendering uses `collaborationPlan`, `buildCollaborationCardView`, and existing `step_id`/`step.id` conventions.
- Scope control: MVP executes the DAG in topological serial order. Intra-task parallel execution is explicitly deferred until after dynamic plan persistence, UI, gates, repair, and audit behavior are stable.

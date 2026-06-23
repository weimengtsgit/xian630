# Business Agents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将右侧智能体区域升级为「软件开发智能体 / 业务智能体」双 Tab，并支持在一次会话中多选业务智能体进入生成主流程。

**Architecture:** 后端扩展现有 `agents`、`clarification_sessions`、`jobs` 模型，不引入独立插件运行时；软件开发智能体由 registry 固定种子化，业务智能体作为可编辑配置。会话通过 ordered join table 选择多个业务智能体，确认生成时把快照写入 job，再由 Claude 前三阶段读取快照并注入提示词。

**Tech Stack:** Go 1.21、SQLite(`modernc.org/sqlite`)、React 18、Vite、原生 Node 逻辑测试脚本。

---

## 范围检查

该 spec 涉及后端模型/API、流水线提示词注入、前端右侧面板、会话选择和业务智能体作者ing。它们虽然跨层，但围绕一个闭环功能：业务智能体配置并作用于某次生成会话。因此保持一个实施计划，但按可独立测试的小任务拆分。

第一版不实现业务智能体删除，也不实现真实 LLM 流式作者ing。作者ing API 先提供确定性的“对话草稿 + finalize”能力，前端体验按对话式面板组织；后续可把草稿生成器替换为真实 Claude 调用。

## 文件结构

后端：

- `factory-server/internal/model/model.go`：扩展 `Agent`、新增业务智能体作者ing模型、Job 快照字段。
- `factory-server/internal/store/schema.sql`：新增 agent 字段、作者ing表、会话选择表、job 快照字段。
- `factory-server/internal/store/store.go`：启动迁移补齐新增列。
- `factory-server/internal/agents/registry.go`：固定 6 个软件开发智能体和只读 prompt。
- `factory-server/internal/store/agents.go`：分类查询、业务智能体 CRUD、prompt/editable/category 扫描。
- `factory-server/internal/store/business_agent_selection.go`：会话多选业务智能体的持久化和快照读取。
- `factory-server/internal/store/agent_authoring.go`：作者ing会话和消息持久化。
- `factory-server/internal/server/agent_handlers.go`：agent 分类查询、详情、业务智能体管理 API。
- `factory-server/internal/server/business_agent_authoring_handlers.go`：业务智能体作者ing API。
- `factory-server/internal/server/clarification_business_agents_handlers.go`：会话业务智能体选择 API。
- `factory-server/internal/server/clarification_handlers.go`：确认生成时验证选择并写入 job 快照。
- `factory-server/internal/server/server.go`：注册新路由。
- `factory-server/internal/executor/claude_runner.go`：读取 job 快照并只注入前三个 Claude 阶段。

前端：

- `sf-portal-mvp/src/api/client.js`：新增业务智能体、作者ing、会话选择 API client。
- `sf-portal-mvp/src/hooks/agentList.js`：分类、排序、选择 helper。
- `sf-portal-mvp/src/hooks/useAgents.js`：加载分类 agents，执行业务智能体 CRUD。
- `sf-portal-mvp/src/hooks/useConversationSessions.js`：维护当前会话的多选业务智能体。
- `sf-portal-mvp/src/components/AgentsPanel.jsx`：双 Tab、软件只读详情、业务卡片与作者ing入口。
- `sf-portal-mvp/src/components/AgentsPanel.css`：双 Tab、已选状态、作者ing弹窗样式。
- `sf-portal-mvp/src/components/ConversationWorkbench.jsx`：展示和调整本次业务智能体选择。
- `sf-portal-mvp/src/components/ConversationWorkbench.css`：业务智能体 chip、排序控件样式。
- `sf-portal-mvp/src/App.jsx`：把会话选择操作传给右侧面板和会话工作台。
- `sf-portal-mvp/scripts/check-business-agents.mjs`：新增前端逻辑测试。
- `sf-portal-mvp/package.json`：把新增脚本加入 `test:logic`。

---

### Task 1: 后端模型、Schema 与六个软件开发智能体

**Files:**
- Modify: `factory-server/internal/model/model.go`
- Modify: `factory-server/internal/store/schema.sql`
- Modify: `factory-server/internal/store/store.go`
- Modify: `factory-server/internal/agents/registry.go`
- Modify: `factory-server/internal/agents/registry_test.go`
- Modify: `factory-server/internal/store/agents.go`
- Modify: `factory-server/internal/store/agents_test.go`
- Modify: `factory-server/internal/server/agent_handlers_test.go`
- Modify: `factory-server/internal/executor/steps.go`
- Modify: `factory-server/internal/executor/steps_test.go`

- [ ] **Step 1: 写 registry 失败测试**

在 `factory-server/internal/agents/registry_test.go` 中把 “5 个智能体” 断言改为 6 个，并检查分类、可编辑性和 prompt。

```go
func TestDefaultRegistryContainsSixSoftwareAgents(t *testing.T) {
	agents := DefaultRegistry()
	keys := map[string]bool{}
	for _, agent := range agents {
		keys[agent.Key] = true
		if agent.Category != model.AgentCategorySoftware {
			t.Fatalf("%s category = %q, want software", agent.Key, agent.Category)
		}
		if agent.Editable {
			t.Fatalf("%s editable = true, want false", agent.Key)
		}
		if strings.TrimSpace(agent.Prompt) == "" {
			t.Fatalf("%s prompt is empty", agent.Key)
		}
	}
	for _, key := range []string{
		"requirement-analyst",
		"solution-designer",
		"code-generator",
		"tester",
		"image-builder",
		"deployer",
	} {
		if !keys[key] {
			t.Fatalf("missing agent key %s", key)
		}
	}
	if len(agents) != 6 {
		t.Fatalf("len = %d, want 6", len(agents))
	}
}
```

把顺序测试改成：

```go
func TestDefaultRegistryOrderAndClaudeNames(t *testing.T) {
	agents := DefaultRegistry()
	want := []struct {
		id, key, claude string
		sort           int
	}{
		{"agent_requirement_analyst", "requirement-analyst", "requirement-analyst", 1},
		{"agent_solution_designer", "solution-designer", "solution-designer", 2},
		{"agent_code_generator", "code-generator", "code-generator", 3},
		{"agent_tester", "tester", "tester", 4},
		{"agent_image_builder", "image-builder", "image-builder", 5},
		{"agent_deployer", "deployer", "deployer", 6},
	}
	for i, w := range want {
		got := agents[i]
		if got.ID != w.id || got.Key != w.key || got.ClaudeAgentName != w.claude || got.SortOrder != w.sort {
			t.Fatalf("agent[%d] = %+v, want id=%s key=%s claude=%s sort=%d", i, got, w.id, w.key, w.claude, w.sort)
		}
	}
}
```

- [ ] **Step 2: 运行 registry 测试确认失败**

Run:

```bash
cd factory-server && go test ./internal/agents
```

Expected: FAIL，错误包含 `missing agent key image-builder` 或 `len = 5, want 6`。

- [ ] **Step 3: 扩展 Agent 模型**

在 `factory-server/internal/model/model.go` 的 `Agent` 附近新增：

```go
type AgentCategory string

const (
	AgentCategorySoftware AgentCategory = "software"
	AgentCategoryBusiness AgentCategory = "business"
)
```

把 `Agent` 扩展为：

```go
type Agent struct {
	ID              string        `json:"id"`
	Key             string        `json:"key"`
	Name            string        `json:"name"`
	Role            string        `json:"role"`
	Description     string        `json:"description"`
	ClaudeAgentName string        `json:"claude_agent_name"`
	SkillsJSON      string        `json:"skills_json"`
	Enabled         bool          `json:"enabled"`
	SortOrder       int           `json:"sort_order"`
	Category        AgentCategory `json:"category"`
	Prompt          string        `json:"prompt"`
	Editable        bool          `json:"editable"`
}
```

- [ ] **Step 4: 扩展 schema 和启动迁移**

在 `factory-server/internal/store/schema.sql` 的 `agents` 表追加列：

```sql
    category          TEXT    NOT NULL DEFAULT 'business',
    prompt            TEXT    NOT NULL DEFAULT '',
    editable          INTEGER NOT NULL DEFAULT 1
```

注意给上一行 `sort_order` 加逗号。

在 `jobs` 表追加：

```sql
    business_agent_snapshots_json TEXT NOT NULL DEFAULT ''
```

在 `clarification_messages` 后新增：

```sql
CREATE TABLE IF NOT EXISTS clarification_business_agents (
    clarification_session_id TEXT    NOT NULL,
    agent_id                  TEXT    NOT NULL,
    priority                  INTEGER NOT NULL,
    created_at                INTEGER NOT NULL,
    PRIMARY KEY(clarification_session_id, agent_id)
);
CREATE INDEX IF NOT EXISTS idx_clarification_business_agents_session
ON clarification_business_agents(clarification_session_id, priority);

CREATE TABLE IF NOT EXISTS agent_authoring_sessions (
    id              TEXT    PRIMARY KEY,
    mode            TEXT    NOT NULL,
    target_agent_id TEXT    NOT NULL DEFAULT '',
    status          TEXT    NOT NULL,
    draft_json      TEXT    NOT NULL DEFAULT '{}',
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_authoring_messages (
    id            TEXT    PRIMARY KEY,
    session_id    TEXT    NOT NULL,
    role          TEXT    NOT NULL,
    kind          TEXT    NOT NULL,
    content       TEXT    NOT NULL DEFAULT '',
    metadata_json TEXT    NOT NULL DEFAULT '',
    created_at    INTEGER NOT NULL
);
```

在 `factory-server/internal/store/store.go` 的 `Open` 中补迁移：

```go
agentColumns := []struct {
	column string
	ddl    string
}{
	{"category", `ALTER TABLE agents ADD COLUMN category TEXT NOT NULL DEFAULT 'business'`},
	{"prompt", `ALTER TABLE agents ADD COLUMN prompt TEXT NOT NULL DEFAULT ''`},
	{"editable", `ALTER TABLE agents ADD COLUMN editable INTEGER NOT NULL DEFAULT 1`},
}
for _, col := range agentColumns {
	if err := s.ensureColumn(ctx, "agents", col.column, col.ddl); err != nil {
		db.Close()
		return nil, fmt.Errorf("migrate agents.%s: %w", col.column, err)
	}
}
if err := s.ensureColumn(ctx, "jobs", "business_agent_snapshots_json",
	`ALTER TABLE jobs ADD COLUMN business_agent_snapshots_json TEXT NOT NULL DEFAULT ''`); err != nil {
	db.Close()
	return nil, fmt.Errorf("migrate jobs.business_agent_snapshots_json: %w", err)
}
```

- [ ] **Step 5: 更新 registry 为六个软件智能体**

在 `factory-server/internal/agents/registry.go` 增加 prompt 常量：

```go
const requirementAnalystPrompt = "你是软件工厂的需求分析智能体。负责冻结用户已确认需求，校验字段完整性、能力边界、generationProfile 与蓝本引用。不得生成代码，不得执行命令，不得输出隐藏推理链。"
const solutionDesignerPrompt = "你是软件工厂的方案设计智能体。负责把已确认需求转为可执行的前端应用方案、文件计划、交互结构和验收重点。不得执行命令，不得输出隐藏推理链。"
const codeGeneratorPrompt = "你是软件工厂的代码生成智能体。负责在 generated-apps/<slug>/ 下生成静态 Vite 应用、Factory manifest、Dockerfile 和必要源码。不得写入允许范围外路径。"
const testerPrompt = "你是软件工厂的测试验证智能体。负责分析测试与构建日志，生成公开诊断摘要；真实命令由 Factory 执行，你不得自由拼接命令。"
const imageBuilderPrompt = "你是软件工厂的镜像构建智能体。负责解释镜像构建阶段的产物、日志和失败原因；真实 podman build 命令由 Factory 固定执行。"
const deployerPrompt = "你是软件工厂的部署智能体。负责解释容器部署、健康检查和运行地址；真实 podman run/stop 命令由 Factory 固定执行。"
```

每个默认 `model.Agent` 设置：

```go
Category: model.AgentCategorySoftware,
Prompt:   requirementAnalystPrompt,
Editable: false,
```

并把原 `agent_deployer` 的构建部署拆成：

```go
{
	ID:              "agent_image_builder",
	Key:             "image-builder",
	Name:            "镜像构建",
	Role:            "image_build",
	Description:     "解释镜像构建过程、产物和失败原因",
	ClaudeAgentName: "image-builder",
	SkillsJSON:      "",
	Enabled:         true,
	SortOrder:       5,
	Category:        model.AgentCategorySoftware,
	Prompt:          imageBuilderPrompt,
	Editable:        false,
},
{
	ID:              "agent_deployer",
	Key:             "deployer",
	Name:            "部署",
	Role:            "deployment",
	Description:     "解释并审计容器部署、健康检查和运行地址",
	ClaudeAgentName: "deployer",
	SkillsJSON:      "",
	Enabled:         true,
	SortOrder:       6,
	Category:        model.AgentCategorySoftware,
	Prompt:          deployerPrompt,
	Editable:        false,
},
```

- [ ] **Step 6: 更新 store agents SQL**

在 `factory-server/internal/store/agents.go` 中：

`UpsertAgent` 的 INSERT 列改为：

```sql
INSERT INTO agents(id, key, name, role, description, claude_agent_name, skills_json, enabled, sort_order, category, prompt, editable)
VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(id) DO UPDATE SET
  key               = excluded.key,
  name              = excluded.name,
  role              = excluded.role,
  description       = excluded.description,
  claude_agent_name = excluded.claude_agent_name,
  skills_json       = excluded.skills_json,
  sort_order        = excluded.sort_order,
  category          = excluded.category,
  prompt            = excluded.prompt,
  editable          = excluded.editable
```

参数追加：

```go
string(a.Category), a.Prompt, boolToInt(a.Editable)
```

`CreateAgent` 同样插入 12 列。

把所有 SELECT 列扩展为：

```sql
SELECT id, key, name, role, description, claude_agent_name, skills_json, enabled, sort_order, category, prompt, editable
FROM agents
```

`scanAgent` 改为：

```go
var a model.Agent
var enabled, editable int
var category string
if err := sc.Scan(&a.ID, &a.Key, &a.Name, &a.Role, &a.Description,
	&a.ClaudeAgentName, &a.SkillsJSON, &enabled, &a.SortOrder,
	&category, &a.Prompt, &editable); err != nil {
	return nil, err
}
a.Enabled = enabled != 0
a.Editable = editable != 0
a.Category = model.AgentCategory(category)
if a.Category == "" {
	a.Category = model.AgentCategoryBusiness
}
return &a, nil
```

- [ ] **Step 7: 更新步骤 agent_key**

在 `factory-server/internal/executor/steps.go` 中把 image build 的 AgentKey 改为：

```go
{Kind: model.StepImageBuild, Seq: 5, AgentKey: "image-builder", Mode: ModeFactory},
{Kind: model.StepDeployment, Seq: 6, AgentKey: "deployer", Mode: ModeFactory},
```

在 `factory-server/internal/server/job_handlers.go` 的 `stepPlan` 中同步改 image build 为 `image-builder`。

- [ ] **Step 8: 跑后端局部测试**

Run:

```bash
cd factory-server && go test ./internal/agents ./internal/store ./internal/executor ./internal/server
```

Expected: 可能仍 FAIL，因为 server 测试还按五个智能体断言。更新测试中的 key 列表包含 `image-builder`，并把 `agent_deployer` sort_order 期望改为 6。

- [ ] **Step 9: 再跑测试确认通过**

Run:

```bash
cd factory-server && go test ./internal/agents ./internal/store ./internal/executor ./internal/server
```

Expected: PASS。

- [ ] **Step 10: 提交**

```bash
git add factory-server/internal/model/model.go factory-server/internal/store/schema.sql factory-server/internal/store/store.go factory-server/internal/agents/registry.go factory-server/internal/agents/registry_test.go factory-server/internal/store/agents.go factory-server/internal/store/agents_test.go factory-server/internal/server/agent_handlers_test.go factory-server/internal/executor/steps.go factory-server/internal/executor/steps_test.go factory-server/internal/server/job_handlers.go factory-server/internal/server/job_handlers_test.go
git commit -m "feat: model software and business agents"
```

---

### Task 2: 业务智能体 CRUD API

**Files:**
- Modify: `factory-server/internal/store/agents.go`
- Modify: `factory-server/internal/server/agent_handlers.go`
- Modify: `factory-server/internal/server/server.go`
- Modify: `factory-server/internal/server/agent_handlers_test.go`
- Modify: `factory-server/internal/store/agents_test.go`

- [ ] **Step 1: 写业务智能体 store 测试**

在 `factory-server/internal/store/agents_test.go` 新增：

```go
func TestCreateBusinessAgentAndListByCategory(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	software := model.Agent{
		ID: "agent_requirement_analyst", Key: "requirement-analyst", Name: "需求分析",
		Role: "requirement_analysis", Category: model.AgentCategorySoftware,
		Prompt: "software prompt", Editable: false, Enabled: true, SortOrder: 1,
	}
	if err := st.UpsertAgent(ctx, software); err != nil {
		t.Fatalf("upsert software: %v", err)
	}
	business := model.Agent{
		ID: "agent_maritime", Key: "maritime-alert-expert", Name: "海事预警专家",
		Role: "business", Description: "识别海事异常", Category: model.AgentCategoryBusiness,
		Prompt: "关注 AIS、海况、异常航迹", Editable: true, Enabled: true, SortOrder: 100,
	}
	if err := st.CreateAgent(ctx, business); err != nil {
		t.Fatalf("create business: %v", err)
	}
	got, err := st.ListAgentsByCategory(ctx, model.AgentCategoryBusiness)
	if err != nil {
		t.Fatalf("list business: %v", err)
	}
	if len(got) != 1 || got[0].Key != "maritime-alert-expert" || !got[0].Editable {
		t.Fatalf("business agents = %+v", got)
	}
}
```

- [ ] **Step 2: 实现分类查询和更新方法**

在 `factory-server/internal/store/agents.go` 新增：

```go
func (s *Store) ListAgentsByCategory(ctx context.Context, category model.AgentCategory) ([]model.Agent, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT id, key, name, role, description, claude_agent_name, skills_json, enabled, sort_order, category, prompt, editable
FROM agents
WHERE category = ?
ORDER BY sort_order ASC`, string(category))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]model.Agent, 0)
	for rows.Next() {
		a, err := scanAgent(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *a)
	}
	return out, rows.Err()
}

func (s *Store) UpdateBusinessAgent(ctx context.Context, a model.Agent) error {
	_, err := s.db.ExecContext(ctx, `
UPDATE agents
SET name = ?, role = ?, description = ?, claude_agent_name = ?, skills_json = ?, enabled = ?, prompt = ?, updated_at = updated_at
WHERE id = ? AND category = 'business' AND editable = 1`,
		a.Name, a.Role, a.Description, a.ClaudeAgentName, a.SkillsJSON, boolToInt(a.Enabled), a.Prompt, a.ID)
	return err
}
```

不要实际加入 `updated_at = updated_at`，因为 agents 表没有该列。最终 SQL 应为：

```sql
UPDATE agents
SET name = ?, role = ?, description = ?, claude_agent_name = ?, skills_json = ?, enabled = ?, prompt = ?
WHERE id = ? AND category = 'business' AND editable = 1
```

- [ ] **Step 3: 写 API 失败测试**

在 `factory-server/internal/server/agent_handlers_test.go` 新增：

```go
func TestListAgentsByCategory(t *testing.T) {
	_, r, st := newAgentTestServer(t)
	if err := st.CreateAgent(context.Background(), model.Agent{
		ID: "agent_maritime", Key: "maritime-alert-expert", Name: "海事预警专家",
		Role: "business", Description: "海事规则", Category: model.AgentCategoryBusiness,
		Prompt: "业务提示词", Editable: true, Enabled: true, SortOrder: 100,
	}); err != nil {
		t.Fatalf("create business agent: %v", err)
	}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/agents?category=business", nil)
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	var got []model.Agent
	if err := json.NewDecoder(rec.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got) != 1 || got[0].Category != model.AgentCategoryBusiness || got[0].Prompt == "" {
		t.Fatalf("agents = %+v", got)
	}
}
```

新增创建业务智能体测试：

```go
func TestCreateBusinessAgentEndpoint(t *testing.T) {
	_, r, _ := newAgentTestServer(t)
	body := strings.NewReader(`{"key":"maritime-alert-expert","name":"海事预警专家","description":"海事异常识别","prompt":"关注异常航迹","enabled":true}`)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/business-agents", body)
	r.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	var got model.Agent
	_ = json.NewDecoder(rec.Body).Decode(&got)
	if got.Category != model.AgentCategoryBusiness || !got.Editable || got.Role != "business" || got.Prompt == "" {
		t.Fatalf("agent = %+v", got)
	}
}
```

- [ ] **Step 4: 实现 handler**

在 `factory-server/internal/server/agent_handlers.go`：

`listAgents` 读取 query：

```go
category := strings.TrimSpace(r.URL.Query().Get("category"))
if category != "" {
	agents, err := s.store.ListAgentsByCategory(r.Context(), model.AgentCategory(category))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "list agents")
		return
	}
	writeJSON(w, http.StatusOK, agents)
	return
}
```

新增 body：

```go
type businessAgentBody struct {
	Key         string `json:"key"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Prompt      string `json:"prompt"`
	Enabled     *bool  `json:"enabled"`
}
```

新增 `createBusinessAgent`，关键校验：

```go
key := strings.TrimSpace(body.Key)
name := strings.TrimSpace(body.Name)
prompt := strings.TrimSpace(body.Prompt)
if key == "" || name == "" || prompt == "" {
	writeError(w, http.StatusBadRequest, "key, name, and prompt are required")
	return
}
```

创建 `model.Agent`：

```go
agent := model.Agent{
	ID:              agentIDFromKey(key),
	Key:             key,
	Name:            name,
	Role:            "business",
	Description:     strings.TrimSpace(body.Description),
	ClaudeAgentName: key,
	SkillsJSON:      "[]",
	Enabled:         enabled,
	SortOrder:       sortOrder,
	Category:        model.AgentCategoryBusiness,
	Prompt:          prompt,
	Editable:        true,
}
```

新增 `updateBusinessAgent` 和 `setBusinessAgentEnabled`，都先 `GetAgent`，要求：

```go
if agent == nil {
	writeError(w, http.StatusNotFound, "not found")
	return
}
if agent.Category != model.AgentCategoryBusiness || !agent.Editable {
	writeError(w, http.StatusForbidden, "software agents are read-only")
	return
}
```

- [ ] **Step 5: 注册路由**

在 `factory-server/internal/server/server.go` 注册：

```go
r.Handle("GET", "/api/agents/:id", s.getAgent)
r.Handle("POST", "/api/business-agents", s.createBusinessAgent)
r.Handle("PATCH", "/api/business-agents/:id", s.updateBusinessAgent)
r.Handle("PATCH", "/api/business-agents/:id/enabled", s.setBusinessAgentEnabled)
```

- [ ] **Step 6: 跑 API 测试**

Run:

```bash
cd factory-server && go test ./internal/server ./internal/store
```

Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add factory-server/internal/store/agents.go factory-server/internal/store/agents_test.go factory-server/internal/server/agent_handlers.go factory-server/internal/server/agent_handlers_test.go factory-server/internal/server/server.go
git commit -m "feat: add business agent APIs"
```

---

### Task 3: 会话多选业务智能体与确认生成快照

**Files:**
- Create: `factory-server/internal/store/business_agent_selection.go`
- Create: `factory-server/internal/store/business_agent_selection_test.go`
- Create: `factory-server/internal/server/clarification_business_agents_handlers.go`
- Modify: `factory-server/internal/server/clarification_handlers.go`
- Modify: `factory-server/internal/server/clarification_handlers_test.go`
- Modify: `factory-server/internal/server/server.go`
- Modify: `factory-server/internal/store/jobs.go`
- Modify: `factory-server/internal/model/model.go`

- [ ] **Step 1: 扩展 Job 模型和 store**

在 `model.Job` 增加：

```go
BusinessAgentSnapshotsJSON string `json:"business_agent_snapshots_json,omitempty"`
```

在 `factory-server/internal/store/jobs.go` 的 INSERT、SELECT、scanJob 添加 `business_agent_snapshots_json`。

INSERT 列：

```sql
business_agent_snapshots_json
```

参数：

```go
job.BusinessAgentSnapshotsJSON
```

scan：

```go
&j.BusinessAgentSnapshotsJSON
```

- [ ] **Step 2: 写选择 store 失败测试**

创建 `factory-server/internal/store/business_agent_selection_test.go`：

```go
package store

import (
	"context"
	"testing"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

func TestReplaceClarificationBusinessAgentsPersistsOrder(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	for _, a := range []model.Agent{
		{ID: "agent_a", Key: "a", Name: "A", Role: "business", Category: model.AgentCategoryBusiness, Prompt: "A prompt", Editable: true, Enabled: true, SortOrder: 100},
		{ID: "agent_b", Key: "b", Name: "B", Role: "business", Category: model.AgentCategoryBusiness, Prompt: "B prompt", Editable: true, Enabled: true, SortOrder: 101},
	} {
		if err := st.CreateAgent(ctx, a); err != nil {
			t.Fatalf("create agent %s: %v", a.ID, err)
		}
	}
	if err := st.ReplaceClarificationBusinessAgents(ctx, "clar_1", []string{"agent_b", "agent_a"}); err != nil {
		t.Fatalf("replace: %v", err)
	}
	got, err := st.ListClarificationBusinessAgents(ctx, "clar_1")
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(got) != 2 || got[0].ID != "agent_b" || got[1].ID != "agent_a" {
		t.Fatalf("got = %+v", got)
	}
}
```

- [ ] **Step 3: 实现选择 store**

创建 `factory-server/internal/store/business_agent_selection.go`：

```go
package store

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/weimengtsgit/xian630/factory-server/internal/model"
)

type BusinessAgentSnapshot struct {
	ID          string `json:"id"`
	Key         string `json:"key"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Enabled     bool   `json:"enabled"`
	Prompt      string `json:"prompt"`
}

func (s *Store) ReplaceClarificationBusinessAgents(ctx context.Context, sessionID string, agentIDs []string) error {
	seen := map[string]bool{}
	for _, id := range agentIDs {
		if id == "" || seen[id] {
			return fmt.Errorf("duplicate or empty agent id %q", id)
		}
		seen[id] = true
		a, err := s.GetAgent(ctx, id)
		if err != nil {
			return err
		}
		if a == nil {
			return fmt.Errorf("agent %s not found", id)
		}
		if a.Category != model.AgentCategoryBusiness {
			return fmt.Errorf("agent %s is not a business agent", id)
		}
		if !a.Enabled {
			return fmt.Errorf("agent %s is disabled", id)
		}
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `DELETE FROM clarification_business_agents WHERE clarification_session_id = ?`, sessionID); err != nil {
		return err
	}
	now := ms(time.Now())
	for i, id := range agentIDs {
		if _, err := tx.ExecContext(ctx, `
INSERT INTO clarification_business_agents(clarification_session_id, agent_id, priority, created_at)
VALUES(?,?,?,?)`, sessionID, id, i+1, now); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (s *Store) ListClarificationBusinessAgents(ctx context.Context, sessionID string) ([]model.Agent, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT a.id, a.key, a.name, a.role, a.description, a.claude_agent_name, a.skills_json, a.enabled, a.sort_order, a.category, a.prompt, a.editable
FROM clarification_business_agents cba
JOIN agents a ON a.id = cba.agent_id
WHERE cba.clarification_session_id = ?
ORDER BY cba.priority ASC`, sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []model.Agent{}
	for rows.Next() {
		a, err := scanAgent(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *a)
	}
	return out, rows.Err()
}

func (s *Store) BusinessAgentSnapshotsJSON(ctx context.Context, sessionID string) (string, error) {
	agents, err := s.ListClarificationBusinessAgents(ctx, sessionID)
	if err != nil {
		return "", err
	}
	snapshots := make([]BusinessAgentSnapshot, 0, len(agents))
	for _, a := range agents {
		if a.Category != model.AgentCategoryBusiness || !a.Enabled {
			return "", fmt.Errorf("selected business agent %s is unavailable", a.ID)
		}
		snapshots = append(snapshots, BusinessAgentSnapshot{
			ID: a.ID, Key: a.Key, Name: a.Name, Description: a.Description,
			Enabled: a.Enabled, Prompt: a.Prompt,
		})
	}
	raw, err := json.Marshal(snapshots)
	if err != nil {
		return "", err
	}
	return string(raw), nil
}
```

- [ ] **Step 4: 写 API 测试**

在 `clarification_handlers_test.go` 新增：

```go
func TestClarificationBusinessAgentsSelection(t *testing.T) {
	_, r, st := newClarTestServer(t, fakeClarRunner{stdout: readyToConfirmOutput})
	create := doPost(t, r, http.MethodPost, "/api/clarifications", map[string]string{"prompt": "生成航母编队复盘应用"})
	var sess model.ClarificationSession
	_ = json.NewDecoder(create.Body).Decode(&sess)
	for _, a := range []model.Agent{
		{ID: "agent_a", Key: "a", Name: "A", Role: "business", Category: model.AgentCategoryBusiness, Prompt: "A prompt", Editable: true, Enabled: true, SortOrder: 100},
		{ID: "agent_b", Key: "b", Name: "B", Role: "business", Category: model.AgentCategoryBusiness, Prompt: "B prompt", Editable: true, Enabled: true, SortOrder: 101},
	} {
		if err := st.CreateAgent(context.Background(), a); err != nil {
			t.Fatalf("create agent: %v", err)
		}
	}
	rec := doPost(t, r, http.MethodPut, "/api/clarifications/"+sess.ID+"/business-agents", map[string]any{
		"agent_ids": []string{"agent_b", "agent_a"},
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", rec.Code, rec.Body.String())
	}
	list := doPost(t, r, http.MethodGet, "/api/clarifications/"+sess.ID+"/business-agents", nil)
	var got []model.Agent
	_ = json.NewDecoder(list.Body).Decode(&got)
	if len(got) != 2 || got[0].ID != "agent_b" || got[1].ID != "agent_a" {
		t.Fatalf("got = %+v", got)
	}
}
```

- [ ] **Step 5: 实现选择 handler**

创建 `factory-server/internal/server/clarification_business_agents_handlers.go`：

```go
package server

import (
	"encoding/json"
	"net/http"
)

type clarificationBusinessAgentsBody struct {
	AgentIDs []string `json:"agent_ids"`
}

func (s *Server) listClarificationBusinessAgents(w http.ResponseWriter, r *http.Request) {
	agents, err := s.store.ListClarificationBusinessAgents(r.Context(), Param(r, "id"))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "list business agents")
		return
	}
	writeJSON(w, http.StatusOK, agents)
}

func (s *Server) replaceClarificationBusinessAgents(w http.ResponseWriter, r *http.Request) {
	var body clarificationBusinessAgentsBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid json")
		return
	}
	sess, err := s.store.GetClarificationSession(r.Context(), Param(r, "id"))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "get session")
		return
	}
	if sess == nil {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	if isTerminalClarificationStatus(sess.Status) {
		writeError(w, http.StatusConflict, "session is terminal")
		return
	}
	if err := s.store.ReplaceClarificationBusinessAgents(r.Context(), sess.ID, body.AgentIDs); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	agents, _ := s.store.ListClarificationBusinessAgents(r.Context(), sess.ID)
	writeJSON(w, http.StatusOK, agents)
}

func (s *Server) removeClarificationBusinessAgent(w http.ResponseWriter, r *http.Request) {
	agents, err := s.store.ListClarificationBusinessAgents(r.Context(), Param(r, "id"))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "list business agents")
		return
	}
	keep := make([]string, 0, len(agents))
	removeID := Param(r, "agent_id")
	for _, a := range agents {
		if a.ID != removeID {
			keep = append(keep, a.ID)
		}
	}
	if err := s.store.ReplaceClarificationBusinessAgents(r.Context(), Param(r, "id"), keep); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "removed"})
}
```

- [ ] **Step 6: 注册选择路由**

在 `server.go` 添加：

```go
r.Handle("GET", "/api/clarifications/:id/business-agents", s.listClarificationBusinessAgents)
r.Handle("PUT", "/api/clarifications/:id/business-agents", s.replaceClarificationBusinessAgents)
r.Handle("DELETE", "/api/clarifications/:id/business-agents/:agent_id", s.removeClarificationBusinessAgent)
```

- [ ] **Step 7: 确认生成写入快照**

在 `confirmClarification` 创建 `job := model.Job{...}` 前加入：

```go
snapshotsJSON, err := s.store.BusinessAgentSnapshotsJSON(r.Context(), id)
if err != nil {
	writeError(w, http.StatusBadRequest, "selected business agents unavailable")
	return
}
```

在 job 字段中加入：

```go
BusinessAgentSnapshotsJSON: snapshotsJSON,
```

- [ ] **Step 8: 写确认快照测试**

在 `clarification_handlers_test.go` 新增：

```go
func TestConfirmSnapshotsSelectedBusinessAgents(t *testing.T) {
	_, r, st := newClarTestServer(t, fakeClarRunner{stdout: readyToConfirmOutput})
	create := doPost(t, r, http.MethodPost, "/api/clarifications", map[string]string{"prompt": "生成航母编队复盘应用"})
	var sess model.ClarificationSession
	_ = json.NewDecoder(create.Body).Decode(&sess)
	if err := st.CreateAgent(context.Background(), model.Agent{
		ID: "agent_a", Key: "a", Name: "A", Role: "business",
		Category: model.AgentCategoryBusiness, Prompt: "A prompt", Editable: true, Enabled: true, SortOrder: 100,
	}); err != nil {
		t.Fatalf("create agent: %v", err)
	}
	_ = doPost(t, r, http.MethodPut, "/api/clarifications/"+sess.ID+"/business-agents", map[string]any{"agent_ids": []string{"agent_a"}})
	confirm := doPost(t, r, http.MethodPost, "/api/clarifications/"+sess.ID+"/confirm", nil)
	if confirm.Code != http.StatusOK {
		t.Fatalf("confirm status = %d body=%s", confirm.Code, confirm.Body.String())
	}
	jobs, err := st.ListJobs(context.Background(), "")
	if err != nil || len(jobs) != 1 {
		t.Fatalf("jobs = %+v err=%v", jobs, err)
	}
	if !strings.Contains(jobs[0].BusinessAgentSnapshotsJSON, "A prompt") {
		t.Fatalf("snapshot json = %s", jobs[0].BusinessAgentSnapshotsJSON)
	}
}
```

- [ ] **Step 9: 跑测试**

Run:

```bash
cd factory-server && go test ./internal/store ./internal/server
```

Expected: PASS。

- [ ] **Step 10: 提交**

```bash
git add factory-server/internal/model/model.go factory-server/internal/store/jobs.go factory-server/internal/store/business_agent_selection.go factory-server/internal/store/business_agent_selection_test.go factory-server/internal/server/clarification_business_agents_handlers.go factory-server/internal/server/clarification_handlers.go factory-server/internal/server/clarification_handlers_test.go factory-server/internal/server/server.go
git commit -m "feat: attach business agents to clarifications"
```

---

### Task 4: Claude 前三阶段注入业务智能体上下文

**Files:**
- Modify: `factory-server/internal/executor/claude_runner.go`
- Modify: `factory-server/internal/executor/claude_runner_test.go`

- [ ] **Step 1: 写提示词注入测试**

在 `claude_runner_test.go` 新增：

```go
func TestBusinessAgentContextOnlyInjectedIntoClaudeGenerationStages(t *testing.T) {
	job := model.Job{
		ID: "job_1",
		UserPrompt: "生成海事预警看板",
		BusinessAgentSnapshotsJSON: `[{"id":"agent_a","key":"maritime-alert-expert","name":"海事预警专家","description":"海事规则","enabled":true,"prompt":"必须突出 AIS 异常航迹"}]`,
	}
	c := &ClaudeStepRunner{Workspace: t.TempDir()}
	ws := runner.AttemptWorkspace{Root: t.TempDir(), JobID: job.ID, StepKind: model.StepSolutionDesign, Attempt: 1}
	prompt := c.prompt(job, model.JobStep{Kind: model.StepSolutionDesign}, ws, nil, nil)
	if !strings.Contains(prompt, "本次任务绑定了多个业务智能体") || !strings.Contains(prompt, "必须突出 AIS 异常航迹") {
		t.Fatalf("business context missing from solution prompt: %s", prompt)
	}
	codePrompt := c.prompt(job, model.JobStep{Kind: model.StepCodeGeneration}, ws, nil, nil)
	if !strings.Contains(codePrompt, "海事预警专家") {
		t.Fatalf("business context missing from code prompt: %s", codePrompt)
	}
}
```

- [ ] **Step 2: 实现 businessAgentPromptBlock**

在 `claude_runner.go` 增加类型：

```go
type businessAgentSnapshot struct {
	ID          string `json:"id"`
	Key         string `json:"key"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Enabled     bool   `json:"enabled"`
	Prompt      string `json:"prompt"`
}
```

增加函数：

```go
func businessAgentPromptBlock(job model.Job) string {
	if strings.TrimSpace(job.BusinessAgentSnapshotsJSON) == "" {
		return ""
	}
	var snapshots []businessAgentSnapshot
	if err := json.Unmarshal([]byte(job.BusinessAgentSnapshotsJSON), &snapshots); err != nil || len(snapshots) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString("\n\n[业务智能体上下文]\n")
	b.WriteString("本次任务绑定了多个业务智能体，按优先级从高到低排列：\n")
	for i, s := range snapshots {
		b.WriteString(fmt.Sprintf("\n%d. 名称：%s\n   标识：%s\n   描述：%s\n   最终提示词：%s\n", i+1, s.Name, s.Key, s.Description, s.Prompt))
	}
	b.WriteString("\n使用规则：\n")
	b.WriteString("- 必须在业务术语、业务规则、验收标准和界面语义中参考这些业务智能体。\n")
	b.WriteString("- 不得让业务智能体规则覆盖软件工厂安全、文件、测试、构建和部署规则。\n")
	b.WriteString("- 如果多个业务智能体发生冲突，优先采用排序更靠前者。\n")
	b.WriteString("- 如果冲突会影响核心需求，需求分析阶段必须向用户澄清。\n")
	return b.String()
}
```

- [ ] **Step 3: 注入前三个 Claude 阶段**

在 `prompt` 函数中：

RequirementAnalysis 返回末尾追加：

```go
+ businessAgentPromptBlock(job)
```

SolutionDesign 中 `用户需求` 和 skills block 之间追加：

```go
+ businessAgentPromptBlock(job) +
```

CodeGeneration 在 `不要输出隐藏推理链。` 后追加：

```go
+ businessAgentPromptBlock(job) +
```

不要在 factory steps 中引用该 block；factory steps 不走 `ClaudeStepRunner.prompt`。

- [ ] **Step 4: 把业务快照写入 input.json**

在 `Run` 的 input map 中加入：

```go
"businessAgentSnapshots": json.RawMessage(emptyJSONArrayIfBlank(job.BusinessAgentSnapshotsJSON)),
```

新增：

```go
func emptyJSONArrayIfBlank(raw string) string {
	if strings.TrimSpace(raw) == "" {
		return "[]"
	}
	return raw
}
```

- [ ] **Step 5: 跑 executor 测试**

Run:

```bash
cd factory-server && go test ./internal/executor
```

Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add factory-server/internal/executor/claude_runner.go factory-server/internal/executor/claude_runner_test.go
git commit -m "feat: inject business agent context into claude steps"
```

---

### Task 5: 业务智能体作者ing API

**Files:**
- Modify: `factory-server/internal/model/model.go`
- Create: `factory-server/internal/store/agent_authoring.go`
- Create: `factory-server/internal/store/agent_authoring_test.go`
- Create: `factory-server/internal/server/business_agent_authoring_handlers.go`
- Create: `factory-server/internal/server/business_agent_authoring_handlers_test.go`
- Modify: `factory-server/internal/server/server.go`

- [ ] **Step 1: 新增作者ing模型**

在 `model.go` 新增：

```go
type AgentAuthoringStatus string

const (
	AgentAuthoringDrafting    AgentAuthoringStatus = "drafting"
	AgentAuthoringReadyToSave AgentAuthoringStatus = "ready_to_save"
	AgentAuthoringSaved       AgentAuthoringStatus = "saved"
	AgentAuthoringAbandoned   AgentAuthoringStatus = "abandoned"
	AgentAuthoringFailed      AgentAuthoringStatus = "failed"
)

type AgentAuthoringSession struct {
	ID            string               `json:"id"`
	Mode          string               `json:"mode"`
	TargetAgentID string               `json:"target_agent_id,omitempty"`
	Status        AgentAuthoringStatus `json:"status"`
	DraftJSON     string               `json:"draft_json"`
	CreatedAt     time.Time            `json:"created_at"`
	UpdatedAt     time.Time            `json:"updated_at"`
}

type AgentAuthoringMessage struct {
	ID           string    `json:"id"`
	SessionID    string    `json:"session_id"`
	Role         string    `json:"role"`
	Kind         string    `json:"kind"`
	Content      string    `json:"content"`
	MetadataJSON string    `json:"metadata_json"`
	CreatedAt    time.Time `json:"created_at"`
}
```

- [ ] **Step 2: 写 store 测试**

创建 `agent_authoring_test.go`，验证创建 session、追加 message、更新 draft：

```go
func TestAgentAuthoringSessionDraftLifecycle(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()
	sess := model.AgentAuthoringSession{
		ID: "auth_1", Mode: "create", Status: model.AgentAuthoringDrafting,
		DraftJSON: `{}`, CreatedAt: time.Now(), UpdatedAt: time.Now(),
	}
	if err := st.CreateAgentAuthoringSession(ctx, sess); err != nil {
		t.Fatalf("create session: %v", err)
	}
	if err := st.CreateAgentAuthoringMessage(ctx, model.AgentAuthoringMessage{
		ID: "msg_1", SessionID: "auth_1", Role: "user", Kind: "message", Content: "做海事预警", CreatedAt: time.Now(),
	}); err != nil {
		t.Fatalf("create message: %v", err)
	}
	if err := st.UpdateAgentAuthoringDraft(ctx, "auth_1", `{"name":"海事预警专家"}`, model.AgentAuthoringReadyToSave); err != nil {
		t.Fatalf("update draft: %v", err)
	}
	got, err := st.GetAgentAuthoringSession(ctx, "auth_1")
	if err != nil || got.Status != model.AgentAuthoringReadyToSave || !strings.Contains(got.DraftJSON, "海事预警专家") {
		t.Fatalf("got=%+v err=%v", got, err)
	}
}
```

- [ ] **Step 3: 实现 store**

创建 `agent_authoring.go`，包含：

```go
func (s *Store) CreateAgentAuthoringSession(ctx context.Context, sess model.AgentAuthoringSession) error
func (s *Store) GetAgentAuthoringSession(ctx context.Context, id string) (*model.AgentAuthoringSession, error)
func (s *Store) CreateAgentAuthoringMessage(ctx context.Context, msg model.AgentAuthoringMessage) error
func (s *Store) ListAgentAuthoringMessages(ctx context.Context, sessionID string) ([]model.AgentAuthoringMessage, error)
func (s *Store) UpdateAgentAuthoringDraft(ctx context.Context, id, draftJSON string, status model.AgentAuthoringStatus) error
```

SQL 使用 schema 中的 `agent_authoring_sessions` 和 `agent_authoring_messages`。

- [ ] **Step 4: 写 API 测试**

创建 `business_agent_authoring_handlers_test.go`：

```go
func TestBusinessAgentAuthoringFinalizeCreatesAgent(t *testing.T) {
	_, r, _ := newAgentTestServer(t)
	start := doJSON(t, r, http.MethodPost, "/api/business-agent-authoring", map[string]string{"mode": "create"})
	if start.Code != http.StatusCreated {
		t.Fatalf("start status=%d body=%s", start.Code, start.Body.String())
	}
	var sess model.AgentAuthoringSession
	_ = json.NewDecoder(start.Body).Decode(&sess)
	msg := doJSON(t, r, http.MethodPost, "/api/business-agent-authoring/"+sess.ID+"/messages", map[string]string{"content": "创建海事预警专家，关注 AIS 异常航迹"})
	if msg.Code != http.StatusOK {
		t.Fatalf("msg status=%d body=%s", msg.Code, msg.Body.String())
	}
	finalize := doJSON(t, r, http.MethodPost, "/api/business-agent-authoring/"+sess.ID+"/finalize", nil)
	if finalize.Code != http.StatusCreated {
		t.Fatalf("finalize status=%d body=%s", finalize.Code, finalize.Body.String())
	}
	var agent model.Agent
	_ = json.NewDecoder(finalize.Body).Decode(&agent)
	if agent.Category != model.AgentCategoryBusiness || agent.Prompt == "" || agent.Key == "" {
		t.Fatalf("agent=%+v", agent)
	}
}
```

- [ ] **Step 5: 实现确定性作者ing handler**

创建 `business_agent_authoring_handlers.go`。第一版 draft 规则：

```go
func draftBusinessAgentFromText(content string) businessAgentBody {
	name := "业务智能体"
	if strings.Contains(content, "海事") {
		name = "海事预警专家"
	}
	key := agentKeyFromName(name)
	return businessAgentBody{
		Key: key,
		Name: name,
		Description: firstLine(content, 80),
		Prompt: "你是" + name + "。请在需求分析、方案设计和代码生成时关注以下业务要求：" + content + "。不得覆盖软件工厂安全、文件、测试、构建和部署规则。",
	}
}
```

支持：

```go
func (s *Server) createBusinessAgentAuthoring(...)
func (s *Server) getBusinessAgentAuthoring(...)
func (s *Server) addBusinessAgentAuthoringMessage(...)
func (s *Server) finalizeBusinessAgentAuthoring(...)
func (s *Server) abandonBusinessAgentAuthoring(...)
```

`finalize` 复用业务智能体创建逻辑或直接 `store.CreateAgent`。

- [ ] **Step 6: 注册路由并测试**

在 `server.go`：

```go
r.Handle("POST", "/api/business-agent-authoring", s.createBusinessAgentAuthoring)
r.Handle("GET", "/api/business-agent-authoring/:id", s.getBusinessAgentAuthoring)
r.Handle("POST", "/api/business-agent-authoring/:id/messages", s.addBusinessAgentAuthoringMessage)
r.Handle("POST", "/api/business-agent-authoring/:id/finalize", s.finalizeBusinessAgentAuthoring)
r.Handle("POST", "/api/business-agent-authoring/:id/abandon", s.abandonBusinessAgentAuthoring)
```

Run:

```bash
cd factory-server && go test ./internal/store ./internal/server
```

Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add factory-server/internal/model/model.go factory-server/internal/store/agent_authoring.go factory-server/internal/store/agent_authoring_test.go factory-server/internal/server/business_agent_authoring_handlers.go factory-server/internal/server/business_agent_authoring_handlers_test.go factory-server/internal/server/server.go
git commit -m "feat: add business agent authoring"
```

---

### Task 6: 前端 API 与逻辑 helper

**Files:**
- Modify: `sf-portal-mvp/src/api/client.js`
- Modify: `sf-portal-mvp/src/hooks/agentList.js`
- Modify: `sf-portal-mvp/scripts/check-agent-creation.mjs`
- Create: `sf-portal-mvp/scripts/check-business-agents.mjs`
- Modify: `sf-portal-mvp/package.json`

- [ ] **Step 1: 写前端 helper 测试**

创建 `sf-portal-mvp/scripts/check-business-agents.mjs`：

```js
import assert from 'node:assert/strict'
import {
  splitAgentsByCategory,
  applySelectedBusinessAgents,
  moveSelectedBusinessAgent,
} from '../src/hooks/agentList.js'

const agents = [
  { id: 'agent_req', key: 'requirement-analyst', category: 'software', sort_order: 1 },
  { id: 'agent_b', key: 'b', category: 'business', sort_order: 101 },
  { id: 'agent_a', key: 'a', category: 'business', sort_order: 100 },
]

const split = splitAgentsByCategory(agents)
assert.deepEqual(split.software.map(a => a.key), ['requirement-analyst'])
assert.deepEqual(split.business.map(a => a.key), ['a', 'b'])

const marked = applySelectedBusinessAgents(split.business, ['agent_b', 'agent_a'])
assert.deepEqual(marked.map(a => [a.id, a.selectedPriority]), [
  ['agent_a', 2],
  ['agent_b', 1],
])

assert.deepEqual(moveSelectedBusinessAgent(['agent_b', 'agent_a', 'agent_c'], 'agent_a', -1), [
  'agent_a',
  'agent_b',
  'agent_c',
])
assert.deepEqual(moveSelectedBusinessAgent(['agent_b', 'agent_a'], 'agent_b', -1), ['agent_b', 'agent_a'])
```

- [ ] **Step 2: 实现 helper**

在 `agentList.js` 添加：

```js
export function sortAgentsForDisplay(agents) {
  return [...(Array.isArray(agents) ? agents : [])].sort(
    (a, b) => (a.sort_order || 0) - (b.sort_order || 0),
  )
}

export function splitAgentsByCategory(agents) {
  const sorted = sortAgentsForDisplay(agents)
  return {
    software: sorted.filter(agent => agent.category === 'software'),
    business: sorted.filter(agent => agent.category === 'business' || !agent.category),
  }
}

export function applySelectedBusinessAgents(agents, selectedIds) {
  const priority = new Map((selectedIds || []).map((id, index) => [id, index + 1]))
  return sortAgentsForDisplay(agents).map(agent => ({
    ...agent,
    isSelectedForConversation: priority.has(agent.id),
    selectedPriority: priority.get(agent.id) || 0,
  }))
}

export function moveSelectedBusinessAgent(selectedIds, id, delta) {
  const next = [...(selectedIds || [])]
  const index = next.indexOf(id)
  if (index < 0) return next
  const target = index + delta
  if (target < 0 || target >= next.length) return next
  const [item] = next.splice(index, 1)
  next.splice(target, 0, item)
  return next
}
```

修改 `appendCreatedAgentForDisplay` 使用 `sortAgentsForDisplay`。

- [ ] **Step 3: 扩展 API client**

在 `client.js` 加：

```js
getAgent: id => request(`/api/agents/${id}`),
listSoftwareAgents: () => request('/api/agents?category=software'),
listBusinessAgents: () => request('/api/agents?category=business'),
createBusinessAgent: agent => request('/api/business-agents', { method: 'POST', body: JSON.stringify(agent) }),
updateBusinessAgent: (id, agent) => request(`/api/business-agents/${id}`, { method: 'PATCH', body: JSON.stringify(agent) }),
setBusinessAgentEnabled: (id, enabled) => request(`/api/business-agents/${id}/enabled`, { method: 'PATCH', body: JSON.stringify({ enabled }) }),
createBusinessAgentAuthoring: body => request('/api/business-agent-authoring', { method: 'POST', body: JSON.stringify(body || { mode: 'create' }) }),
sendBusinessAgentAuthoringMessage: (id, content) => request(`/api/business-agent-authoring/${id}/messages`, { method: 'POST', body: JSON.stringify({ content }) }),
finalizeBusinessAgentAuthoring: id => request(`/api/business-agent-authoring/${id}/finalize`, { method: 'POST' }),
getClarificationBusinessAgents: id => request(`/api/clarifications/${id}/business-agents`),
replaceClarificationBusinessAgents: (id, agentIds) => request(`/api/clarifications/${id}/business-agents`, { method: 'PUT', body: JSON.stringify({ agent_ids: agentIds }) }),
removeClarificationBusinessAgent: (id, agentId) => request(`/api/clarifications/${id}/business-agents/${agentId}`, { method: 'DELETE' }),
```

- [ ] **Step 4: 更新 package 脚本**

在 `package.json` 的 `test:logic` 末尾追加：

```json
" && node scripts/check-business-agents.mjs"
```

- [ ] **Step 5: 跑前端逻辑测试**

Run:

```bash
cd sf-portal-mvp && npm run test:logic
```

Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add sf-portal-mvp/src/api/client.js sf-portal-mvp/src/hooks/agentList.js sf-portal-mvp/scripts/check-agent-creation.mjs sf-portal-mvp/scripts/check-business-agents.mjs sf-portal-mvp/package.json
git commit -m "feat: add business agent frontend helpers"
```

---

### Task 7: 前端 hooks 接入业务智能体与会话选择

**Files:**
- Modify: `sf-portal-mvp/src/hooks/useAgents.js`
- Modify: `sf-portal-mvp/src/hooks/useConversationSessions.js`
- Modify: `sf-portal-mvp/src/App.jsx`

- [ ] **Step 1: 扩展 useAgents**

在 `useAgents.js` 引入：

```js
import { appendCreatedAgentForDisplay, splitAgentsByCategory } from './agentList'
```

新增 state 派生：

```js
const { software: softwareAgents, business: businessAgents } = splitAgentsByCategory(agents)
```

新增方法：

```js
const createBusinessAgent = useCallback(async agent => {
  setError(null)
  const created = await factoryApi.createBusinessAgent(agent)
  setAgents(current => appendCreatedAgentForDisplay(current, created))
  return created
}, [])

const updateBusinessAgent = useCallback(async (id, agent) => {
  setError(null)
  const updated = await factoryApi.updateBusinessAgent(id, agent)
  setAgents(current => current.map(item => item.id === updated.id ? updated : item))
  return updated
}, [])

const setBusinessAgentEnabled = useCallback(async (id, enabled) => {
  setError(null)
  const updated = await factoryApi.setBusinessAgentEnabled(id, enabled)
  setAgents(current => current.map(item => item.id === updated.id ? updated : item))
  return updated
}, [])

const createAuthoringSession = useCallback(body => factoryApi.createBusinessAgentAuthoring(body), [])
const sendAuthoringMessage = useCallback((id, content) => factoryApi.sendBusinessAgentAuthoringMessage(id, content), [])
const finalizeAuthoring = useCallback(async id => {
  const created = await factoryApi.finalizeBusinessAgentAuthoring(id)
  setAgents(current => appendCreatedAgentForDisplay(current, created))
  return created
}, [])
```

return 增加：

```js
softwareAgents,
businessAgents,
createBusinessAgent,
updateBusinessAgent,
setBusinessAgentEnabled,
createAuthoringSession,
sendAuthoringMessage,
finalizeAuthoring,
```

- [ ] **Step 2: 扩展 useConversationSessions**

在 hook 中新增 state：

```js
const [selectedBusinessAgents, setSelectedBusinessAgents] = useState([])
const selectedBusinessAgentIds = selectedBusinessAgents.map(agent => agent.id)
```

在选择会话成功后加载：

```js
const loadBusinessAgentsForSession = useCallback(async sessionId => {
  if (!sessionId) {
    setSelectedBusinessAgents([])
    return []
  }
  const agents = await factoryApi.getClarificationBusinessAgents(sessionId)
  setSelectedBusinessAgents(Array.isArray(agents) ? agents : [])
  return agents
}, [])
```

在 `selectSession` 和 hydrate 当前 session 后调用 `loadBusinessAgentsForSession(id)`。

新增操作：

```js
const replaceBusinessAgents = useCallback(async agentIds => {
  if (!session?.id) return []
  const agents = await factoryApi.replaceClarificationBusinessAgents(session.id, agentIds)
  setSelectedBusinessAgents(Array.isArray(agents) ? agents : [])
  return agents
}, [session?.id])

const addBusinessAgent = useCallback(agent => {
  if (!agent?.id || selectedBusinessAgentIds.includes(agent.id)) return Promise.resolve(selectedBusinessAgents)
  return replaceBusinessAgents([...selectedBusinessAgentIds, agent.id])
}, [replaceBusinessAgents, selectedBusinessAgentIds, selectedBusinessAgents])

const removeBusinessAgent = useCallback(agentId => {
  return replaceBusinessAgents(selectedBusinessAgentIds.filter(id => id !== agentId))
}, [replaceBusinessAgents, selectedBusinessAgentIds])

const moveBusinessAgent = useCallback((agentId, delta) => {
  return replaceBusinessAgents(moveSelectedBusinessAgent(selectedBusinessAgentIds, agentId, delta))
}, [replaceBusinessAgents, selectedBusinessAgentIds])
```

return 增加：

```js
selectedBusinessAgents,
selectedBusinessAgentIds,
addBusinessAgent,
removeBusinessAgent,
moveBusinessAgent,
replaceBusinessAgents,
```

- [ ] **Step 3: App 传递 props**

在 `App.jsx` 的 `AgentsPanel` 传入：

```jsx
softwareAgents={agents.softwareAgents}
businessAgents={agents.businessAgents}
selectedBusinessAgentIds={conversation.selectedBusinessAgentIds}
onAddBusinessAgent={conversation.addBusinessAgent}
onRemoveBusinessAgent={conversation.removeBusinessAgent}
onCreateAuthoringSession={agents.createAuthoringSession}
onSendAuthoringMessage={agents.sendAuthoringMessage}
onFinalizeAuthoring={agents.finalizeAuthoring}
onUpdateBusinessAgent={agents.updateBusinessAgent}
onSetBusinessAgentEnabled={agents.setBusinessAgentEnabled}
```

在 `ConversationWorkbench` 传入：

```jsx
selectedBusinessAgents={conversation.selectedBusinessAgents}
onRemoveBusinessAgent={conversation.removeBusinessAgent}
onMoveBusinessAgent={conversation.moveBusinessAgent}
```

- [ ] **Step 4: 跑 build 捕获语法问题**

Run:

```bash
cd sf-portal-mvp && npm run build
```

Expected: PASS 或只因组件尚未使用新 props 无视觉变化；若 import 缺失，修复。

- [ ] **Step 5: 提交**

```bash
git add sf-portal-mvp/src/hooks/useAgents.js sf-portal-mvp/src/hooks/useConversationSessions.js sf-portal-mvp/src/App.jsx
git commit -m "feat: wire business agent selection hooks"
```

---

### Task 8: 右侧双 Tab 智能体面板与作者ing弹窗

**Files:**
- Modify: `sf-portal-mvp/src/components/AgentsPanel.jsx`
- Modify: `sf-portal-mvp/src/components/AgentsPanel.css`

- [ ] **Step 1: 重构 AgentsPanel props**

保持兼容老 props，函数签名改为：

```jsx
export function AgentsPanel({
  agents,
  softwareAgents,
  businessAgents,
  loading,
  error,
  selectedBusinessAgentIds = [],
  onAddBusinessAgent,
  onRemoveBusinessAgent,
  onCreateAuthoringSession,
  onSendAuthoringMessage,
  onFinalizeAuthoring,
  onUpdateBusinessAgent,
  onSetBusinessAgentEnabled,
}) {
```

内部 fallback：

```js
const fallbackSplit = splitAgentsByCategory(Array.isArray(agents) ? agents : [])
const softwareList = Array.isArray(softwareAgents) ? softwareAgents : fallbackSplit.software
const businessList = applySelectedBusinessAgents(
  Array.isArray(businessAgents) ? businessAgents : fallbackSplit.business,
  selectedBusinessAgentIds,
)
```

新增：

```js
const [activeTab, setActiveTab] = useState('software')
```

- [ ] **Step 2: 实现 Tab header**

替换 panel header action 区：

```jsx
<div className="agent-tabs" role="tablist" aria-label="智能体分类">
  <button type="button" className={`agent-tab ${activeTab === 'software' ? 'is-active' : ''}`} onClick={() => setActiveTab('software')}>
    软件开发智能体 <span>{softwareList.length}</span>
  </button>
  <button type="button" className={`agent-tab ${activeTab === 'business' ? 'is-active' : ''}`} onClick={() => setActiveTab('business')}>
    业务智能体 <span>{businessList.length}</span>
  </button>
</div>
```

新增按钮只在业务 Tab：

```jsx
{activeTab === 'business' && (
  <button type="button" className="agent-icon-button" onClick={openAuthoringDialog} title="新增业务智能体" aria-label="新增业务智能体">
    <Plus size={16} />
  </button>
)}
```

- [ ] **Step 3: 软件智能体详情只读 prompt**

软件卡片点击仍打开详情。详情中显示：

```jsx
{selectedAgent.prompt && (
  <section className="agent-prompt-section">
    <h4>最终提示词</h4>
    <pre className="agent-skills">{selectedAgent.prompt}</pre>
  </section>
)}
```

不要显示任何保存按钮。

- [ ] **Step 4: 业务卡片加入/移除当前会话**

业务列表卡片 footer：

```jsx
<div className="agent-card-actions">
  {agent.isSelectedForConversation ? (
    <button type="button" className="agent-secondary-button compact" onClick={event => { event.stopPropagation(); onRemoveBusinessAgent?.(agent.id) }}>
      已加入 #{agent.selectedPriority}
    </button>
  ) : (
    <button type="button" className="agent-primary-button compact" disabled={agent.enabled === false} onClick={event => { event.stopPropagation(); onAddBusinessAgent?.(agent) }}>
      加入本次会话
    </button>
  )}
</div>
```

禁用业务智能体的按钮 disabled。

- [ ] **Step 5: 作者ing弹窗**

用现有 dialog 样式实现：

State:

```js
const [authoringOpen, setAuthoringOpen] = useState(false)
const [authoringSession, setAuthoringSession] = useState(null)
const [authoringMessages, setAuthoringMessages] = useState([])
const [authoringInput, setAuthoringInput] = useState('')
```

打开：

```js
const openAuthoringDialog = async () => {
  setAuthoringOpen(true)
  setAuthoringMessages([])
  const session = await onCreateAuthoringSession?.({ mode: 'create' })
  setAuthoringSession(session)
}
```

发送：

```js
const submitAuthoringMessage = async event => {
  event.preventDefault()
  const content = authoringInput.trim()
  if (!content || !authoringSession?.id) return
  setAuthoringMessages(current => [...current, { role: 'user', content }])
  setAuthoringInput('')
  const updated = await onSendAuthoringMessage?.(authoringSession.id, content)
  setAuthoringSession(updated)
  setAuthoringMessages(current => [...current, { role: 'agent', content: '已生成业务智能体草稿，可继续调整或确认保存。' }])
}
```

保存：

```js
const finalizeAuthoring = async () => {
  if (!authoringSession?.id) return
  await onFinalizeAuthoring?.(authoringSession.id)
  setAuthoringOpen(false)
}
```

- [ ] **Step 6: CSS**

在 `AgentsPanel.css` 增加：

```css
.agent-tabs { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; padding: 10px 12px 0; }
.agent-tab { border: 1px solid rgba(111, 218, 255, 0.18); border-radius: 6px; padding: 7px 8px; color: #8fb0bf; background: rgba(3, 17, 29, 0.64); cursor: pointer; font-size: 12px; }
.agent-tab.is-active { color: #edfaff; border-color: rgba(104, 221, 255, 0.52); background: rgba(104, 221, 255, 0.12); }
.agent-tab span { margin-left: 4px; color: #68ddff; }
.agent-card-actions { grid-column: 2; display: flex; justify-content: flex-end; margin-top: 6px; }
.agent-primary-button.compact, .agent-secondary-button.compact { min-width: 0; padding: 5px 8px; font-size: 11px; }
.agent-prompt-section h4 { margin: 12px 0 6px; color: #a5bdca; font-size: 12px; font-weight: 600; }
.authoring-thread { display: grid; gap: 8px; max-height: 220px; overflow: auto; margin-bottom: 10px; }
.authoring-message { padding: 8px; border: 1px solid rgba(111, 218, 255, 0.14); border-radius: 6px; color: #d4ecf7; background: rgba(3, 17, 29, 0.62); font-size: 12px; line-height: 1.5; }
```

- [ ] **Step 7: 跑 build**

Run:

```bash
cd sf-portal-mvp && npm run build
```

Expected: PASS。

- [ ] **Step 8: 提交**

```bash
git add sf-portal-mvp/src/components/AgentsPanel.jsx sf-portal-mvp/src/components/AgentsPanel.css
git commit -m "feat: add tabbed agents panel"
```

---

### Task 9: 会话工作台展示多选业务智能体

**Files:**
- Modify: `sf-portal-mvp/src/components/ConversationWorkbench.jsx`
- Modify: `sf-portal-mvp/src/components/ConversationWorkbench.css`
- Modify: `sf-portal-mvp/scripts/check-conversation-workbench.mjs`

- [ ] **Step 1: 增加组件 props**

`ConversationWorkbench` 签名增加：

```jsx
selectedBusinessAgents = [],
onRemoveBusinessAgent,
onMoveBusinessAgent,
```

- [ ] **Step 2: 在 header/确认区渲染业务智能体 chips**

在会话 header 下方加入：

```jsx
{selectedBusinessAgents.length > 0 && (
  <div className="cw-business-agents" aria-label="本次业务智能体">
    <span className="cw-business-label">本次业务智能体</span>
    <div className="cw-business-chips">
      {selectedBusinessAgents.map((agent, index) => (
        <span className="cw-business-chip" key={agent.id}>
          <span>{index + 1}. {agent.name || agent.key}</span>
          <button type="button" onClick={() => onMoveBusinessAgent?.(agent.id, -1)} disabled={index === 0} aria-label={`上移${agent.name || agent.key}`}>↑</button>
          <button type="button" onClick={() => onMoveBusinessAgent?.(agent.id, 1)} disabled={index === selectedBusinessAgents.length - 1} aria-label={`下移${agent.name || agent.key}`}>↓</button>
          <button type="button" onClick={() => onRemoveBusinessAgent?.(agent.id)} aria-label={`移除${agent.name || agent.key}`}>×</button>
        </span>
      ))}
    </div>
  </div>
)}
```

如果项目已使用 lucide icon，这里可用 `ChevronUp`、`ChevronDown`、`X` 替代文本按钮；按钮必须有 `aria-label`。

- [ ] **Step 3: 添加 CSS**

```css
.cw-business-agents { display: flex; align-items: flex-start; gap: 8px; padding: 8px 12px; border-bottom: 1px solid rgba(111, 218, 255, 0.14); background: rgba(104, 221, 255, 0.04); }
.cw-business-label { flex: 0 0 auto; color: #8fb0bf; font-size: 12px; line-height: 24px; }
.cw-business-chips { display: flex; flex-wrap: wrap; gap: 6px; min-width: 0; }
.cw-business-chip { display: inline-flex; align-items: center; gap: 4px; min-height: 24px; max-width: 100%; border: 1px solid rgba(104, 221, 255, 0.28); border-radius: 6px; padding: 3px 5px 3px 8px; color: #d4ecf7; background: rgba(3, 17, 29, 0.72); font-size: 12px; }
.cw-business-chip span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cw-business-chip button { width: 20px; height: 20px; border: 1px solid rgba(111, 218, 255, 0.18); border-radius: 4px; color: #68ddff; background: rgba(104, 221, 255, 0.06); cursor: pointer; }
.cw-business-chip button:disabled { opacity: 0.35; cursor: not-allowed; }
```

- [ ] **Step 4: 更新逻辑测试**

在 `check-conversation-workbench.mjs` 加一个静态源码断言：

```js
assert.match(source, /selectedBusinessAgents/)
assert.match(source, /本次业务智能体/)
assert.match(css, /\.cw-business-chip/)
```

- [ ] **Step 5: 跑测试和 build**

Run:

```bash
cd sf-portal-mvp && npm run test:logic && npm run build
```

Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add sf-portal-mvp/src/components/ConversationWorkbench.jsx sf-portal-mvp/src/components/ConversationWorkbench.css sf-portal-mvp/scripts/check-conversation-workbench.mjs
git commit -m "feat: show selected business agents in conversations"
```

---

### Task 10: 端到端回归和文档核对

**Files:**
- Modify if needed: `docs/superpowers/specs/2026-06-23-business-agents-design.md`
- Modify if needed: `docs/software-factory-local-runbook.md`

- [ ] **Step 1: 后端完整测试**

Run:

```bash
cd factory-server && go test ./...
```

Expected: PASS。

- [ ] **Step 2: 前端逻辑测试**

Run:

```bash
cd sf-portal-mvp && npm run test:logic
```

Expected: PASS。

- [ ] **Step 3: 前端构建**

Run:

```bash
cd sf-portal-mvp && npm run build
```

Expected: PASS，输出包含 `dist` 构建成功。

- [ ] **Step 4: 手工 API 冒烟**

启动后端和前端后执行：

```bash
curl http://127.0.0.1:8787/api/agents?category=software
curl http://127.0.0.1:8787/api/agents?category=business
```

Expected:

- software 返回 6 条。
- business 返回数组，初始可为空。

创建业务智能体：

```bash
curl -X POST http://127.0.0.1:8787/api/business-agents ^
  -H "Content-Type: application/json" ^
  -d "{\"key\":\"maritime-alert-expert\",\"name\":\"海事预警专家\",\"description\":\"识别海事异常\",\"prompt\":\"关注 AIS 异常航迹和预警分级\",\"enabled\":true}"
```

Expected: 201，响应包含 `category:"business"`、`editable:true`。

- [ ] **Step 5: 核对 spec 覆盖**

逐项核对：

- 右侧双 Tab 已实现。
- 软件开发智能体 6 个且只读 prompt。
- 业务智能体可创建、编辑、启停、查看 prompt。
- 会话可选择多个业务智能体。
- 顺序即优先级。
- 确认生成写 job 快照。
- 只注入前三个阶段。

如发现实现偏差，只修改实现；除非产品决策变化，不改 spec。

- [ ] **Step 6: 最终提交**

如果 Step 1-5 有补丁：

```bash
git add factory-server sf-portal-mvp docs
git commit -m "test: verify business agents workflow"
```

如果没有补丁，不提交空 commit。

---

## 自检清单

- Spec 覆盖：本计划覆盖双 Tab、六个软件智能体、只读 prompt、业务智能体 CRUD、作者ing、会话多选、优先级、确认快照、前三阶段注入、测试和验证。
- 无占位符：本文没有未决标记；第一版作者ing明确为确定性草稿生成，不留空实现。
- 类型一致性：后端统一使用 `AgentCategory`、`BusinessAgentSnapshotsJSON`、`clarification_business_agents`、`agent_authoring_sessions`；前端统一使用 `selectedBusinessAgents` 和 `selectedBusinessAgentIds`。


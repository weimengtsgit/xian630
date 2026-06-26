# 降级态设计：真实数据取不到时页面仍可产出（不显示裸「数据异常」）

- 日期：2026-06-25
- 分支：`feat/no-data-graceful`（worktree，基于 `feat-0624` @ `5a49540`）
- 状态：已批准，实施中

## 背景 / 问题

当前项目对真实数据应用（`dataPolicy = live_api | mock_then_api`）做了**强限制**（诚实数据契约，
`factory-server/internal/executor/claude_runner.go` `skillsPromptBlock` 注入，并由
`factory-server/internal/runner/honest_data_audit.go` 在 code_generation 后强制审计）：

- 真实数据强制优先；取数失败时应用"显示明确的错误或空状态"。
- **严禁**任何 mock/synthetic/Math.random/Math.sin 回退，**永不**为"让构建通过"而编造数据。

后果（用户反馈）：当请求场景**确实没有可达的真实数据源**时，契约形成两难——"页面要有内容"且"绝不编造"。
模型要么 **wall（反复重试/生成实质被阻断）**，要么吐出一个每个单元格都只写 `数据不可用` / `数据异常` 的
裸错误页。用户要求：**没有数据时页面也要产出来，不能只显示「数据异常」**。

## 决策（已与用户确认）

1. **无数据时的页面行为**：渲染一个**有意义的「降级态」**，**不要假数据**。"绝不交付假数据"的禁令**保留不变**。
2. **生效范围**：直接改现有 `live_api` / `mock_then_api`，**不新增** policy/开关。
3. 不改 server / clarification / data-policy 派生逻辑；不动 `sf-deploy/` 部署快照（服务器读取 `.claude/skills/`）。

## 降级态（Degraded State）规格

当所有真实数据源均失败时，生成应用**必须**渲染降级态（而不是裸错误串）。降级态包含：

1. **顶部说明 banner**：数据源不可用 + 失败原因（网络/覆盖范围/鉴权等）+ 已尝试的数据源列表 + 「手动重试」按钮。
2. **数据视图结构预览**：图表轴标签 / 表格列头 / 卡片标题等"数据回来后会展示什么"的骨架——
   **不得填充任何编造数值**（空数组、占位线、`—` 均可；严禁假数字）。
3. **官方数据源链接**：跳转到该数据源的公开页面，供用户自行核实。
4. **恢复说明**：「数据恢复后此处将显示…」的一句话说明。

并明确：

- 产出降级态是"所有真实源均失败"时**完整、合规、可交付**的终态——**不要重试去编造、不要留纯错误串、不要卡死**。
- 取数必须在**运行时（浏览器端）**进行；`npm run build` 必须能**完全离线**通过，禁止构建期取数依赖，
  保证页面永远能产出来（构建产物不依赖任何实时源）。
- 降级态组件命名用 `EmptyState` / `DegradedState` / `DataUnavailable` 等；
  **避开**被禁的 `mock` / `fake` / `dummy` / `placeholder` / `sampleData` / `demoData` 命名
  （prompt 明禁，`mockIdentRe` 部分覆盖）。

## 改动清单

### 1. `factory-server/internal/executor/claude_runner.go`
`skillsPromptBlock`（约 529 行）：把"应用必须显示明确的错误或空状态…"一句替换为**降级态契约**
（含上述 4 点 + 终态合规声明 + 离线构建规则）。**保留** 527/528/530/531（禁假数据、禁 mock 文件名、
mock_only、mock_then_api 语义）与契约标题行，使现有 prompt 断言（`[诚实数据契约 — 违反即判定生成失败]`、
`Math.random`、`fallback 到 mock`、`warnings`）保持绿。

### 2. `.claude/skills/software-factory-app/SKILL.md`
Honest Data 段 + Output Checklist 同步同一套降级态规格（agent 实际 Read 的单一事实源）；
明确"Runtime page has meaningful non-empty content"由降级态满足。

### 3. 四个 data-skill（`.claude/skills/{tide,deck-wind,ais-density,carrier-affiliation}-data-skill/SKILL.md`）
`Fallback tiers` 第 4 档 `SOURCE_ALL_FAILED` + `Failure Rules` 的"全部失败"终态：从"渲染裸失败标记"
改为"按 software-factory-app 的降级态渲染"。**保留**"绝不编造"。

### 4. `factory-server/internal/runner/honest_data_audit.go`（+ 测试）
**审计规则不变**（禁假数据保留）。新增测试 `TestAuditHonestDataDegradedStatePasses`：证明一个干净的
降级态应用（骨架 UI、空数组、轴标签、无数值、无 mock 标识）在 `live_api` 下**通过**审计。
`claude_runner_test.go` 现有断言保持绿（必要时补一条降级态关键词断言）。

## 非目标 / 不做

- 不放宽"禁假数据"：降级态不含任何编造数值；`mock_then_api` 仍不回退 mock。
- 不改数据策略派生、澄清流程、新增 policy 枚举。
- 不改部署快照（`sf-deploy/skills/`）。

## 验证

- `go test ./internal/runner/... ./internal/executor/...`（factory-server 内）全绿。
- prompt 渲染包含降级态关键词；审计对新降级态代码放行、对假数据仍拦截。

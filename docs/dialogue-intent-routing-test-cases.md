# 对话意图路由 · 测试用例集

> 本文档是**人工 UI 测试**用例集，验证对话意图路由的三类意图：**复用已有应用 / 蓝本引导生成 / 无蓝本新建**。
>
> 路由特性当前位于 `feat-0622-weimeng` 分支（尚未合入 `main`）。本测试计划作为 durable 文档先行落在 `main`；待特性合入后即可在 `main` 上执行。**执行测试前请 `git checkout feat-0622-weimeng`**，并以其候选清单为准。
> 路由使用**真实 Claude CLI**，分类是概率性的——用例中"不确定点"列即允许与期望不符、需重点记录的边界。

## 1. 前置条件

- 分支：`git checkout feat-0622-weimeng`，启动 factory-server + sf-portal。
- 路由走真实 Claude CLI（非 fake）。
- 不含休眠的"业务处理智能体/助手应用"路由（CONTEXT.md 中该路由休眠，智能体请求会改走助手应用生成，本集不单独覆盖）。

## 2. 候选清单（`-weimeng` 真实目录）

| 类型 | 数量 | 成员（slug · 显示名） |
|---|---|---|
| 预置应用（应用列表可见、可复用） | 3 | `carrier-formation-replay` 航母编队月度航迹复盘 · `aircraft-carrier-track` 航母轨迹分析 · `east-sea-situation` 东海目标态势演示 |
| 场景蓝本（隐藏、引导生成） | 5 | `carrier-homeport-tide-window` 航母母港潮汐窗口计算器 · `carrier-deck-wind-calculator` 甲板风实时计算器 · `merchant-density-grid-alert` 海域网格商船密度异常告警器 · `social-sighting-cluster-alert` 开源社区异常监测 · `carrier-air-wing-affiliation-inference` 航母舰载机归属推断工具 |

## 3. 验证手段

**UI 可观测信号**
- 复用：路由确认后出现**推荐卡片**（≤3 张）+ "打开/使用"；点击 → 启动该应用并 resolve 会话。
- 生成（蓝本/无蓝本）：路由确认后进入**需求澄清**子会话 → 用户确认 → 生成应用 `<规范化场景名>-<Base36>`。两者 UI 不可区分。

**服务端蓝本验证（API 已脱敏，必须查 SQLite）**
`routePayload.public()` 故意丢弃 `internalBlueprintSlug`，`GET /api/dialogues/:id` 看不到蓝本。查默认库 `~/.software-factory/state.db`：

```bash
# 路由确认后（复用：existingApplicationSlugs 含该应用；生成+蓝本：internalBlueprintSlug 非空；生成无蓝本：为空）
sqlite3 ~/.software-factory/state.db \
  "select draft_json from dialogues where id='<dlg_id>'"

# 确认生成后（job 需求里的蓝本引用；蓝本非空 / 无蓝本为 []）
sqlite3 ~/.software-factory/state.db \
  "select confirmed_requirement_json from jobs where id='<job_id>'"
```

判定：
- 复用 → `existingApplicationSlugs` 含目标应用 slug。
- 蓝本生成 → `internalBlueprintSlug` 非空（= 蓝本 slug）；确认后 `blueprintRefs` 非空。
- 无蓝本新建 → `internalBlueprintSlug` 空、`blueprintRefs` 为 `[]`。

> JSON 字段名（`internalBlueprintSlug` / `blueprintRefs` / `existingApplicationSlugs`）确定；SQL 列名（`draft_json` / `confirmed_requirement_json`）以 `-weimeng` 的 store schema 为准，必要时先 `sqlite3 ... ".schema"` 核对。

## 4. 用例

列说明：期望意图 / UI 信号 / 服务端判定 / 不确定点。

### 场景 1 — 复用已有应用

| ID | Prompt | 期望 | UI 信号 | 服务端 | 不确定点 |
|---|---|---|---|---|---|
| R1 | 调出东海方向的目标态势、目标轨迹、警戒区和事件时间线 | 复用→东海目标态势演示 | 推荐卡片含该应用 | existingApplicationSlugs 含 `east-sea-situation` | 几乎无 |
| R2 | 看航母编队最近一个月的日级航迹、伴随舰队形和关键事件复盘 | 复用→航母编队月度航迹复盘 | 推荐卡片含该应用 | existingApplicationSlugs 含 `carrier-formation-replay` | 可能与 R3 混淆 |
| R3 | 查看航母这一周从大连到台湾海峡的航行轨迹和每日事件 | 复用→航母轨迹分析 | 推荐卡片含该应用 | existingApplicationSlugs 含 `aircraft-carrier-track` | 可能与 R2 混淆 |

### 场景 2 — 蓝本生成（服务端验 `internalBlueprintSlug` + `blueprintRefs`）

| ID | Prompt | 期望蓝本 | UI 信号 | 不确定点 |
|---|---|---|---|---|
| B1 | 做一个航母母港潮汐窗口计算器，诺福克/圣迭戈/布雷默顿/横须贺 72 小时潮汐、12.8m 吃水可出港窗口 | carrier-homeport-tide-window | 澄清→生成 | 几乎无 |
| B2 | 做一个甲板风实时计算器，航母活动区域 10 米风速、20/30 节阈值、着舰弹射评估 | carrier-deck-wind-calculator | 澄清→生成 | 几乎无 |
| B3 | 做一个海域网格商船密度异常告警器，AIS、50 海里网格、30 天滑动平均、70%/50% 阈值 | merchant-density-grid-alert | 澄清→生成 | 几乎无 |
| B4 | 做一个开源社区异常监测，社媒推特/Instagram 海上目击、GPS/EXIF 坐标、聚类目击潮 | social-sighting-cluster-alert | 澄清→生成 | 几乎无 |
| B5 | 做一个航母舰载机归属推断工具，ADS-B 海上起降、200 海里关联、>60% 置信度、交叉部署、已离舰 | carrier-air-wing-affiliation-inference | 澄清→生成 | 几乎无 |

### 场景 3 — 无匹配新建（`internalBlueprintSlug` 空、`blueprintRefs=[]`）

| ID | Prompt | 期望 | UI 信号 | 不确定点 |
|---|---|---|---|---|
| N1 | 做一个图书馆借阅管理系统，登记图书、读者借还、逾期提醒 | 生成·无蓝本 | 澄清→生成 | 几乎无 |
| N2 | 做一个员工请假审批流程，含请假申请、审批流转、假期余额 | 生成·无蓝本 | 澄清→生成 | 几乎无 |
| N3 | 做一个仓库出入库盘点系统，扫码出入库、库存预警、盘点单 | 生成·无蓝本 | 澄清→生成 | 几乎无 |
| N4 | 做一个会议室预约系统，按时段预约、冲突检测、提醒通知 | 生成·无蓝本 | 澄清→生成 | 几乎无 |

### 边界 / 歧义探针

| ID | Prompt | 倾向期望 | 关键不确定点 |
|---|---|---|---|
| A1 | 航母最近的航行轨迹复盘 | 复用（编队复盘 或 轨迹分析二选一） | 两应用都含 航母/轨迹/复盘——测**应用间消歧**：主卡落哪个、有无备选卡 |
| A2 | 做一个东海目标态势演示 | 复用 vs 生成 | 用了应用全名但带"做一个"——测**复用vs生成**；若判生成，关注是否仍带该蓝本/复制意图 |
| A3 | 航母母港的潮汐和甲板风条件都要看 | 蓝本二选一（潮汐 或 甲板风） | 两蓝本同时命中——测**蓝本间消歧**：`internalBlueprintSlug` 落哪个，或 `blueprintRefs` 是否同时带两个 |
| A4 | 做一个航母基地的图书阅览预约系统 | 生成·无蓝本 | 含"航母"域噪声但意图是图书——测**关键词噪声鲁棒性**：是否被误配 maritime 蓝本 |
| A5 | 社媒上目击到航母编队经过 | 蓝本(开源社区) 或 复用(编队复盘) | "社媒目击"强指 social-sighting 蓝本，"航母编队"又指已有应用——测**应用域×蓝本域**优先级 |
| A6 | 我想搞个航母相关的东西看下态势 | 极模糊 | 信号不足——测**低置信**下路由行为（是否要用户澄清/默认生成） |

## 5. 建议执行顺序

1. **校准**：N1 → B1 → R1（先跑三条最确定的，确认三个场景的 UI 信号 + 服务端查询都能通）。
2. **铺满候选**：R2、R3；B2–B5；N2–N4。
3. **边界**：A1–A6（逐条记录实际分类与期望差异）。

## 6. 备注

- 共 18 条：匹配类 happy 8（复用 3 + 蓝本 5）+ 无匹配 4 + 边界 6。
- 边界探针允许与期望不符——差异本身就是发现。
- 后续可选：加一条**确定性回归路径**——用 fake 路由桩把这 18 条固化成 `go test`，断言 intent/blueprint，避免真模型概率性导致的不可重复（人工 UI 测真智能、自动测回归，互补）。

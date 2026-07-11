# Interface Agent 界面稿版本机制设计

## 背景

`interface-agent` 当前把 `messages` 和 `currentHtml` 保存在浏览器 `localStorage`，生成接口同步返回 HTML，分享接口同时创建预览、覆盖确认产物并推进流水线。页面刷新、换设备或多人协作时没有权威版本历史；切回旧稿也无法隔离后续模型上下文。

本设计在 `interface-agent` 内新增独立的界面设计会话和界面稿版本机制。它不依赖 `factory-server`；`agent-pipeline` 仍以 `projectname` 打开界面智能体，并额外保存、传递高强度编辑凭证。

## 目标

- 每次成功生成形成一个不可变界面稿版本。
- 用户可切换任意历史版本，并以该版本及其祖先上下文继续修改。
- 历史版本修改形成分支，不覆盖已有版本。
- 版本历史服务端持久化，可恢复、协作和审计。
- 分享、确认采用和下游交付具有独立语义与失败状态。
- 保持现有 `projectname/prototype.html` 下游输出兼容性。

## 非目标

- 不复用或修改 `factory-server` 的对话会话、生成任务和应用版本。
- 第一阶段不做源码 diff、截图像素 diff 或自动语义差异分析。
- 第一阶段不支持多实例写入，不引入 PostgreSQL。
- 不把系统版本号作为数据库主键或父子关系依据。

## 领域规则

1. 同一项目默认恢复其当前活跃的界面设计会话；“重新开始”归档旧会话并创建新会话。
2. 默认模板不是版本；第一次成功生成或显式导入旧稿后形成根版本 `V1`。
3. 正常从主线头继续生成 `V2`、`V3`；从历史版本分叉时生成 `V1.1`、`V1.2`，再从 `V1.1` 修改生成 `V1.1.1`。
4. 版本号只用于显示。每个版本用不可变 `id` 标识，用 `parent_version_id` 表达真实父子关系。
5. 一个成功版本包含生成指令、父版本、版本标题、HTML 产物路径和内容哈希。标题可编辑，编号和内容不可编辑。
6. 单版本不可硬删除；非确认分支可归档和恢复。删除整个界面设计会话时才清理其元数据和产物。
7. 当前选中版本是每位用户的界面状态；已确认版本是会话共享状态。
8. 模型上下文只包含所选版本的祖先链，不包含其后代或兄弟分支。
9. 分享链接固定指向一个不可变版本；分享不改变确认状态。
10. 确认采用只改变会话的已确认版本；下游文件写入和流水线通知由独立、可重试的交付处理。

## 编号规则

会话保存 `mainline_head_version_id` 和下一个主线序号。成功提交版本时在 SQLite 事务内分配显示编号：

- 根版本固定为 `V1`。
- 当基线仍是事务提交时的主线头，创建下一个顶层版本并移动主线头，例如 `V3 -> V4`。
- 当基线不是主线头，按该父版本的分支子序号创建标签，例如 `V1 -> V1.1`、第二个分支为 `V1.2`。
- 分支版本的子版本继续追加层级，例如 `V1.1 -> V1.1.1`。
- 两个请求并发基于同一主线头时，只允许先提交者推进主线；后提交者成为原基线的分支。

数据库对 `(session_id, version_label)`、`(parent_version_id, branch_sequence)` 和生成幂等键建立唯一约束。版本树排序使用结构化编号字段和创建时间，不依赖字符串字典序。

## 数据模型

### `interface_design_sessions`

- `id`：UUID。
- `project_key`：外部 `projectname`，用于项目映射，不用于授权。
- `status`：`active | archived | deleted`。
- `mainline_head_version_id`、`confirmed_version_id`。
- `row_version`：确认采用的乐观并发版本。
- `created_at`、`updated_at`、`archived_at`。

同一 `project_key` 同时最多一个活跃会话，历史归档会话保留。

### `interface_draft_versions`

- `id`、`session_id`、`parent_version_id`。
- `version_label`、`mainline_sequence`、`branch_sequence`、`label_path_json`。
- `title`、`generation_request_id`、`source_version_id`。
- `artifact_path`、`content_hash`、`byte_size`。
- `archived_at`、`created_at`、`created_by`。

`source_version_id` 只用于记录跨会话导入来源，不构成父子关系。

### `interface_generation_requests`

- `id`、`session_id`、`base_version_id`、`idempotency_key`。
- `instruction`、`status`：`queued | generating | saving | succeeded | failed`。
- `result_version_id`、`error_code`、`error_message`。
- `created_at`、`started_at`、`finished_at`、`created_by`。

### `interface_session_events`

按会话递增序号保存生成、失败、确认、分享、归档、恢复和交付结果。分支对话从版本祖先链投影，完整操作记录从事件序列投影；版本切换属于用户个人界面状态，不写入共享事件流。

### `interface_shares`

保存 `version_id`、分享令牌哈希、创建人、创建时间、过期时间和撤销时间。令牌只允许读取该版本预览。

### `interface_deliveries`

保存 `session_id`、`version_id`、状态、尝试次数、错误、幂等键和被哪个新交付取代。状态为 `pending | delivering | delivered | failed | superseded`。

## HTML 产物

版本 HTML 使用 Blade OS 不可变路径：

```text
<base>/<projectname>/interface-sessions/<session-id>/versions/<version-id>/prototype.html
```

写入后计算并校验 SHA-256。只有文件写入成功后，SQLite 事务才分配编号并创建可用版本；数据库提交失败产生的孤立文件由清理任务按路径和年龄回收。

确认采用后的交付仍写入兼容路径：

```text
<base>/<projectname>/prototype.html
```

## API

- `POST /api/interface-sessions/resolve`：按项目和编辑凭证恢复或创建活跃会话。
- `POST /api/interface-sessions/:id/restart`：归档当前会话并创建新会话。
- `GET /api/interface-sessions/:id`：读取会话、确认版本和交付摘要。
- `GET /api/interface-sessions/:id/versions`：读取版本树元数据。
- `GET /api/interface-sessions/:id/versions/:versionId`：读取版本详情和分支对话。
- `GET /api/interface-sessions/:id/versions/:versionId/preview`：授权预览版本文件。
- `PATCH /api/interface-sessions/:id/versions/:versionId`：修改标题或归档状态。
- `POST /api/interface-sessions/:id/generations`：提交异步生成，返回 `202` 和请求 ID。
- `GET /api/interface-sessions/:id/generations/:requestId`：恢复生成进度和结果。
- `POST /api/interface-sessions/:id/confirmations`：提交版本 ID 和预期确认版本 ID。
- `POST /api/interface-sessions/:id/shares`：为固定版本创建只读分享。
- `DELETE /api/shares/:shareId`：撤销分享。
- `POST /api/interface-sessions/:id/deliveries/:deliveryId/retry`：幂等重试交付。
- `GET /api/interface-sessions/:id/events`：读取完整操作记录。

确认请求发现 `expectedConfirmedVersionId` 已过期时返回 `409 Conflict`，不得静默覆盖他人的确认。

## 异步生成流程

```text
提交指令 + baseVersionId + idempotencyKey
  -> 创建或返回已有 generation request
  -> 读取 baseVersionId 的 HTML
  -> 沿 parentVersionId 组装祖先分支指令
  -> 调用 DeepSeek
  -> 校验并写入不可变 Blade OS 文件
  -> SQLite 事务内分配编号、创建版本、完成 generation request
  -> 发布 succeeded 事件并让前端自动选中新版本
```

模型失败、HTML 校验失败或文件写入失败时，只把 generation request 标记为失败，不占用编号，不创建版本。刷新或网络重试使用相同幂等键恢复原请求。

## 确认与交付流程

确认采用在事务内更新 `confirmed_version_id`、递增 `row_version`、写入确认事件并创建待交付记录。后台交付器读取版本文件，覆盖兼容输出路径，再以交付幂等键调用流水线完成 URL。

确认成功但交付失败时，界面显示“已确认，交付失败，可重试”。若用户确认新版本，旧的未完成交付标记为 `superseded`，不得继续推进流水线。

## 访问控制

- `projectname` 只定位项目，不能授权。
- 每个活跃会话使用高强度编辑令牌，数据库只保存哈希。
- `agent-pipeline` 保存并在启动时传递编辑凭证；凭证应通过一次性启动码换取 HttpOnly 会话 Cookie，避免长期令牌出现在日志和 Referer 中。
- 分享令牌独立、只读、可撤销、可过期。
- 所有写操作校验会话归属，禁止跨会话引用父版本、基线版本或确认版本。

## 前端行为

- 预览工具栏显示当前版本、版本标题和确认状态。
- 版本按钮打开树形弹层，节点显示编号、标题、时间、指令摘要和确认标记。
- 切换版本立即更新预览和输入框基线，不改变共享确认状态。
- 聊天区默认显示当前分支，提供“全部操作记录”视图。
- “分享”和“确认采用”使用独立按钮；“重新开始”替代覆盖式重置。
- 生成成功后自动选中新版本；失败记录只出现在操作记录中。
- 第一阶段仅支持分别打开两个版本，不提供自动差异分析。

## 旧数据迁移

首次进入没有版本的项目时检测旧 `interface-agent-state`。若其中包含非默认 HTML，展示一次性导入提示和预览；用户确认后创建来源为 `legacy_local` 的根版本 `V1`。成功导入后记录迁移完成，不能再次自动导入其他项目；默认模板和空内容不迁移。

## 部署

- SQLite 路径通过 `INTERFACE_AGENT_DB_PATH` 配置，建议容器内为 `/var/lib/interface-agent/interface-agent.db`。
- 宿主机为 `/var/lib/interface-agent` 配置持久卷，替换容器不得删除数据库。
- SQLite 开启 WAL、外键和 busy timeout；服务启动时执行向前兼容迁移。
- 部署前备份 SQLite，部署后验证会话恢复、版本预览、异步生成和交付重试。
- 第一阶段保持单实例；repository 和 artifact store 使用接口封装，为未来 PostgreSQL/对象存储迁移保留边界。

## 实施阶段

1. 新增 SQLite 初始化、迁移、repository、持久卷配置和 Blade OS 版本产物封装。
2. 新增编辑令牌、会话恢复/重启 API 和 `agent-pipeline` 启动凭证传递。
3. 将同步 `/api/generate` 迁移为可恢复的异步生成请求，加入幂等和原子编号。
4. 实现版本树、版本切换、分支对话、标题编辑、归档和旧稿迁移。
5. 拆分分享与确认，增加乐观并发确认和后台交付重试。
6. 完成数据备份、部署迁移、监控、孤立文件清理和回滚演练。

## 测试重点

- 根版本、主线、历史分支、深层分支及并发主线提交的编号正确。
- 父版本、基线版本、确认版本不能跨会话引用。
- 同一幂等键不重复调用模型或创建版本。
- 兄弟和后代指令不会进入当前分支的模型上下文。
- 模型、HTML 校验、Blade OS 或 SQLite 任一步失败都不会产生半成品版本。
- 刷新页面能恢复进行中的生成请求和当前用户选择。
- 确认冲突返回 `409`，确认成功与交付失败可独立展示和重试。
- 新确认会使旧的未完成交付过期，流水线不会重复推进。
- 分享始终返回固定版本，撤销和过期后不可访问。
- 重启会话保留旧版本，旧 `localStorage` 只迁移一次。
- 容器替换后 SQLite 和 Blade OS 版本文件仍可读取。

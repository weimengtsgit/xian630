# 右侧栏航向 511 回退设计

## 背景与根因

右侧栏第一栏的“航向/方向”应读取业务字段 `heading`；客户定义 `heading=511` 为错误哨兵，此时才读取同条数据的 `orientation`。

刷新后仍显示 `511°` 的根因不只在展示组件：服务端归一化曾把 `courseOverGround` 和 `trueHeading` 合并为一个值，再同时写入 `courseDeg`、`orientation` 和 `heading`。摘要与点选详情还只传递了 `courseDeg`，导致前端拿不到独立的 heading/orientation，即使执行回退也只能从 `511` 回退到同一个 `511`。

RawAISData 的原始字段契约没有直接名为 heading/orientation 的列。本应用的业务映射明确为：`trueHeading → heading`、`courseOverGround → orientation`；`courseDeg` 继续保留为 `courseOverGround` 的兼容别名。

客户确认：仅 `511` 代表该航向数据错误。本次不把 `360`、`452`、`456` 或其他大于 `359` 的值自动判定为错误。

## 修正规则

1. 右侧栏优先读取 `headingDeg` 或 `heading`，不再让 `courseDeg` 抢在 heading 前面。
2. 当 heading 数值严格等于 `511`（数字或可转成数字的字符串）时，改用同一条 `selectedTarget` 数据的 `orientation`。
3. `orientation` 缺失、为空或不是有限数值时显示现有空值 `--`。
4. heading 不是 `511` 时原样显示，包括 `360`、`452`、`456` 等其他大于 `359` 的数值。
5. 服务端只修复字段保真与传递，不改变 AIS 抓取窗口、告警、航向分布图或关联研判规则。

## 实现边界

`app-server.js` 的归一化函数独立保留 `heading` 与 `orientation`，构建首页摘要和点选详情时同时传递两者。`App.jsx` 用最新轨迹点更新选中舰艇时也同步这两个字段。

`VesselFocusPanel.jsx` 的纯函数只负责客户展示规则：读取 heading，且仅对 `511` 回退 orientation；现有 `formatHeading` 继续负责角度格式化。

目标文件目前包含用户其他未提交修改；实现必须做增量编辑，不能覆盖或提交无关改动。

## 验证

- 原始 `trueHeading=511, courseOverGround=148` 归一化为 `heading=511, orientation=148`，不再合并字段。
- `heading=511, orientation=148` 时显示 `148°`。
- `headingDeg="511", orientation=72` 时显示 `72°`。
- `heading=456, orientation=148` 时仍显示 `456°`，证明没有扩大客户规则。
- 航向为正常值时保持原有显示。
- 航向为 `511` 且 orientation 缺失或无效时显示 `--`。
- 点选详情刷新后仍保留独立的 heading/orientation。
- 运行服务端字段映射测试、`VesselFocusPanel` 定向测试、项目完整测试及生产构建，并重启本地 API 后在页面验证。

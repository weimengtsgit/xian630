# 右侧栏航向 511 端到端回退实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 保真传递独立的 heading/orientation，并让右侧栏仅在 heading 等于客户错误码 `511` 时显示同条数据的 orientation。

**Architecture:** RawAISData 适配层分别映射 `trueHeading → heading`、`courseOverGround → orientation/courseDeg`，不再做范围合并。轨迹指标层把最新点的 heading 与 orientation 一起传到首页摘要和点选详情；展示层优先读取 heading，仅对 `511` 执行 orientation 回退。

**Tech Stack:** Node.js、React 18、React DOM Server、Node.js `node:test`、Vite。

## Global Constraints

- 仅数值 `511` 或可转成数值 `511` 的字符串代表客户定义的数据错误。
- `360`、`452`、`456` 等其他值不得触发 orientation 回退。
- RawAISData 原始字段只请求已验证的 `trueHeading` 与 `courseOverGround`；不得请求不存在的 UI 字段名。
- 不修改 AIS 抓取窗口、航向分布图、告警或关联研判规则。
- 目标文件含有其他未提交修改时，只提交能明确归属于本修复的文件或索引补丁，不夹带无关改动。

---

### Task 1: 保真映射 AIS 航向字段

**Files:**
- Modify: `scene/seasats-usv-track-alert-agent/server/app-server.js:151-171`
- Modify: `scene/seasats-usv-track-alert-agent/server/app-server.test.js`

**Interfaces:**
- Consumes: RawAISData row fields `trueHeading` and `courseOverGround`.
- Produces: `normalizePoint(row, index)` with independent `heading`, `orientation`, and compatibility alias `courseDeg`.

- [ ] **Step 1: 写失败的字段保真测试**

导出 `normalizePoint`，测试 `trueHeading=511, courseOverGround=148` 得到 `heading=511, orientation=148, courseDeg=148`，并测试 `trueHeading=456` 不被范围规则改写。

- [ ] **Step 2: 运行测试确认正确失败**

Run: `node --test server/app-server.test.js`

Working directory: `scene/seasats-usv-track-alert-agent`

Expected: 字段保真用例失败，因为当前实现把三个业务字段合并成同一个值。

- [ ] **Step 3: 写最小实现**

删除 `pickHeading` 合并逻辑，令 `normalizePoint` 返回：

```js
courseDeg: numberOrNull(row.courseOverGround),
orientation: numberOrNull(row.courseOverGround),
heading: numberOrNull(row.trueHeading),
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test server/app-server.test.js`

Expected: 所有 app-server 测试通过。

---

### Task 2: 让摘要和点选详情保留最新 heading/orientation

**Files:**
- Modify: `scene/seasats-usv-track-alert-agent/src/logic/domain.js:158-210`
- Modify: `scene/seasats-usv-track-alert-agent/src/logic/domain.test.js`

**Interfaces:**
- Consumes: 轨迹最后一点的 `heading`、`orientation`。
- Produces: `computeTrackMetrics(points)` 返回独立的 `heading`、`orientation`，供 `analyzePayload` 合并到 target。

- [ ] **Step 1: 写失败的指标传递测试**

在 `computeTrackMetrics` 测试中加入最后一点 `{ heading: 511, orientation: 148 }`，断言返回值同时保留 `heading=511` 与 `orientation=148`。

- [ ] **Step 2: 运行测试确认正确失败**

Run: `node --test src/logic/domain.test.js`

Expected: `heading` 断言失败，因为当前指标只返回 orientation。

- [ ] **Step 3: 写最小实现**

`computeTrackMetrics` 的非空返回值增加：

```js
heading: toNumber(last.heading) ?? null,
orientation: toNumber(last.orientation) ?? null,
```

空轨迹返回值同步增加 `heading: null, orientation: null`，保持返回结构稳定。

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test src/logic/domain.test.js`

Expected: 所有 domain 测试通过。

---

### Task 3: 右侧栏按 heading=511 回退 orientation

**Files:**
- Modify: `scene/seasats-usv-track-alert-agent/src/app/VesselFocusPanel.jsx:64-68`
- Modify: `scene/seasats-usv-track-alert-agent/src/app/VesselFocusPanel.test.js:82-109`

**Interfaces:**
- Consumes: `selectedTarget.headingDeg | heading | courseDeg | orientation`。
- Produces: `resolveDisplayedHeading(selectedTarget): unknown | number | null`。

- [ ] **Step 1: 把现有回归测试改为真实数据形状并确认失败**

测试 `heading=511, courseDeg=148, orientation=148` 显示 `148°`；测试 `heading=456, courseDeg=148, orientation=148` 显示 `456°`；保留字符串 `headingDeg="511"` 与无效 orientation 用例。

- [ ] **Step 2: 运行测试确认正确失败**

Run: `node --test --test-name-pattern="customer error code 511|does not broaden|orientation is unusable" src/app/VesselFocusPanel.test.js`

Expected: 非 511 的 heading 优先级用例失败，因为当前函数先读取 courseDeg。

- [ ] **Step 3: 写最小实现**

```js
export function resolveDisplayedHeading(selectedTarget) {
  const heading = valueFrom(selectedTarget, ["headingDeg", "heading", "courseDeg", "orientation"]);
  if (Number(heading) !== 511) return heading;
  return numberOrNull(selectedTarget?.orientation);
}
```

- [ ] **Step 4: 运行定向测试确认通过**

Run: `node --test src/app/VesselFocusPanel.test.js`

Expected: 所有 VesselFocusPanel 测试通过。

---

### Task 4: 完整验证、重启服务并提交本地分支

**Files:**
- Verify: `scene/seasats-usv-track-alert-agent/server/app-server.js`
- Verify: `scene/seasats-usv-track-alert-agent/src/logic/domain.js`
- Verify: `scene/seasats-usv-track-alert-agent/src/app/VesselFocusPanel.jsx`

**Interfaces:**
- Consumes: 本地 API `http://127.0.0.1:5180` 与 Vite 页面 `http://127.0.0.1:5179`。
- Produces: 当前本地分支上的可验证修复提交。

- [ ] **Step 1: 运行完整测试和构建**

Run: `npm test`，随后 `npm run build`

Expected: 0 failed，Vite 构建成功。

- [ ] **Step 2: 检查差异边界**

Run: `git diff --check -- <本次目标文件>`，并核对没有夹带无关改动。

- [ ] **Step 3: 重启本地 API 服务并验证接口**

停止当前 `server/app-server.js` 进程后从应用目录执行 `npm start`；接口 target/track point 必须保留独立 heading/orientation。

- [ ] **Step 4: 在本地页面验证**

刷新页面，点选有 `heading=511, orientation!=511` 的记录时显示 orientation；若原始同条记录两列都是 `511`，页面按客户规则仍会显示 orientation 的实际值 `511°`，不得伪造替代角度。

- [ ] **Step 5: 提交本次修复**

只暂存本次修复文件或精确索引补丁，提交信息：

```text
fix: preserve AIS heading orientation fallback
```

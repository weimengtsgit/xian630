# 右侧栏航向 511 回退实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 当右侧栏“航向/方向”当前选中的航向值严格等于客户错误码 `511` 时，显示同条数据的 `orientation`。

**Architecture:** 在 `VesselFocusPanel.jsx` 内增加一个小型纯函数，复用现有字段选择顺序，仅对 `511` 分支执行 orientation 回退；组件继续使用现有 `formatHeading` 输出。通过服务端静态渲染测试验证用户可见结果，而不是测试内部实现。

**Tech Stack:** React 18、React DOM Server、Node.js `node:test`。

## Global Constraints

- 仅数值 `511` 或可转成数值 `511` 的字符串代表客户定义的数据错误。
- `360`、`452`、`456` 等其他值不得触发 orientation 回退。
- 保留现有航向字段选择顺序和其他显示行为。
- 不修改航向分布图、AIS 抓取、服务端归一化、告警或关联研判。
- `VesselFocusPanel.jsx` 已包含用户未提交修改；只做增量编辑，不暂存或提交该文件中的无关改动。

---

### Task 1: 精确处理 heading=511

**Files:**
- Modify: `scene/seasats-usv-track-alert-agent/src/app/VesselFocusPanel.jsx:56-89,882`
- Modify: `scene/seasats-usv-track-alert-agent/src/app/VesselFocusPanel.test.js:60-100`

**Interfaces:**
- Consumes: `selectedTarget` 和现有 `valueFrom`、`numberOrNull`、`formatHeading`。
- Produces: `resolveDisplayedHeading(selectedTarget): unknown | number | null`，供右侧栏“航向/方向”指标使用。

- [ ] **Step 1: 写失败的用户可见行为测试**

在 `VesselFocusPanel.test.js` 增加：

```js
test("falls back to orientation when the selected heading is customer error code 511", () => {
  const numericMarkup = render({
    selectedTarget: { ...selectedTarget, courseDeg: 511, orientation: 148 },
  });
  assert.match(numericMarkup, /航向\/方向[\s\S]*148°/);
  assert.doesNotMatch(numericMarkup, /航向\/方向[\s\S]*511°/);

  const stringMarkup = render({
    selectedTarget: { ...selectedTarget, headingDeg: "511", orientation: 72 },
  });
  assert.match(stringMarkup, /航向\/方向[\s\S]*72°/);
});

test("does not broaden the customer fallback rule beyond 511", () => {
  const markup = render({
    selectedTarget: { ...selectedTarget, courseDeg: 456, orientation: 148 },
  });
  assert.match(markup, /航向\/方向[\s\S]*456°/);
});

test("shows the existing empty value when heading is 511 and orientation is unusable", () => {
  const markup = render({
    selectedTarget: { ...selectedTarget, courseDeg: 511, orientation: "invalid" },
  });
  assert.match(markup, /航向\/方向[\s\S]*--/);
});
```

- [ ] **Step 2: 运行定向测试并确认正确失败**

Run: `node --test --test-name-pattern="customer error code 511|does not broaden|orientation is unusable" src/app/VesselFocusPanel.test.js`

Working directory: `scene/seasats-usv-track-alert-agent`

Expected: `courseDeg=511` 用例失败，实际标记包含 `511°`；非 511 用例保持通过。

- [ ] **Step 3: 写最小实现**

在 `valueFrom` 后增加：

```js
export function resolveDisplayedHeading(selectedTarget) {
  const heading = valueFrom(selectedTarget, ["headingDeg", "courseDeg", "orientation", "heading"]);
  if (Number(heading) !== 511) return heading;
  return numberOrNull(selectedTarget?.orientation);
}
```

将组件中的：

```js
const heading = valueFrom(selectedTarget, ["headingDeg", "courseDeg", "orientation", "heading"]);
```

替换为：

```js
const heading = resolveDisplayedHeading(selectedTarget);
```

- [ ] **Step 4: 运行定向测试并确认通过**

Run: `node --test src/app/VesselFocusPanel.test.js`

Working directory: `scene/seasats-usv-track-alert-agent`

Expected: 所有 `VesselFocusPanel` 测试通过，新增用例分别显示 `148°`、`72°`、`456°` 和 `--`。

- [ ] **Step 5: 运行完整项目测试**

Run: `npm test`

Working directory: `scene/seasats-usv-track-alert-agent`

Expected: 0 failed。

- [ ] **Step 6: 运行生产构建**

Run: `npm run build`

Working directory: `scene/seasats-usv-track-alert-agent`

Expected: Vite 构建成功，无编译错误。

- [ ] **Step 7: 检查差异边界**

Run: `git diff --check -- scene/seasats-usv-track-alert-agent/src/app/VesselFocusPanel.jsx scene/seasats-usv-track-alert-agent/src/app/VesselFocusPanel.test.js`

Expected: 无空白错误；diff 保留实施前已有的 `VesselFocusPanel.jsx` 用户修改，本次只新增 511 回退函数和对应调用/测试。因为目标文件包含无关用户改动，不暂存或提交这两个文件。


# Agent Market Static Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone dark technology agent marketplace page with four clickable agent cards.

**Architecture:** Create one root-level static HTML file with embedded CSS and a small inline JavaScript data array. The page has no runtime dependency on the React portal, backend APIs, or build tools, so it can be opened directly from disk.

**Tech Stack:** HTML, CSS, vanilla JavaScript, inline SVG/CSS visual treatment.

---

## File Structure

- Create: `agent-market.html`
  - Owns all markup, styles, data, rendering, and click targets for the static marketplace.
- No modifications to `sf-portal-mvp` or backend files.

## Tasks

### Task 1: Create the Static Agent Market Page

**Files:**
- Create: `agent-market.html`

- [x] **Step 1: Create the file with semantic shell, embedded styles, and agent data**

Add a complete static HTML document at `agent-market.html`. It must include:

- `main.market-shell`
- Header with title `Agent 市场`
- Four cards rendered from an inline `agents` array
- Temporary hash links:
  - `#agent-ais-monitor`
  - `#agent-airwing-attribution`
  - `#agent-washington-csg-patterns`
  - `#agent-generic`

- [x] **Step 2: Implement the visual system**

In the same file, define CSS variables and styles using:

```css
:root {
  --bg: #1B2732;
  --surface: #243340;
  --surface-2: #2E3F4D;
  --text: #E5EAFF;
  --muted: #C9D2D9;
  --soft: #CCDAFF;
  --border: rgba(187, 203, 217, 0.35);
}
```

Use layered dark panels, an understated grid background, hover glow, visible focus state, and card radius no larger than 8px.

- [x] **Step 3: Implement responsive behavior**

Use CSS grid:

```css
.agent-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
}
```

Ensure important text wraps naturally and the page has no horizontal overflow.

- [x] **Step 4: Verify direct browser behavior**

Open the file directly:

```bash
open agent-market.html
```

Expected: the page opens without a dev server, all four cards are visible, and clicking a card updates the browser URL hash.

Actual verification note: the in-app browser blocks `file://` navigation by policy, so browser verification used a local static server at `http://127.0.0.1:4173/agent-market.html`. The page remains a standalone HTML file.

- [x] **Step 5: Run static checks**

Run:

```bash
python3 - <<'PY'
from pathlib import Path
p = Path("agent-market.html")
s = p.read_text()
for text in ["Agent 市场", "美航母AIS异常监测", "航母舰载机归属推断工具", "华盛顿号航母打击群活动规律平台", "xx智能体"]:
    assert text in s, text
for href in ["#agent-ais-monitor", "#agent-airwing-attribution", "#agent-washington-csg-patterns", "#agent-generic"]:
    assert href in s, href
assert "overflow-x: hidden" in s
print("agent market static checks passed")
PY
```

Expected output:

```text
agent market static checks passed
```

- [x] **Step 6: Commit**

Commit only the static page and implementation plan:

```bash
git add agent-market.html docs/superpowers/plans/2026-06-27-agent-market-static-page.md
git commit -m "feat: add static agent market page"
```

Expected: one commit containing the new static HTML page and this plan.

## Self-Review

- Spec coverage: the plan creates a standalone static page, includes all four requested agent names, uses temporary hash links, follows the dark technology style, and defines responsive verification.
- Placeholder scan: the temporary hash links are intentional scope from the approved design, not missing data.
- Type consistency: agent objects use stable fields that the single renderer consumes: `name`, `slug`, `category`, `description`, `capabilities`, `status`, and `href`.

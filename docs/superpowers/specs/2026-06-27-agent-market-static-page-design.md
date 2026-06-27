# Agent Market Static Page Design

## Goal

Build an independent static HTML page for an agent marketplace. The page presents agents as clickable cards and follows the provided dark technology visual style. It does not depend on the existing React/Vite portal, backend APIs, or runtime build tooling.

## Scope

In scope:

- One standalone static page that can be opened directly in a browser.
- Four initial agent cards:
  - 美航母AIS异常监测
  - 航母舰载机归属推断工具
  - 华盛顿号航母打击群活动规律平台
  - xx智能体
- Card-level navigation to intentional temporary hash links that can later be replaced with real URLs.
- A polished dark technology layout with responsive behavior for desktop and smaller screens.

Out of scope:

- Backend data loading.
- Authentication, permissions, purchase flow, install flow, or agent management.
- Map, chart, or live telemetry widgets.
- Integration into `sf-portal-mvp` routing.

## Recommended Approach

Create a single static HTML artifact with embedded CSS and a small inline data array. This is the simplest fit for the requested static page and keeps the agent list easy to edit later. It also avoids coupling the prototype to the existing application state or API contracts.

## Page Structure

The page uses an immersive full-screen dark layout:

- Header: product title, short subtitle, and small status counters.
- Filter row: visual category chips for marketplace browsing; initially all cards remain visible.
- Agent grid: four responsive cards with agent name, category, short description, capability tags, status, and an entry affordance.
- Footer/status strip: lightweight metadata such as "Static Preview" and link replacement note.

Cards are the primary interaction target. Clicking anywhere on a card opens that agent's configured link. The visible action button uses the same target.

## Visual Design

Use the provided design language:

- Background and primary surfaces: `#1B2732`, `#243340`, and translucent variants.
- Main text: `#E5EAFF`.
- Secondary text: `#C9D2D9`.
- Accent text and subtle glow: `#CCDAFF` plus restrained cyan highlights.
- Borders: `rgba(187, 203, 217, 0.35)`.
- Card hierarchy: base panel `#1B2732`, raised card `rgba(36, 51, 64, 0.6)`, inner elements `#2E3F4D`.
- Border radius stays at 8px or less.

The "cool" treatment should come from layered depth rather than heavy decoration: faint grid lines, scanning highlights, glowing card borders on hover, and crisp iconography. Avoid maps, charts, stock photos, decorative blobs, oversized marketing cards, or one-note gradients.

## Agent Data

The static page keeps agent data in a JavaScript array:

- `name`: display name.
- `slug`: stable anchor id and default temporary path.
- `category`: short domain label.
- `description`: one or two lines explaining the agent.
- `capabilities`: three compact tags.
- `status`: visible state such as "可用" or "预览".
- `href`: temporary hash link.

Initial temporary links:

- `#agent-ais-monitor`
- `#agent-airwing-attribution`
- `#agent-washington-csg-patterns`
- `#agent-generic`

## Interaction

- Card hover increases border contrast, glow, and slight vertical lift.
- Keyboard focus is visible.
- Cards are implemented as links so browser navigation, opening in a new tab, and accessibility behavior remain native.
- With the temporary hash links, the URL hash changes without requiring a backend.

## Responsiveness

- Desktop: four cards in a balanced grid when space allows.
- Medium width: two-column grid.
- Mobile/narrow width: single-column grid, with text wrapping instead of truncation for important labels.
- No horizontal scrolling.

## Testing

Manual verification:

- Open the HTML file directly in a browser.
- Confirm all four agent names are visible and not truncated.
- Confirm each card changes hover/focus state.
- Confirm clicking each card changes the URL to its configured temporary hash link.
- Confirm layout remains readable at desktop and mobile viewport widths.

If a local browser automation check is available, use it to take desktop and mobile screenshots and inspect for blank rendering, overflow, or overlapping text.

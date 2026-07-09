import nodeFetch from 'node-fetch';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { stripHtmlFences } from './html.js';

// C2 UI System style spec — loaded from skills/c2-ui-system/style.md (the
// project's interface-generation style skill). Falls back to an inline summary
// if the skill file is missing so generation still produces C2-styled output.
const STYLE_SPEC = (() => {
  try {
    const here = fileURLToPath(import.meta.url);
    const file = path.resolve(path.dirname(here), '../../skills/c2-ui-system/style.md');
    return readFileSync(file, 'utf8').trim();
  } catch {
    return 'C2 UI System (military C2 situational awareness, dark): bg #0a0e14/#111823/#18212e/#0c1119, accent cyan #38b6e6 (glow only for selected/map), text #e8eef5/#9fb2c6/#647689, status critical #e5484d/approve #3fbd6b/warning #e0a339/info #4a90d9, score low/med/high. Fonts Segoe UI / Cascadia Code (mono + tabular-nums for data). 4px spacing base, radii 3/5/8. Uppercase micro-labels with letter-spacing. CSS-only interactions, inline SVG icons.';
  }
})();

const SYSTEM_PROMPT = `You are a senior product UI prototyping assistant.
Return only renderable HTML. Do not wrap the answer in Markdown. Do not explain.
Generate frontend prototype code only: HTML, CSS, and small inline JavaScript for local UI interactions.
Do not generate backend code, package files, deployment scripts, external script tags, or API calls from the prototype.
Prefer polished, production-like interface mockups with realistic content and responsive layout.

Apply the C2 UI System visual style (loaded from skills/c2-ui-system) unless the user explicitly asks otherwise. Define the C2 design tokens as :root CSS variables and use them throughout; reuse the c2-* component classes/patterns from the spec.

${STYLE_SPEC}

- Layout: clear grid/flex alignment, consistent spacing, readable contrast, no random stacking, no horizontal overflow. Important values, names, status, time, thresholds, and data sources must stay fully visible; do not truncate critical content.
- For tree/grouped data use inherent hierarchy (tree controls, grouped lists, collapsible <details>, indentation, drill-down, grouped table headers); do not flatten.
- For charts (trends/KPI) or maps (geographic/track), theme them with C2 tokens (dark bg, cyan #38b6e6 accents, mono tabular data); a chart lib like ECharts or a map like Leaflet is acceptable if themed to C2. Current time = real Beijing time UTC+8; if the range includes now, show a bright cyan markLine with a "现在 / 当前时间" label.
When current HTML is provided, revise it according to the latest user feedback instead of starting from scratch.`;

export function buildMessages({ message, history = [], currentHtml = '' }) {
  const safeHistory = history.map((item) => ({
    role: item.role === 'assistant' ? 'assistant' : 'user',
    content: item.content,
  }));

  const latestContent = currentHtml
    ? `Latest user request:\n${message}\n\nCurrent prototype HTML to revise:\n${currentHtml}`
    : `Latest user request:\n${message}`;

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    ...safeHistory,
    { role: 'user', content: latestContent },
  ];
}

export function resolveFetch(fetchImpl = globalThis.fetch) {
  return fetchImpl || nodeFetch;
}

export function createTimeoutSignal(timeoutMs) {
  if (typeof AbortSignal?.timeout === 'function') {
    return AbortSignal.timeout(timeoutMs);
  }

  const controller = new AbortController();
  setTimeout(() => controller.abort(), timeoutMs).unref?.();
  return controller.signal;
}

export function createDeepSeekClient(config, fetchImpl = globalThis.fetch) {
  return {
    async generateHtml({ message, history, currentHtml }) {
      const fetch = resolveFetch(fetchImpl);
      const response = await fetch(`${config.deepseekBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.deepseekApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: config.deepseekModel,
          messages: buildMessages({ message, history, currentHtml }),
          temperature: 0.4,
        }),
        signal: createTimeoutSignal(90000),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`DeepSeek request failed with ${response.status}: ${text.slice(0, 300)}`);
      }

      const payload = await response.json();
      const content = payload?.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error('DeepSeek returned an empty response.');
      }

      return stripHtmlFences(content);
    },
  };
}

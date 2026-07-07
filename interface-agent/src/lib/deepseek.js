import nodeFetch from 'node-fetch';
import { stripHtmlFences } from './html.js';

const SYSTEM_PROMPT = `You are a senior product UI prototyping assistant.
Return only renderable HTML. Do not wrap the answer in Markdown. Do not explain.
Generate frontend prototype code only: HTML, CSS, and small inline JavaScript for local UI interactions.
Do not generate backend code, package files, deployment scripts, external script tags, or API calls from the prototype.
Prefer polished, production-like interface mockups with realistic content and responsive layout.
Apply this default visual style unless the user explicitly asks otherwise:
- Dark technology dashboard style, refined and not cluttered.
- Main background #243340, primary card background #1B2732, nested card/background layers #243340 at 60% opacity and #2E3F4D for hierarchy.
- Primary text #E5EAFF, secondary text #C9D2D9, helper text #CCDAFF, borders rgba(187,203,217,0.35).
- Prefer YouSheBiaoTiHei for primary titles and OPPO Sans 4.0 for table names, cards, body text, and helper text; title size around 26px, content around 14px, helper text around 12px.
- Buttons and tags should use dark backgrounds, light blue text, restrained borders, consistent hover/active/loading/disabled states.
- Layout should use clear grid/flex alignment, consistent spacing, readable contrast, no random stacking, no horizontal overflow.
- Important values, names, status, time, thresholds, and data sources must remain fully visible; avoid truncating critical content.
- Use inherent hierarchy for tree/grouped data with tree controls, grouped lists, collapsible groups, indentation, drill-down, or grouped table headers; do not flatten hierarchical data.
- If the requested interface involves satellite imagery, track playback, geographic points, or situation display, use a Leaflet-style map area with satellite imagery, dark overlay, fixed-height #1B2732 container, dark custom markers, and cluster behavior for dense points.
- If the requested interface involves monitoring trends, statistical distribution, or KPI dashboards, use ECharts-style dark charts with transparent background, #243340-series colors, #C9D2D9/#CCDAFF axes, dataZoom slider + inside zoom for dense data, and stable markLine annotations.
- For current-time charts, current time means real system time in Beijing time UTC+8. If the chart range includes now, show a fixed bright vertical markLine with a "现在 / 当前时间" label; do not hardcode stale or simulated current time.
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

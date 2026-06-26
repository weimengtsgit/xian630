---
name: maritime-alert-dashboard
description: Use when generating maritime monitoring dashboards for ports, sea areas, carrier activity zones, vessel-density grids, weather/tide thresholds, social sightings, refresh cadence, alerts, map overlays, countdown windows, or aggregation highlights.
---

# Maritime Alert Dashboard

Use this skill with `software-factory-app`, `defense-operations-ui`, and `command-dashboard` when the confirmed requirement is a maritime command dashboard.

## Must Do

- Preserve the customer's scenario name, thresholds, status labels, and judgement framing in the generated application content.
- Keep the application static and self-contained with an explicit mock data provider shaped like the future external feed.
- Model maritime objects explicitly: ports, sea areas, carrier activity regions, 50-nautical-mile grids, vessels, wind fields, tide windows, geotagged posts, and sighting clusters when relevant.
- Show the customer-provided refresh cadence in the UI, while allowing a short local demo tick to update countdowns, last-refresh timestamps, charts, or mock state.
- Expose the data-source state: source name, last update time, configured refresh cadence, and whether the current data is mock/demo data.
- Make thresholds visible beside computed status: tide draft threshold, deck wind minimum, carrier maximum speed, 30-day density baseline, yellow/red ratios, post clustering time window, or similar requirement-specific rules.
- Use map, grid, dashboard-card, trend, alert-list, and detail-panel layouts according to the scenario; prioritize scanability over decorative presentation.
- Use consistent operational color semantics: green for normal/open/available, yellow for warning, red for critical/closed/unavailable, with text labels so color is not the only signal.
- Include at least one selected-item detail view that explains the current status calculation with the source values used.
- Shape mock data for later replacement by real adapters, but do not require a backend, credentials, cloud services, or live external API access in the preset/generated application.

## Scenario Patterns

| Pattern | Required view and calculations |
|---|---|
| Carrier homeport tide window | Four-port dashboard for Norfolk, San Diego, Bremerton, and Yokosuka; current tide height; 12.8 m draft threshold; next departure window; open/closed countdown; 72-hour tide curve. |
| Carrier deck wind calculator | Carrier activity regions; 10 m wind speed/direction; 20 kt deck-wind minimum; carrier max speed 30 kt; achievable deck-wind range; "无弹射器辅助" and "安全着舰" conditions per carrier. |
| Merchant-density grid alert | 50-nautical-mile grid cells; current merchant count; 30-day sliding-average baseline; green/yellow/red status; yellow below 70%; red below 50%; small count curve per grid. |
| Social sighting cluster alert | Global sea-area scatter map; Twitter/Instagram post stream; multilingual keywords; GPS and image EXIF coordinate sources; cluster highlight when multiple accounts post similar content in the same sea area during a short time window. |
| Carrier air-wing affiliation inference | ADS-B historical tracks; sea takeoff/landing extraction; carrier-position binding within the configured distance threshold; affiliation confidence; suspected cross-deployment; departed-aircraft alert; aircraft table + carrier relationship tree + takeoff/landing heat map. |

## Must Not Do

- Do not rename a customer-supplied application or scenario label just to make the taxonomy cleaner.
- Do not soften or reinterpret customer-provided operational labels such as "可出港时间窗", "无弹射器辅助", "安全着舰", "净空", or "目击潮".
- Do not call live public APIs, scrape social platforms, embed API keys, or require server-side collectors.
- Do not hide mock/demo status; make the data boundary clear without changing the customer judgement framing.
- Do not create a marketing landing page, hero page, or decorative-only data screen.
- Do not show alert cards without the values that triggered them.
- Do not use `demo01` / `demo02` generated names; generated application names
  use the model's normalized scenario name plus a Factory-owned random serial.

## Output Checklist

- `.factory/app.json` uses `type: "command-dashboard"` and includes maritime/dashboard tags.
- README states that data is mock/demo data shaped for future tide, weather, AIS, or social-source adapters.
- The first viewport shows the operational dashboard itself, not an introduction page.
- All customer thresholds and refresh cadences are visible in the UI.
- Green/yellow/red or open/closed states are represented in both color and text.
- At least one chart, timeline, grid sparkline, map overlay, or scatter layer changes under the local demo tick.

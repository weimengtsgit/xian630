---
name: software-factory-app
description: Generate a deployable React/Vite static application for the software factory.
---

# Software Factory App

## Must Do

- Generate files only under `generated-apps/<slug>/`.
- Generate `.factory/app.json`, `package.json`, `Dockerfile`, `nginx.conf`, `src/`, and `README.md`.
- Use React and Vite.
- Keep the app static and self-contained, but obey the **Honest Data** rule below
  for what populates the data layer — do not default to mock data.
- Ensure `npm run build` creates `dist/index.html`.
- **Build script MUST be `"build": "vite build"`** — NEVER `"tsc && vite build"`.
  Vite uses esbuild to transpile TypeScript without type-checking, so unused
  imports/locals never fail the build. `tsc` in the build chain rejects generated
  code on `noUnusedLocals`/`TS6133` and breaks `image_build`. If the project
  uses TypeScript, also set `"noUnusedLocals": false` and
  `"noUnusedParameters": false` in `tsconfig.json` as a safety net.
- Use `source: "generated"` in `.factory/app.json`.
- Use this exact manifest shape, replacing `<slug>`, `<name>`, `<type>`, and descriptive values only:

  ```json
  {
    "schemaVersion": 1,
    "slug": "<slug>",
    "name": "<name>",
    "type": "<type>",
    "source": "generated",
    "description": "<description>",
    "entry": "static-vite",
    "path": "generated-apps/<slug>",
    "tags": ["<domain>"],
    "build": {"command": "npm run build", "outputDir": "dist"},
    "runtime": {"devCommand": "npm run dev", "defaultPort": 5173},
    "docker": {"enabled": true, "dockerfile": "Dockerfile", "context": ".", "runtimePort": 80}
  }
  ```

- Do not use `deployment` or `ports` as substitutes for `build`, `runtime`, or `docker`.
- When `input.json` carries `blueprintRefs`, read the referenced `scene/<slug>/scene.md` (if present) or `scene/<slug>/README.md` as a STYLE / STRUCTURE / INTERACTION / DATA-MODEL REFERENCE ONLY to inform page layout, controls, and the *shape* of the data model. Generate original code; never copy `scene/` source files into `generated-apps/`, and never copy a scene's mock *values* into the generated app — blueprints describe layout/interaction/data-model form, not real or mock data to ship.

## Must Not Do

- Do not modify `scene/`, `factory-server/`, `cc-status/`, or `.git/`.
- Do not require a backend service.
- Do not fetch classified, restricted, or non-public data. Public data via the
  declared data skills (NOAA tide, Open-Meteo wind, historical AIS archives, the
  committed carrier-affiliation sources) is allowed and, when `dataPolicy`
  requires real data, is mandatory — see Honest Data.
- Do not require login, external credentials, or cloud services.

## Honest Data (真实数据优先 / 诚实模式)

The data layer is driven by `confirmedRequirement.dataPolicy`, not by a "keep it
working" default:

- `live_api` or `mock_then_api` — **real data first.** When a data skill is in the
  generation profile, fetch real public data through that skill's adapter and
  populate the data layer from the real response. On a real fetch failure (source
  unreachable, coverage not available, auth missing), render the **Degraded State**
  (see below) and record the reason in `output.json` `warnings`. `mock_then_api`
  does NOT mean "fall back to mock" — it means real-first, fail honestly.
- `mock_data` or `useMock=true` — mock is allowed, but the UI must clearly label
  its data as `mock` / `演示数据` so it is never mistaken for real data.

Forbidden under `live_api`/`mock_then_api` (shipping any of these is a generation
failure, even if it "makes the build pass"):

- synthetic / mock / fake / demo data standing in for the real source;
- `Math.random`, deterministic formulas, or `Math.sin`/`Math.cos` curves used to
  synthesize tide / wind / density / track series;
- falling back to mock after a real fetch fails;
- hard-coding realistic-looking values to guarantee a successful build.

### Degraded State（所有真实源失败时的终态）

When every real source fails, the page MUST still ship and render a meaningful
**Degraded State** — NOT a bare `数据异常` / `数据不可用` error string, and never fake
data. Producing the Degraded State is a complete, compliant, shippable outcome; do
not retry to fabricate and do not stall. It must include:

1. A top banner: data source unavailable + failure reason + the sources already
   tried + a manual retry button.
2. A structural preview of the data view (chart axis labels / table column headers
   / card titles showing "what this will display once data returns"). **Never fill
   in fabricated values** — use empty arrays / skeleton lines / `—`.
3. Links to the official data sources for manual verification.
4. A one-line note: "数据恢复后此处将显示…".

Name the component `EmptyState` / `DegradedState` / `DataUnavailable` — never
`mock` / `fake` / `dummy` / `placeholder` / `sampleData` / `demoData` (honest-data
audit). Data acquisition is runtime (browser-side) only; `npm run build` MUST pass
fully offline with no build-time fetch dependency, so the page is always produced.

**Fail fast.** The Degraded State must appear within seconds, not minutes: probe a
real source **once** (a single point / latest year) with a short timeout; if that
first probe is unreachable or returns no coverage, degrade immediately. Never loop
over every grid cell / year / port retrying an unreachable source — that makes the
user stare at a spinner. One probe is enough to decide coverage.

## Output Checklist

- Buildable with `npm install` or `npm ci`.
- Deployable by Podman with the generated Dockerfile.
- All external API calls go through nginx reverse proxy, NEVER directly from browser JS.
- Runtime page has meaningful non-empty content (the Degraded State satisfies this when real data is unavailable).
- Buttons and controls have visible feedback.

## API Proxy Rule (nginx reverse proxy)

When the app calls an external API (ontology DaaS, NOAA tide, Open-Meteo wind,
AIS archives, etc.), the app's nginx.conf MUST include a reverse-proxy location
so the browser sends same-origin requests and nginx forwards them to the external
API. This avoids CORS failures (external APIs typically do not return
`Access-Control-Allow-Origin: *`) and keeps auth tokens server-side.

### Pattern

**CRITICAL — use nginx variables for every `proxy_pass` with an external hostname.**
nginx resolves hostnames at **startup** by default; if the container DNS can't reach
the external host (common in Podman), nginx crashes with `[emerg] host not found in
upstream`. Using a variable defers resolution to **request time** so nginx starts
even when DNS is temporarily unreachable.

```nginx
server {
    listen 80;
    root /usr/share/nginx/html;
    index index.html;

    # Runtime DNS resolution so nginx doesn't crash at startup
    # Docker embedded DNS = 127.0.0.11; fallback to public resolvers
    resolver 127.0.0.11 8.8.8.8 114.114.114.114 valid=30s ipv6=off;
    resolver_timeout 5s;

    # Reverse-proxy external API to avoid browser CORS
    location /api/data/ {
        set $upstream <EXTERNAL_HOST>;       # e.g. api.open-meteo.com
        proxy_pass https://$upstream/<path>; # use $upstream variable, NOT a literal hostname
        proxy_http_version 1.1;
        proxy_set_header Host <external-host>;
        # Inject auth headers server-side (never expose to browser)
        proxy_set_header Authorization "Bearer <token>";
        proxy_set_header <custom-header> "<value>";
        proxy_buffering off;
        proxy_read_timeout 120s;
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

### JS adapter

The browser JS MUST use the same-origin proxy path, NEVER the external URL:

```js
// CORRECT: same-origin through nginx proxy
const url = '/api/data/entity/Xxx/list';

// WRONG: direct external URL — WILL fail with CORS in browser
const url = 'http://external-api.example.com:8081/entity/Xxx/list';
```

Any data skill that provides an API base URL (`ONTOLOGY_API_BASE_URL`,
`TIDE_API_BASE_URL`, etc.) MUST be consumed through the nginx reverse proxy,
not called directly from client-side JavaScript.

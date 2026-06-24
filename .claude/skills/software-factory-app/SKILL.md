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
  unreachable, coverage not available, auth missing), show an **explicit error or
  empty state** and record the reason in `output.json` `warnings`. `mock_then_api`
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

## Output Checklist

- Buildable with `npm install` or `npm ci`.
- Deployable by Podman with the generated Dockerfile.
- Runtime page has meaningful non-empty content.
- Buttons and controls have visible feedback.

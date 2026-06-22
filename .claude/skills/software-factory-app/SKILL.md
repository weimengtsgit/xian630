---
name: software-factory-app
description: Generate a deployable React/Vite static application for the software factory.
---

# Software Factory App

## Must Do

- Generate files only under `generated-apps/<slug>/`.
- Generate `.factory/app.json`, `package.json`, `Dockerfile`, `nginx.conf`, `src/`, and `README.md`.
- Use React and Vite.
- Keep the app static and self-contained with mock data.
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
- When `input.json` carries `blueprintRefs`, read the referenced `scene/<slug>/scene.md` (if present) or `scene/<slug>/README.md` as a STYLE / STRUCTURE / INTERACTION / DATA-MODEL REFERENCE ONLY to inform page layout, controls, and mock data shape. Generate original code; never copy `scene/` source files into `generated-apps/`.

## Must Not Do

- Do not modify `scene/`, `factory-server/`, `cc-status/`, or `.git/`.
- Do not require a backend service.
- Do not fetch real military data.
- Do not require login, external credentials, or cloud services.

## Output Checklist

- Buildable with `npm install` or `npm ci`.
- Deployable by Podman with the generated Dockerfile.
- Runtime page has meaningful non-empty content.
- Buttons and controls have visible feedback.

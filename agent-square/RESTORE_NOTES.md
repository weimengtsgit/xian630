# Agent Square 18016 Source Restore Notes

This project is the local source restoration for Agent Square, the service currently exposed at:

```text
http://220.154.5.91:18016/
```

## What Was Restored

- The current local project name is `agent-square`.
- The restored project keeps only the minimum online runtime artifacts needed for local verification:

```text
runtime-data/api-apps.json
docs/online-18016/
```

- The online container source root and current version source were copied from the CTYun host.
- The deployed static `dist` was copied separately because the running Nginx service included runtime behavior that was not fully represented by the generated source snapshot.
- Local source now includes the runtime app merge behavior used by the deployed page:
  - synchronous bootstrap from `window.__STORE_APPS__`
  - fetch from `/api/apps`
  - browser helpers `window.registerStoreApp` and `window.deleteStoreApp`
  - 10 built-in apps reconstructed from the deployed bundle
  - runtime recommendation priority for `“光鱼”无人艇跟监告警智能体`

## Runtime Data

The online service exposes dynamic app data through Nginx njs:

```text
/api/apps
```

The captured local runtime data is:

```text
runtime-data/api-apps.json
```

At capture time it contained one runtime app:

```text
“光鱼”无人艇跟监告警智能体
```

## Local Restore Verification

Install dependencies if needed:

```bash
npm install
```

Build from source:

```bash
npm run build
```

Run a local preview that serves `dist` and emulates the online `/api/apps` endpoint:

```bash
npm run preview:local
```

Then open:

```text
http://127.0.0.1:18016/
```

Useful overrides:

```bash
PORT=18018 npm run preview:local
API_APPS_FILE=/path/to/api-apps.json npm run preview:local
DIST_DIR=/path/to/dist npm run preview:local
```

## Deployment Note

The frontend source can now be modified and rebuilt locally. To preserve online behavior after deployment, the deployed Nginx layer must continue to provide `/api/apps` with the same contract:

- `GET /api/apps` returns an array of runtime apps.
- `POST /api/apps` inserts or updates a runtime app.
- `DELETE /api/apps/{id-or-name}` removes a runtime app.

The captured online Nginx implementation is available at:

```text
docs/online-18016/ops-store-api.js
docs/online-18016/nginx-T.txt
```

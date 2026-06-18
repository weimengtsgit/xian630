# 东海目标态势演示

Preset scene app for a desktop command-map situation display.

## Run

```bash
npm install
npm run dev
```

Open the local URL printed by Vite.

## Container

```bash
podman build -t software-factory/east-sea-situation:latest .
podman run --rm -p 18080:80 software-factory/east-sea-situation:latest
```

## Notes

- This is a frontend-only prototype.
- Situation data is mocked in `src/features/situation/data/mockSituation.ts`.
- Map imagery is configured through `VITE_MAP_TILE_URL`; `.env.example` contains a public development default.
- The prototype uses MapLibre for map features and React overlays for panels, cards, and timeline UI.
- Factory manifest: `.factory/app.json`.

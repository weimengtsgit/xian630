# 航母编队月度航迹复盘

Preset scene app for a desktop carrier formation track replay display.

## Run

```bash
npm install
npm run dev
```

Open the local URL printed by Vite.

## Container

```bash
podman build -t software-factory/carrier-formation-replay:latest .
podman run --rm -p 18081:80 software-factory/carrier-formation-replay:latest
```

## Notes

- This is a frontend-only prototype.
- Formation data is mocked in `src/features/carrierFormation/data/mockFormation.ts`.
- Map imagery is configured through `VITE_MAP_TILE_URL`; `.env.example` contains a public development default.
- The prototype uses MapLibre for the map route/event layers and React overlays for panels, ship markers, event cards, and timeline UI.
- Factory manifest: `.factory/app.json`.

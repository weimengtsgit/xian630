# Situation Prototype

Throwaway UI prototype for a desktop command-map situation display.

## Run

```bash
npm install
npm run dev
```

Open the local URL printed by Vite.

## Notes

- This is a frontend-only prototype.
- Situation data is mocked in `src/features/situation/data/mockSituation.ts`.
- Map imagery is configured through `VITE_MAP_TILE_URL`; `.env.example` contains a public development default.
- The prototype uses MapLibre for map features and React overlays for panels, cards, and timeline UI.


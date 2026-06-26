# Prototype Notes

Question answered by this prototype:

Can the previous situation-map visual language support a one-month carrier formation track replay with daily playback and event-driven analysis?

Current decision:

- Use a single-page React application in a standalone prototype directory.
- Use MapLibre for map pan/zoom, full route, played route, event points, and formation envelope.
- Use React/CSS overlays for command UI, formation overview, ship markers, event details, and month timeline.
- Keep data mocked but shaped like future API payloads.
- Model one carrier core ship plus escorts with relative formation offsets.
- Target desktop command screens first; mobile layout is out of scope.

Delete or absorb this directory once the validated parts are moved into a production application.

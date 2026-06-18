# Prototype Notes

Question answered by this prototype:

Can the screenshot direction be represented as a desktop map workstation using a real map engine, mock situation data, and React overlays without committing to backend services?

Current decision:

- Use a single-page React application.
- Use MapLibre for map pan/zoom, targets, tracks, zones, and relation lines.
- Use React/CSS overlays for command UI, target panels, cards, and timeline.
- Keep data mocked but shaped like future API payloads.
- Target desktop command screens first; mobile layout is out of scope.

Delete or absorb this directory once the validated parts are moved into a production application.


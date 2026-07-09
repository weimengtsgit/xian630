# Online 18016 Runtime Notes

This directory keeps the minimum online runtime artifacts needed to run Agent Square locally after cleaning the larger downloaded snapshot.

## Files

- `ops-store-api.js`: captured Nginx njs handler for `/api/apps`.
- `nginx-T.txt`: captured online Nginx effective configuration.
- `summary.env`: captured container/source summary.

The local preview reads runtime app data from:

```text
../../runtime-data/api-apps.json
```

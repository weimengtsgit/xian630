---
name: deck-wind-data-skill
description: Fetch and normalize real 10 m wind data for carrier operating regions or sea areas, then provide the fields needed for deck-wind assessment. Use when a request mentions deck wind, 10 m wind, wind speed, wind direction, carrier operating area, launch or recovery wind conditions, or regional wind data. Skip this skill only when the user explicitly requests mock or demo data.
---

# Deck Wind Data Skill

## Default Rule

- Use real data by default.
- Skip this skill only when the user explicitly asks for `mock`, `demo data`, or `sample data`.
- Return failure when every real source fails. Do not synthesize wind values.

## Trigger Mapping

- Trigger on intent about `deck wind`, `10 m wind`, `wind speed and direction`, `recovery condition`, or `launch wind`.
- Use this skill when the result must drive deck-wind calculation or readiness judgement.
- Ask for missing region coordinates only when the region cannot be mapped safely.

## Source Priority

Use sources in this order unless the caller overrides `sourcePriority`:

1. `gfs-nomads`
2. `shipxy`
3. `nmc-or-marine-page`
4. fail

Rules:

- Prefer structured gridded data over rendered pages.
- Normalize every source to region-point wind observations before downstream calculation.
- Set `meta.isFallback=true` when the winning source is not the first usable source.

## Input Contract

Expect a payload shaped like:

```json
{
  "regions": [
    {
      "id": "western-pacific",
      "name": "Western Pacific",
      "lat": 22.4,
      "lon": 138.7
    }
  ],
  "deckWindMinKt": 20,
  "carrierMaxSpeedKt": 30,
  "sourcePriority": ["gfs-nomads", "shipxy"],
  "useMock": false,
  "timeoutMs": 10000
}
```

Interpretation:

- `regions` is required.
- `deckWindMinKt` defaults to `20` when missing.
- `carrierMaxSpeedKt` defaults to `30` when missing.
- `useMock=true` means do not use this skill.

## Output Contract

Return:

```json
{
  "ok": true,
  "meta": {
    "source": "gfs-nomads",
    "sourceLevel": "primary",
    "isFallback": false,
    "fetchedAt": "2026-06-23T15:00:00+08:00"
  },
  "data": {
    "regions": [
      {
        "id": "western-pacific",
        "region": "Western Pacific",
        "lat": 22.4,
        "lon": 138.7,
        "windSpeedKt": 26,
        "windFromDeg": 200,
        "windFromCardinal": "south-southwest",
        "deckWindMinKt": 20,
        "carrierMaxSpeedKt": 30
      }
    ]
  }
}
```

Requirements:

- Normalize wind speed to knots.
- Normalize direction to degrees and, when possible, a cardinal label.
- Return only the fields needed for downstream deck-wind calculation.
- Keep downstream calculation outside this skill unless the caller explicitly asks for the assessed range and status.

## Failure Rules

- Return `ok=false` when all real sources fail.
- Include `sourceTried`, `error.code`, and per-source failure details.
- Do not return partially inferred wind direction when the source does not provide it.

Recommended error codes:

- `INVALID_INPUT`
- `SOURCE_TIMEOUT`
- `SOURCE_AUTH_FAILED`
- `SOURCE_RESPONSE_INVALID`
- `ALL_SOURCES_FAILED`

## Must Not Do

- Do not return mock wind data.
- Do not estimate wind values from screenshots or rendered maps unless page extraction is the configured fallback path.
- Do not present calculated deck-wind readiness as source truth when only raw wind data was requested.

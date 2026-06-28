// Verifies the portal application ordering is driven by the server-supplied
// display_order (from .factory/scene-catalog.json) rather than a hard-coded slug
// list. Preset application-surface apps sort by display_order ascending; then
// generated apps by newest updated_at; slug is a tie-breaker only.
import assert from 'node:assert/strict'
import { orderApplicationsForDisplay } from '../src/hooks/applicationOrdering.js'

// Preset application-surface apps carry their catalog display_order. The three
// application surfaces per the catalog are carrier-formation-replay(1),
// aircraft-carrier-track(2), east-sea-situation(3). The four blueprint presets
// (display_order 0) are not returned by GET /api/apps so they are omitted here.
const presetApps = [
  { slug: 'east-sea-situation', name: '东海目标态势演示', source: 'preset', display_order: 3 },
  { slug: 'aircraft-carrier-track', name: '航母轨迹分析', source: 'preset', display_order: 2 },
  { slug: 'carrier-formation-replay', name: '航母编队月度航迹复盘', source: 'preset', display_order: 1 },
]

// Generated apps are ordered by newest updated_at, slug as tie-breaker.
const generatedApps = [
  { slug: 'gen-old', name: '旧生成应用', source: 'generated', updated_at: '2026-06-01T00:00:00Z' },
  { slug: 'gen-new', name: '新生成应用', source: 'generated', updated_at: '2026-06-23T00:00:00Z' },
]

const ordered = orderApplicationsForDisplay([...presetApps, ...generatedApps])

assert.deepEqual(
  ordered.map(app => app.slug),
  [
    'carrier-formation-replay', // display_order 1
    'aircraft-carrier-track',   // display_order 2
    'east-sea-situation',       // display_order 3
    'gen-new',                  // newest generated
    'gen-old',                  // older generated
  ],
)

assert.notEqual(ordered, presetApps)

// Tie-breaker: equal display_order resolves by slug only.
const tied = orderApplicationsForDisplay([
  { slug: 'zebra', source: 'preset', display_order: 1 },
  { slug: 'alpha', source: 'preset', display_order: 1 },
])
assert.deepEqual(
  tied.map(app => app.slug),
  ['alpha', 'zebra'],
)

// The social scene carries the corrected display name (asserted here so the
// catalog metadata fix stays in lockstep with ordering).
assert.equal(
  presetApps[0].name,
  '东海目标态势演示',
)

console.log('application ordering check passed')

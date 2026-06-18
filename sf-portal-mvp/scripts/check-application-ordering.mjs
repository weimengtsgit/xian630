import assert from 'node:assert/strict'
import { orderApplicationsForDisplay } from '../src/hooks/applicationOrdering.js'

const apps = [
  { slug: 'east-sea-situation', name: '东海目标态势演示' },
  { slug: 'aircraft-carrier-track', name: '航母轨迹分析' },
  { slug: 'carrier-deck-wind-calculator', name: '甲板风实时计算器' },
  { slug: 'carrier-formation-replay', name: '航母编队月度航迹复盘' },
  { slug: 'social-sighting-cluster-alert', name: '海域网格商船密度异常告警器' },
  { slug: 'merchant-density-grid-alert', name: '海域网格商船密度异常告警器' },
  { slug: 'carrier-homeport-tide-window', name: '航母母港潮汐窗口计算器' },
]

const ordered = orderApplicationsForDisplay(apps)

assert.deepEqual(
  ordered.map(app => app.slug),
  [
    'carrier-homeport-tide-window',
    'carrier-deck-wind-calculator',
    'merchant-density-grid-alert',
    'social-sighting-cluster-alert',
    'carrier-formation-replay',
    'east-sea-situation',
    'aircraft-carrier-track',
  ],
)

assert.notEqual(ordered, apps)

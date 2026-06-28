// Verifies the application wording uses "应用" instead of "智能体" for business apps
// while preserving "协作智能体" and "纳管智能体"
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const workbenchJsx = readFileSync(new URL('../src/components/ConversationWorkbench.jsx', import.meta.url), 'utf8')
const appsPanelJsx = readFileSync(new URL('../src/components/ApplicationsPanel.jsx', import.meta.url), 'utf8')
const combinedProductSurfaces = `${workbenchJsx}\n${appsPanelJsx}`

// Verify old "智能体" wording is NOT present for application products
assert.doesNotMatch(combinedProductSurfaces, /复用已有智能体/, 'application product copy must say 复用已有应用')
assert.doesNotMatch(combinedProductSurfaces, /生成新智能体/, 'application product copy must say 生成新应用')
assert.doesNotMatch(combinedProductSurfaces, /生成智能体/, 'application product copy must say 生成应用')
assert.doesNotMatch(combinedProductSurfaces, /智能体已就绪/, 'application product copy must say 应用已就绪')
assert.doesNotMatch(appsPanelJsx, /业务智能体/, 'legacy ApplicationsPanel product tab/header must say 应用')

// Verify "协作智能体" and "纳管智能体" are PRESERVED
assert.match(workbenchJsx, /协作智能体/, 'collaboration-agent copy must remain 协作智能体')
assert.match(appsPanelJsx, /纳管智能体/, 'managed-agent copy must remain 纳管智能体')

console.log('application wording check passed')

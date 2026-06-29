// Verifies the application wording uses "应用" instead of "智能体" for business apps
// while preserving "协作智能体" and "纳管智能体"
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const workbenchJsx = readFileSync(new URL('../src/components/ConversationWorkbench.jsx', import.meta.url), 'utf8')
const appsPanelJsx = readFileSync(new URL('../src/components/ApplicationsPanel.jsx', import.meta.url), 'utf8')

// Verify legacy application panels still use 应用 rather than 业务智能体.
assert.match(appsPanelJsx, /<h2>应用<\/h2>|>应用</, 'ApplicationsPanel product tab/header must say 应用')
assert.doesNotMatch(appsPanelJsx, /业务智能体/, 'legacy ApplicationsPanel product tab/header must say 应用')

// Verify "协作智能体" and "纳管智能体" are PRESERVED
assert.match(workbenchJsx, /协作智能体/, 'collaboration-agent copy must remain 协作智能体')
assert.match(appsPanelJsx, /纳管智能体/, 'managed-agent copy must remain 纳管智能体')

console.log('application wording check passed')

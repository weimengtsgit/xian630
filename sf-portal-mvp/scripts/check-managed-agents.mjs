import assert from 'node:assert/strict'
import fs from 'node:fs'
import { buildDialogueTimeline } from '../src/hooks/dialogueTimeline.js'

const client = fs.readFileSync(new URL('../src/api/client.js', import.meta.url), 'utf8')
const panel = fs.readFileSync(new URL('../src/components/ApplicationsPanel.jsx', import.meta.url), 'utf8')
const workbench = fs.readFileSync(new URL('../src/components/ConversationWorkbench.jsx', import.meta.url), 'utf8')

assert.match(client, /listManagedAgents:\s*\(\)\s*=>\s*request\('\/api\/managed-agents'\)/)
assert.match(panel, /纳管智能体/)
assert.match(panel, /纳管中/, 'managed-agent status badge should read 纳管中')
assert.doesNotMatch(panel, />纳管<\//, 'managed-agent status badge should not use the shorter 纳管 label')
assert.match(panel, /基于该智能体重新生成/)
assert.match(panel, /确认删除生成智能体/)
assert.match(panel, /删除生成智能体/)
assert.doesNotMatch(panel, /基于该应用重新生成/)
assert.doesNotMatch(panel, /确认删除生成应用/)
assert.doesNotMatch(panel, /删除生成应用/)
assert.match(panel, /managedAgents/)
assert.match(panel, /agent\.description[\s\S]*app-sub-tooltip/, 'managed-agent detail text must use the same hover tooltip as business-agent cards')
assert.match(panel, /\{agent\.url \? \(/, 'managed-agent panel must only render open action when url is present')
assert.doesNotMatch(panel, /<div className="app-card-footer">\s*<button[^>]+window\.open\(agent\.url/s, 'managed-agent panel must not unconditionally open empty urls')
assert.match(workbench, /running && canOpen/, 'managed recommendations must only render open action when url is present')
assert.match(workbench, /card\.kind === 'managed_agent'/)
assert.match(workbench, /window\.open\(card\.runtimeUrl/)

const timeline = buildDialogueTimeline({
  session: { id: 'dlg_managed', status: 'recommending', intent: 'existing_application', route_locked: true },
  messages: [],
  recommendations: [
    {
      applicationId: 'managed-agent-baidu',
      kind: 'managed_agent',
      slug: 'baidu',
      name: '百度',
      appType: 'managed_agent',
      matchReason: '相似入口',
      status: 'running',
      runtimeUrl: 'https://www.baidu.com',
      primary: true,
    },
  ],
})
const rec = timeline.find(item => item.type === 'app_recommendation')
assert.equal(rec.cards[0].kind, 'managed_agent')

console.log('managed agents check passed')

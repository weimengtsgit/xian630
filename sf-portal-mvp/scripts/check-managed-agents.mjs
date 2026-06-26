import assert from 'node:assert/strict'
import fs from 'node:fs'
import { buildDialogueTimeline } from '../src/hooks/dialogueTimeline.js'

const client = fs.readFileSync(new URL('../src/api/client.js', import.meta.url), 'utf8')
const panel = fs.readFileSync(new URL('../src/components/ApplicationsPanel.jsx', import.meta.url), 'utf8')
const workbench = fs.readFileSync(new URL('../src/components/ConversationWorkbench.jsx', import.meta.url), 'utf8')

assert.match(client, /listManagedAgents:\s*\(\)\s*=>\s*request\('\/api\/managed-agents'\)/)
assert.match(panel, /纳管智能体/)
assert.match(panel, /managedAgents/)
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

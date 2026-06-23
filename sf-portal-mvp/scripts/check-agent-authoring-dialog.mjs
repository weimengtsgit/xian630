import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/components/AgentsPanel.jsx', import.meta.url), 'utf8')

assert.match(source, /const emptyAuthoringState = \{[\s\S]*initializing:/)
assert.doesNotMatch(source, /const closeAuthoringDialog = \(\) => \{\s*if \(authoring\.saving\) return/)
assert.doesNotMatch(source, /placeholder="例如：创建海事预警专家[\s\S]*disabled=\{authoring\.saving\}/)
assert.doesNotMatch(source, /取消[\s\S]{0,180}disabled=\{authoring\.saving\}/)

console.log('check-agent-authoring-dialog: OK')

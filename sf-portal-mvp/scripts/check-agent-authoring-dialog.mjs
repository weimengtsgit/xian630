import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/components/AgentsPanel.jsx', import.meta.url), 'utf8')

assert.match(source, /const emptyAuthoringState = \{[\s\S]*initializing:/)
assert.match(source, /canSaveAuthoring/)
assert.doesNotMatch(source, /const closeAuthoringDialog = \(\) => \{\s*if \(authoring\.saving\) return/)
assert.doesNotMatch(source, /disabled=\{authoring\.saving\}/)
assert.doesNotMatch(source, /disabled=\{authoringBusy \|\| !canFinalize\}/)

console.log('check-agent-authoring-dialog: OK')

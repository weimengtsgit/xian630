import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/components/AgentsPanel.jsx', import.meta.url), 'utf8')

assert.match(source, /const emptyAuthoringState = \{[\s\S]*initializing:/)
assert.match(source, /canSaveAuthoring/)
assert.match(source, /ensureAuthoringSession/)
assert.match(source, /onCreateBusinessAgent/)
assert.match(source, /authoringFieldRows/)
assert.match(source, /await onCreateBusinessAgent\(\{[\s\S]*key:[\s\S]*name:[\s\S]*description:[\s\S]*prompt:[\s\S]*enabled:/)
assert.doesNotMatch(source, /const closeAuthoringDialog = \(\) => \{\s*if \(authoring\.saving\) return/)
assert.doesNotMatch(source, /disabled=\{authoring\.saving\}/)
assert.doesNotMatch(source, /disabled=\{authoringBusy \|\| !canFinalize\}/)
assert.doesNotMatch(source, /disabled=\{authoringBusy \|\| !authoring\.session\?\.id \|\| !authoring\.input\.trim\(\)\}/)
assert.doesNotMatch(source, /await onFinalizeAuthoring/)
assert.doesNotMatch(source, /canSaveAuthoring = Boolean\(canFinalize \|\| hasAuthoringInput\)/)
assert.doesNotMatch(source, /生成并保存/)

console.log('check-agent-authoring-dialog: OK')

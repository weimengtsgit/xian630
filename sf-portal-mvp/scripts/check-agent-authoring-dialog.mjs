import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/components/AgentsPanel.jsx', import.meta.url), 'utf8')

// Old authoring modal code must be removed
assert.doesNotMatch(source, /emptyAuthoringState/, 'emptyAuthoringState must be removed')
assert.doesNotMatch(source, /authoringOpen/, 'authoringOpen state must be removed')
assert.doesNotMatch(source, /ensureAuthoringSession/, 'ensureAuthoringSession must be removed')
assert.doesNotMatch(source, /sendAuthoringContent/, 'sendAuthoringContent must be removed')
assert.doesNotMatch(source, /finalizeAuthoring/, 'finalizeAuthoring must be removed')

// Old props that are no longer needed must be removed
assert.doesNotMatch(source, /onStartAuthoring/, 'onStartAuthoring prop must be removed (replaced by dialog)')
assert.doesNotMatch(source, /onCreateAuthoringSession/, 'onCreateAuthoringSession prop must be removed')
assert.doesNotMatch(source, /onSendAuthoringMessage/, 'onSendAuthoringMessage prop must be removed')

// New: dialog integration
assert.match(source, /useAgentAuthoringDialog/, 'must use useAgentAuthoringDialog hook')
assert.match(source, /AgentAuthoringDialog/, 'must render AgentAuthoringDialog component')
assert.match(source, /onRefreshAgents/, 'must accept onRefreshAgents prop')
assert.match(source, /openAuthoringDialog/, 'must call openAuthoringDialog on create button')

// Agent detail and edit functionality must still be present
assert.match(source, /onCreateBusinessAgent/, 'onCreateBusinessAgent prop must still exist')
assert.match(source, /onUpdateBusinessAgent/, 'onUpdateBusinessAgent prop must still exist')

console.log('check-agent-authoring-dialog: OK')

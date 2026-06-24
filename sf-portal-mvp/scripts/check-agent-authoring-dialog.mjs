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

// Regression: editing a business agent must not trap the user in 保存中.
// The save request is abortable, and the cancel button remains available.
assert.match(source, /useRef/, 'edit save flow must keep an abort controller ref')
assert.match(source, /new AbortController\(\)/, 'edit save request must be abortable')
assert.match(source, /onClick=\{cancelEdit\}/, 'edit cancel button must abort and leave editing')
assert.doesNotMatch(source, /onClick=\{cancelEdit\}\s+disabled=\{editSaving\}/, 'edit cancel must remain clickable while saving')

const clientSource = readFileSync(new URL('../src/api/client.js', import.meta.url), 'utf8')
assert.match(clientSource, /DEFAULT_TIMEOUT_MS/, 'API requests must have a default timeout')
assert.match(clientSource, /请求超时，请稍后重试/, 'timed-out API requests must surface a user-readable error')
console.log('check-agent-authoring-dialog: OK')

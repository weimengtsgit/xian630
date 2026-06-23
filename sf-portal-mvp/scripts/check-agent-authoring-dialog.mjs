import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/components/AgentsPanel.jsx', import.meta.url), 'utf8')

// Old authoring modal code must be removed
assert.doesNotMatch(source, /emptyAuthoringState/, 'emptyAuthoringState must be removed')
assert.doesNotMatch(source, /authoringOpen/, 'authoringOpen state must be removed')
assert.doesNotMatch(source, /ensureAuthoringSession/, 'ensureAuthoringSession must be removed')
assert.doesNotMatch(source, /sendAuthoringContent/, 'sendAuthoringContent must be removed')
assert.doesNotMatch(source, /finalizeAuthoring/, 'finalizeAuthoring must be removed')
assert.doesNotMatch(source, /authoring-dialog/, 'authoring dialog JSX must be removed')
assert.doesNotMatch(source, /authoring-message/, 'authoring message JSX must be removed')
assert.doesNotMatch(source, /authoring-draft/, 'authoring draft preview JSX must be removed')
assert.doesNotMatch(source, /authoring-input-row/, 'authoring input row JSX must be removed')

// New: onStartAuthoring prop must be present
assert.match(source, /onStartAuthoring/, 'onStartAuthoring prop must be accepted')

// New: create button delegates to onStartAuthoring
assert.match(source, /onStartAuthoring\?\.\(\)/, 'create button must call onStartAuthoring')

// Old props must be removed
assert.doesNotMatch(source, /onCreateAuthoringSession/, 'onCreateAuthoringSession prop must be removed')
assert.doesNotMatch(source, /onSendAuthoringMessage/, 'onSendAuthoringMessage prop must be removed')

// Agent detail and edit functionality must still be present
assert.match(source, /onCreateBusinessAgent/, 'onCreateBusinessAgent prop must still exist')
assert.match(source, /onUpdateBusinessAgent/, 'onUpdateBusinessAgent prop must still exist')

console.log('check-agent-authoring-dialog: OK')

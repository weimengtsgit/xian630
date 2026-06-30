import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const appCss = readFileSync(new URL('../src/App.css', import.meta.url), 'utf8')
const clarCss = readFileSync(new URL('../src/components/ClarificationPanel.css', import.meta.url), 'utf8')
const chatCss = readFileSync(new URL('../src/components/ChatDialog.css', import.meta.url), 'utf8')
const chatJsx = readFileSync(new URL('../src/components/ChatDialog.jsx', import.meta.url), 'utf8')
const clarJsx = readFileSync(new URL('../src/components/ClarificationPanel.jsx', import.meta.url), 'utf8')

assert.match(clarJsx, /handleAbandonRequirement/, 'ClarificationPanel abandon action should route through a confirmation handler')
assert.match(clarJsx, /window\.confirm\('确定放弃本次需求吗？/, 'ClarificationPanel abandon action should ask for confirmation')
assert.match(clarJsx, /放弃本次需求/, 'ClarificationPanel abandon action should use explicit wording')
assert.match(clarCss, /\.clar-abandon\s*\{[\s\S]*background:\s*transparent/, 'ClarificationPanel abandon action should be visually secondary')

assert.match(
  appCss,
  /\.wb-center\s*>\s*\.conversation-workbench\s*\{[^}]*flex:\s*1\s+1\s+0[^}]*min-height:\s*360px/s,
  'center column must allocate a larger flexible row to the conversation workbench',
)

assert.doesNotMatch(
  clarCss,
  /\.clar-panel\s*\{[^}]*max-height:\s*360px/s,
  'clarification panel must not keep the old 360px cap',
)

assert.match(
  clarCss,
  /\.clar-scroll\s*\{[^}]*flex:\s*1/s,
  'clarification scroll body must flex to consume the larger panel height',
)

assert.match(
  chatCss,
  /\.chat-dock\s*\{[^}]*min-height:\s*0/s,
  'chat dock base height must shrink to content so the empty state has no blank area below the input',
)

assert.match(
  chatJsx,
  /chat-dock-empty-mode/,
  'ChatDialog root must expose an empty-mode class for the no-bottom-blank layout',
)

assert.match(
  chatCss,
  /\.chat-dock-messages-empty\s*\{[^}]*flex:\s*0\s+0\s+auto/s,
  'empty chat history must not reserve a tall blank message area above the input',
)

assert.match(
  chatCss,
  /\.chat-dock-messages-has-history\s*\{[^}]*flex:\s*1\s+1\s+auto/s,
  'chat history area must still expand when real messages exist',
)

assert.match(
  clarJsx,
  /q\.multiSelect/,
  'clarification panel must branch multi-select questions instead of submitting every option click immediately',
)

assert.match(
  clarJsx,
  /onAnswerBatch/,
  'clarification panel must submit all answers for the current round through the batch API',
)

assert.match(
  clarJsx,
  /JSON\.stringify\(value\)/,
  'multi-select answers must be serialized as JSON string arrays in the batch payload',
)

assert.match(
  clarJsx,
  /setSingleAnswer\(q\.id,\s*opt\.value\)/,
  'single-select option clicks must stage the answer instead of immediately submitting and advancing a round',
)

assert.doesNotMatch(
  clarJsx,
  /return recommendationValues\(q\)/,
  'recommended clarification values must not be treated as default selected answers',
)

assert.match(
  clarCss,
  /\.clar-round-actions/,
  'clarification questions need a round-level submit area so multiple answers are sent together',
)

assert.match(
  readFileSync(new URL('../src/hooks/useClarification.js', import.meta.url), 'utf8'),
  /getActiveClarification/,
  'clarification hook must rehydrate the active server-side session after a portal reload',
)

assert.match(
  clarCss,
  /\.clar-option-selected/,
  'multi-select options must expose a selected visual state',
)

console.log('check-clarification-layout: OK')

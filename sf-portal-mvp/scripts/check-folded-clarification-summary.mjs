// sf-portal-mvp/scripts/check-folded-clarification-summary.mjs
//
// Task 3 (澄清交互卡片 + 折叠澄清摘要卡) layout assertions.
//
// Guards the two glossary-driven invariants:
//   1. 澄清交互卡片 _Avoid_: 输入框回填选项, 卡片外提交. The job-step
//      ClarificationPromptCard must NOT refill the composer. Selection lives
//      inside the card and submits via an in-card action. The old
//      onPickClarification append-to-input path must be gone.
//   2. 折叠澄清摘要卡 _Avoid_: 删除历史澄清, 隐藏产物入口, 只显示完成图标.
//      A completed clarification/confirmation card must render a folded summary
//      (FoldedClarificationSummary) carrying agent label, completion state, the
//      final answer / confirmation result, clickable artifact entries (产物入口),
//      confirmation time, and an expand action.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const jsx = readFileSync(new URL('../src/components/ConversationWorkbench.jsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('../src/components/ConversationWorkbench.css', import.meta.url), 'utf8')

// ---------------------------------------------------------------------------
// 1. NO composer-refill path (澄清交互卡片 _Avoid_: 输入框回填选项, 卡片外提交)
// ---------------------------------------------------------------------------

// The old onPickClarification prop (which appended the picked value into the
// composer input) must be gone from both the TimelineItem wiring and the
// ClarificationPromptCard props.
assert.doesNotMatch(
  jsx,
  /onPickClarification/,
  'the onPickClarification composer-refill prop must be removed entirely',
)
assert.doesNotMatch(
  jsx,
  /onPick=\{onPickClarification\}/,
  'ClarificationPromptCard must not receive an onPick prop that refills the composer',
)

// ClarificationPromptCard must NOT call setInput (the composer state setter)
// — its selection lives in local state and submits via the in-card action.
// Match setInput inside the ClarificationPromptCard body would indicate the
// refill path crept back in.
const clarCardStart = jsx.indexOf('function ClarificationPromptCard(')
// Slice to the next top-level function so nested braces don't truncate.
const clarCardEnd = jsx.indexOf('\nfunction ', clarCardStart + 1)
const clarCardBody = jsx.slice(clarCardStart, clarCardEnd === -1 ? undefined : clarCardEnd)
assert.doesNotMatch(
  clarCardBody,
  /setInput\(/,
  'ClarificationPromptCard must never call the composer setInput (no 输入框回填)',
)

// The dead handlePickCardQuestion helper (which also called setInput to refill
// the composer from an agent-block question pick) must be gone.
assert.doesNotMatch(
  jsx,
  /handlePickCardQuestion/,
  'handlePickCardQuestion (composer-refill helper for agent-block questions) must be removed',
)

// ---------------------------------------------------------------------------
// 2. In-card submit is the ONLY answer path
// ---------------------------------------------------------------------------

// ClarificationPromptCard must stage its own selection and submit via an
// in-card action bound to onSubmit (wired to onSubmitClarification).
assert.match(
  clarCardBody,
  /onSubmit/,
  'ClarificationPromptCard must submit via an onSubmit prop (in-card submit)',
)
assert.match(
  clarCardBody,
  /cw-clarification-submit/,
  'ClarificationPromptCard must render a cw-clarification-submit in-card action',
)
assert.match(
  jsx,
  /onSubmitClarification=/,
  'ConversationWorkbench must wire onSubmitClarification to the in-card submit handler',
)

// The in-card submit must route through onSend (which itself routes to
// jobs.answerJob when the clarification scope is active), NOT through the
// composer textarea's value.
assert.match(
  jsx,
  /await onSend\(value,/,
  'the in-card clarification submit must call onSend directly (never fill the composer)',
)

// ---------------------------------------------------------------------------
// 3. FoldedClarificationSummary carries the glossary-required summary fields
//    (折叠澄清摘要卡 MUST keep: agent label, completion state, 思考摘要,
//     final answer / confirmation result, artifact entries, confirmation
//     time, expand action)
// ---------------------------------------------------------------------------

const foldStart = jsx.indexOf('function FoldedClarificationSummary(')
// Slice to the next top-level function definition so the body captures the
// whole component (nested closing braces would otherwise cut the slice short).
const foldEnd = jsx.indexOf('\nfunction ', foldStart + 1)
const foldBody = jsx.slice(foldStart, foldEnd === -1 ? undefined : foldEnd)

assert.match(foldBody, /agentLabel/, 'summary must render the agent label (阶段/责任名)')
assert.match(foldBody, /completionState/, 'summary must render the completion state')
assert.match(foldBody, /resultText/, 'summary must render the final answer / confirmation result')
assert.match(foldBody, /artifact/, 'summary must render confirmed artifact entries (产物入口)')
assert.match(foldBody, /confirmedAt/, 'summary must render the confirmation time')
assert.match(foldBody, /cw-fold-hint/, 'summary must expose an expand action (cw-fold-hint)')
assert.match(foldBody, /aria-expanded=\{expanded\}/, 'summary expand action must be keyboard-accessible (aria-expanded)')

// The artifact entry must remain CLICKABLE (产物入口) — not just an icon.
assert.match(
  foldBody,
  /onClick=\{\(\) => onOpenArtifact && onOpenArtifact\(artifact\)\}/,
  'the summary artifact entry must remain clickable (产物入口), not just an icon',
)

// CSS for the folded summary must exist (no new visual style — reuses dark tokens).
assert.match(css, /\.cw-clarification-summary\s*\{/, 'cw-clarification-summary CSS must exist')
assert.match(css, /\.cw-clarification-state\s*\{/, 'cw-clarification-state badge CSS must exist')
assert.match(css, /\.cw-clarification-submit\s*\{/, 'cw-clarification-submit CSS must exist')

// ---------------------------------------------------------------------------
// 4. ClarificationPromptCard answered state renders the folded summary
// ---------------------------------------------------------------------------

// When status !== 'open', the card must render FoldedClarificationSummary
// (not the open in-card form). The component must branch on `open`.
assert.match(
  clarCardBody,
  /if \(!open\)/,
  'ClarificationPromptCard must branch: answered → folded summary',
)
assert.match(
  clarCardBody,
  /<FoldedClarificationSummary/,
  'ClarificationPromptCard answered state must render FoldedClarificationSummary',
)

// ---------------------------------------------------------------------------
// 5. prototype_confirmed (Task 2 durable item) also renders as a folded summary
// ---------------------------------------------------------------------------

const protoStart = jsx.indexOf("item.type === 'prototype_confirmed'")
const protoEnd = jsx.indexOf('\n  }', protoStart)
const protoBody = jsx.slice(protoStart, protoEnd)
assert.match(
  protoBody,
  /<FoldedClarificationSummary/,
  'the durable prototype_confirmed item must render as a folded summary (not a plain card)',
)
assert.match(
  protoBody,
  /outcome=\{item\.outcome\}/,
  'the prototype summary must pass the outcome discriminator',
)

// ---------------------------------------------------------------------------
// 6. dialogueTimeline carries the summary fields onto clarification_prompt
// ---------------------------------------------------------------------------

const timelineJs = readFileSync(new URL('../src/hooks/dialogueTimeline.js', import.meta.url), 'utf8')
assert.match(timelineJs, /confirmedAt/, 'clarification_prompt item must carry confirmedAt for the summary')
assert.match(timelineJs, /finalAnswer/, 'clarification_prompt item must carry finalAnswer for the summary')
assert.match(timelineJs, /stepKind/, 'clarification_prompt item must carry stepKind for the agent label')

console.log('check-folded-clarification-summary: OK')

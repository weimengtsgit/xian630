import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const css = readFileSync(new URL('../src/components/AgentsPanel.css', import.meta.url), 'utf8')
const jsx = readFileSync(new URL('../src/components/AgentsPanel.jsx', import.meta.url), 'utf8')

assert.match(
  css,
  /\.panel-content\s*\{[^}]*flex:\s*1[^}]*overflow-y:\s*auto[^}]*padding:\s*12px/s,
  'agent panel should restore the feat-0622 scroll container on panel-content',
)

assert.doesNotMatch(
  css,
  /\.panel-content::before|\.panel-content::after/,
  'agent panel must not paint a fake scrollbar because it looks draggable but cannot scroll',
)

assert.match(
  css,
  /\.panel-content::-webkit-scrollbar\s*\{[^}]*width:\s*6px/s,
  'agent panel should restore feat-0622 native scrollbar styling on panel-content',
)

assert.doesNotMatch(
  css,
  /\.agents-list\s*\{[^}]*overflow-y:/s,
  'agent list itself should not be the scroll container after restoring feat-0622 layout',
)

assert.match(
  css,
  /\.agent-card-footer\s*\{[^}]*display:\s*flex[^}]*flex-wrap:\s*wrap/s,
  'agent delete action should live inside the card footer like feat-0622 app cards',
)

assert.match(
  css,
  /\.card-btn\s*\{[^}]*display:\s*flex[^}]*cursor:\s*pointer/s,
  'agent delete button should use the restored in-card button style',
)

assert.doesNotMatch(
  css,
  /\.agent-card-row|\.agent-card-delete|\.agents-list\.has-delete-confirm/,
  'agent delete layout must not participate in the agent list scroll geometry',
)

assert.doesNotMatch(
  jsx,
  /pendingDelete|agent-card-row|agent-card-delete|cw-delete-confirm/,
  'agent delete interaction must not use the broken external column or overlay confirmation',
)

assert.match(
  jsx,
  /window\.confirm\(`确认删除智能体/,
  'agent delete confirmation should restore the feat-0622 window.confirm pattern',
)

assert.match(
  jsx,
  /event\.stopPropagation\(\)/,
  'agent delete button must stop propagation so clicking delete does not open details',
)

assert.match(
  jsx,
  /className="agent-card-footer"/,
  'agent delete action should render inside the card footer',
)

console.log('check-agent-panel-layout: OK')

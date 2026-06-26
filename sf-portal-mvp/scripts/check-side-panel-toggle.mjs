import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const appJsx = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8')
const appCss = readFileSync(new URL('../src/App.css', import.meta.url), 'utf8')
const applicationsPanelCss = readFileSync(new URL('../src/components/ApplicationsPanel.css', import.meta.url), 'utf8')
const agentsPanelCss = readFileSync(new URL('../src/components/AgentsPanel.css', import.meta.url), 'utf8')
const workbenchJsx = readFileSync(new URL('../src/components/ConversationWorkbench.jsx', import.meta.url), 'utf8')
const applicationsPanelJsx = readFileSync(new URL('../src/components/ApplicationsPanel.jsx', import.meta.url), 'utf8')
const agentsPanelJsx = readFileSync(new URL('../src/components/AgentsPanel.jsx', import.meta.url), 'utf8')

assert.match(appJsx, /leftPanelHidden/, 'App must keep left panel visibility state')
assert.match(appJsx, /rightPanelHidden/, 'App must keep right panel visibility state')
assert.match(appJsx, /left-hidden/, 'workbench must expose a left-hidden layout class')
assert.match(appJsx, /right-hidden/, 'workbench must expose a right-hidden layout class')
assert.match(appJsx, /!\s*leftPanelHidden[\s\S]*<ApplicationsPanel/, 'left agent panel must not render while hidden')
assert.match(appJsx, /!\s*rightPanelHidden[\s\S]*<AgentsPanel/, 'right agent panel must not render while hidden')
assert.match(appJsx, /setLeftPanelHidden\(false\)/, 'hidden left panel must have an icon restore action')
assert.match(appJsx, /setRightPanelHidden\(false\)/, 'hidden right panel must have an icon restore action')
assert.match(appJsx, /side-rail-toggle side-rail-toggle-left/, 'left restore must use an edge rail affordance')
assert.match(appJsx, /side-rail-toggle side-rail-toggle-right/, 'right restore must use an edge rail affordance')

assert.doesNotMatch(workbenchJsx, /onToggleSidePanels/, 'ConversationWorkbench must not own side-panel toggles')
assert.doesNotMatch(workbenchJsx, /隐藏两侧|显示两侧|cw-side-toggle/, 'center workbench must not render the old text toggle button')

assert.match(applicationsPanelJsx, /onHidePanel/, 'left panel must expose a hide icon action')
assert.match(applicationsPanelJsx, /隐藏左侧智能体/, 'left panel hide action must be accessible')
assert.match(applicationsPanelJsx, /panel-header-main/, 'left panel header must have a structured main area')
assert.match(applicationsPanelJsx, /panel-actions/, 'left panel header actions must be grouped')

assert.match(agentsPanelJsx, /onHidePanel/, 'right panel must expose a hide icon action')
assert.match(agentsPanelJsx, /隐藏右侧智能体/, 'right panel hide action must be accessible')
assert.match(agentsPanelJsx, /agents-header-main/, 'right panel header must have a structured main area')
assert.match(agentsPanelJsx, /panel-actions/, 'right panel header actions must be grouped')

assert.match(appCss, /\.workbench\.left-hidden\.right-hidden\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\)/, 'hidden layout must make the center column fill the workbench')
assert.match(appCss, /\.workbench\.left-hidden:not\(\.right-hidden\)\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+300px/, 'left-hidden layout must keep the right panel visible')
assert.match(appCss, /\.workbench\.right-hidden:not\(\.left-hidden\)\s*\{[\s\S]*grid-template-columns:\s*300px\s+minmax\(0,\s*1fr\)/, 'right-hidden layout must keep the left panel visible')
assert.match(appCss, /\.side-rail-toggle/, 'hidden side panels must have edge rail restore affordances')
assert.match(applicationsPanelCss, /\.panel-header-main/, 'left panel header must use a structured title/action layout')
assert.match(applicationsPanelCss, /\.panel-action-btn/, 'left panel icon actions must use consistent styling')
assert.match(agentsPanelCss, /\.agents-header-main/, 'right panel header must use a structured title/action layout')
assert.match(agentsPanelCss, /\.panel-action-btn/, 'right panel icon actions must use consistent styling')
assert.doesNotMatch(appCss, /\.side-restore\s*\{[\s\S]*position:\s*absolute[\s\S]*width:\s*28px[\s\S]*height:\s*28px/, 'restore affordance must not be the old floating square')

console.log('side panel toggle check passed')

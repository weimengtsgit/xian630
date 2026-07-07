import { readFileSync } from 'node:fs'

const css = readFileSync(new URL('./app-store-overrides.css', import.meta.url), 'utf8')

function block(selector) {
  const match = css.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`))
  if (!match) throw new Error(`Missing selector: ${selector}`)
  return match[1].replace(/\s+/g, ' ').replace(/\s*:\s*/g, ':').trim()
}

function value(selector, property) {
  const body = block(selector)
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = body.match(new RegExp(`${escaped}:([^;]+)`))
  if (!match) throw new Error(`${selector} missing ${property}`)
  return match[1].trim()
}

const compactPageScale = css.replace(/\s+/g, '')

for (const required of [
  '--app-page-scale:0.67',
  'zoom:var(--app-page-scale)',
  'width:calc(100%/var(--app-page-scale))',
  'min-height:calc(100vh/var(--app-page-scale))',
  'max-width:calc(1600px/var(--app-page-scale))',
]) {
  if (!compactPageScale.includes(required)) {
    throw new Error(`100% view should preserve the 67% visual layout: missing ${required}`)
  }
}

const cardMinHeight = Number.parseFloat(value('.app-card', 'min-height'))
if (cardMinHeight < 188) {
  throw new Error(`.app-card min-height should reserve footer room, got ${cardMinHeight}px`)
}

if (value('.app-card', 'overflow') !== 'visible') {
  throw new Error('.app-card overflow should be visible so footer text is not clipped')
}

const footer = block('.app-card__footer')
for (const required of ['display:flex', 'align-items:flex-end', 'margin-top:auto', 'min-height:40px']) {
  if (!footer.includes(required)) {
    throw new Error(`.app-card__footer missing ${required}`)
  }
}

const meta = block('.app-card__meta')
for (const required of ['min-width:128px', 'line-height:1.35']) {
  if (!meta.includes(required)) {
    throw new Error(`.app-card__meta missing ${required}`)
  }
}

if (!block('.app-card__vendor').includes('white-space:normal')) {
  throw new Error('.app-card__vendor should allow wrapping instead of clipping')
}

console.log('card layout checks passed')

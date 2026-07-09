import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDefaultPrototype } from '../public/app.js';

const projectRoot = resolve(import.meta.dirname, '..');

describe('public workbench C2 styling', () => {
  it('renders the workbench shell with C2 classification and status surfaces', () => {
    const html = readFileSync(resolve(projectRoot, 'public/index.html'), 'utf8');

    expect(html).toContain('c2-clsf-banner');
    expect(html).toContain('UNCLASSIFIED // PROTOTYPE WORKBENCH');
    expect(html).toContain('status-pill');
    expect(html).toContain('preview-toolbar');
  });

  it('uses C2 design tokens in the default iframe prototype', () => {
    const html = createDefaultPrototype();

    expect(html).toContain('--bg-base: #0a0e14');
    expect(html).toContain('--accent-cyan: #38b6e6');
    expect(html).toContain('UNCLASSIFIED // NOTIONAL PROTOTYPE');
    expect(html).toContain('c2-panel');
  });
});

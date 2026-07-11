import { describe, expect, it } from 'vitest';
import { buildArtifactPath, buildArtifactBaseDir } from '../src/lib/generations/artifactPath.js';
import { InvalidProjectKeyError } from '../src/lib/validation.js';

describe('F1: buildArtifactPath project-key validation', () => {
  it('builds a valid path for a compliant key', () => {
    const p = buildArtifactPath('共享/prototype.html', 'demo', 'sess-1', 'v-1');
    expect(p).toBe('共享/demo/interface-sessions/sess-1/versions/v-1/prototype.html');
  });

  it('builds without a base dir', () => {
    const p = buildArtifactPath('prototype.html', 'demo', 'sess-1', 'v-1');
    expect(p).toBe('demo/interface-sessions/sess-1/versions/v-1/prototype.html');
  });

  it.each([
    '../../etc',   // path traversal
    'a/b',         // slash
    'a\\b',        // backslash
    'a b',         // space
    'a.b',         // dot
    'A-B',         // uppercase
    'x'.repeat(33), // too long
    '',            // empty
    '-leading',    // leading hyphen
    'a_b',         // underscore
  ])('throws InvalidProjectKeyError for bad key %j', (key) => {
    expect(() => buildArtifactPath('共享/prototype.html', key, 's', 'v'))
      .toThrow(InvalidProjectKeyError);
  });

  it('buildArtifactBaseDir extracts the dir portion', () => {
    expect(buildArtifactBaseDir('共享/prototype.html')).toBe('共享');
    expect(buildArtifactBaseDir('prototype.html')).toBe('');
  });
});

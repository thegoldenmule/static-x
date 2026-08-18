import { describe, expect, it } from 'vitest';
import { __testing } from './client.js';

const { deepMerge } = __testing;

describe('deepMerge (the handshake capability blob)', () => {
  it('returns the base untouched when a pack declares nothing', () => {
    const base = { textDocument: { hover: {} } };
    expect(deepMerge(base, undefined)).toEqual(base);
  });

  it('adds a pack’s capability without dropping the base ones', () => {
    const merged = deepMerge(
      { textDocument: { hover: {}, definition: {} }, workspace: { workspaceEdit: {} } },
      { textDocument: { semanticTokens: { requests: { full: true } } } },
    );
    expect(merged).toEqual({
      textDocument: {
        hover: {},
        definition: {},
        semanticTokens: { requests: { full: true } },
      },
      workspace: { workspaceEdit: {} },
    });
  });

  // A pack that re-declares a list means to replace it. Appending to
  // whatever core happened to declare would produce a blob neither side
  // asked for.
  it('replaces arrays and scalars rather than combining them', () => {
    const merged = deepMerge(
      { textDocument: { hover: { contentFormat: ['markdown', 'plaintext'] } }, x: 1 },
      { textDocument: { hover: { contentFormat: ['plaintext'] } }, x: 2 },
    );
    expect(merged).toEqual({ textDocument: { hover: { contentFormat: ['plaintext'] } }, x: 2 });
  });

  it('does not mutate the base', () => {
    const base = { textDocument: { hover: {} } };
    deepMerge(base, { textDocument: { semanticTokens: {} } });
    expect(base).toEqual({ textDocument: { hover: {} } });
  });
});

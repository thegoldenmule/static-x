import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Hover, Location, LocationLink } from 'vscode-languageserver-protocol';
import { TsProjectSession } from './session.js';

const FIXTURE = path.resolve(import.meta.dirname, '../../fixtures/basic-ts');
const INDEX_TS = path.join(FIXTURE, 'src/index.ts');

/** Find the zero-based line/character of `needle` in a file. */
async function positionOf(filePath: string, needle: string) {
  const lines = (await readFile(filePath, 'utf8')).split('\n');
  for (const [line, text] of lines.entries()) {
    const character = text.indexOf(needle);
    if (character !== -1) return { line, character };
  }
  throw new Error(`"${needle}" not found in ${filePath}`);
}

describe('TsProjectSession', () => {
  const session = TsProjectSession.open(FIXTURE);
  afterAll(() => session.dispose());

  it('discovers the tsconfig', () => {
    expect(session.configPath).toBe(path.join(FIXTURE, 'tsconfig.json'));
  });

  it('answers hover through the LSP view', { timeout: 30_000 }, async () => {
    const lsp = await session.lsp();
    const uri = await session.openDocument(INDEX_TS);
    const position = await positionOf(INDEX_TS, "greet('world'");
    const hover = await lsp.request<Hover | null>('textDocument/hover', {
      textDocument: { uri },
      position,
    });
    // The full resolved signature, not the pre-project-load alias stub.
    expect(JSON.stringify(hover?.contents)).toContain(
      'greet(userName: string, excited: boolean): string',
    );
  });

  it('resolves cross-file definition through the LSP view', { timeout: 30_000 }, async () => {
    const lsp = await session.lsp();
    const uri = await session.openDocument(INDEX_TS);
    const position = await positionOf(INDEX_TS, "greet('world'");
    const definition = await lsp.request<Location | Location[] | LocationLink[] | null>(
      'textDocument/definition',
      { textDocument: { uri }, position },
    );
    const first = Array.isArray(definition) ? definition[0] : definition;
    expect(first).toBeDefined();
    const targetUri = first && 'uri' in first ? first.uri : first?.targetUri;
    expect(targetUri).toMatch(/greeter\.ts$/);
  });

  it('resolves symbols through the compiler view', () => {
    const files = session.sourceFiles().map((sf) => path.basename(sf.fileName));
    expect(files.sort()).toEqual(['greeter.ts', 'index.ts', 'math.ts', 'notes.ts']);

    const greeter = session
      .program()
      .getSourceFile(path.join(FIXTURE, 'src/greeter.ts'));
    const moduleSymbol = session.checker().getSymbolAtLocation(greeter!);
    const exports = session.checker().getExportsOfModule(moduleSymbol!);
    expect(exports.map((s) => s.name).sort()).toEqual(['greet', 'greetAll']);
  });

  it('rejects roots with no tsconfig', () => {
    expect(() => TsProjectSession.open(path.resolve('/'))).toThrow(/No tsconfig/);
  });
});

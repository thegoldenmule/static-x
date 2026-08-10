import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { TsProjectSession } from './session.js';

const FIXTURE = path.resolve(import.meta.dirname, '../../fixtures/basic-ts');

describe('TsProjectSession.sourceFiles', () => {
  const session = TsProjectSession.open(FIXTURE);
  afterAll(() => session.dispose());

  it('excludes files under hidden directories (generated framework output)', () => {
    const files = session.sourceFiles().map((sf) => path.basename(sf.fileName));
    expect(files).toContain('greeter.ts');
    expect(files).not.toContain('generated.ts');
  });

  it('keeps hidden-directory files in projectFiles, for graph edges', () => {
    const files = session.projectFiles().map((sf) => path.basename(sf.fileName));
    expect(files).toContain('greeter.ts');
    expect(files).toContain('generated.ts');
  });
});

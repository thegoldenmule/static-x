import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { TsProjectSession } from '../project/index.js';
import { resolveTarget } from '../ast/targets.js';
import { applicableActions, formatSettings, userPreferences } from './refactor-action.js';

const FIXTURE = path.resolve(import.meta.dirname, '../../fixtures/refactor-core-ts');

const session = TsProjectSession.open(FIXTURE);
afterAll(() => session.dispose());

describe('formatSettings', () => {
  it('keeps every default TypeScript sets', { timeout: 30_000 }, () => {
    const settings = formatSettings(session);

    // Built from scratch, this object read false for every key it did
    // not list, and the engine took that literally: generated code came
    // out as `value*SCALE`. Nothing in the tool tests noticed, because
    // they assert on which symbols moved, not on how the result reads.
    expect(settings.insertSpaceBeforeAndAfterBinaryOperators).toBe(true);
    expect(settings.insertSpaceAfterSemicolonInForStatements).toBe(true);
    expect(settings.trimTrailingWhitespace).toBe(true);
  });

  it('infers the indentation the project actually writes', () => {
    const settings = formatSettings(session);

    expect(settings.convertTabsToSpaces).toBe(true);
    expect(settings.indentSize).toBe(2);
  });
});

describe('userPreferences', () => {
  it('infers the import style the project actually writes', () => {
    const preferences = userPreferences(session);

    expect(preferences.quotePreference).toBe('single');
    // The fixture imports './counter.js', so generated imports must
    // carry the extension too — under NodeNext that is a compile error,
    // not a style difference.
    expect(preferences.importModuleSpecifierEnding).toBe('js');
  });
});

describe('applicableActions', () => {
  it('reaches refactors TypeScript gates behind an invoked trigger', () => {
    const target = resolveTarget(session, { symbol: 'scale' });
    const actions = applicableActions(session, target.file, target.offset);

    // Convert export is applicable at no position in any file unless
    // triggerReason is 'invoked' — which a tool call always is.
    expect(actions.map((action) => action.kind)).toContain('refactor.rewrite.export.default');
  });

  it('omits actions carrying a reason they cannot run', () => {
    const target = resolveTarget(session, { symbol: 'scale' });
    const actions = applicableActions(session, target.file, target.offset);

    // "Convert namespace import to named imports" is listed by the
    // engine with a notApplicableReason here; it must not come back.
    expect(actions.map((action) => action.kind)).not.toContain('refactor.rewrite.import.named');
  });
});

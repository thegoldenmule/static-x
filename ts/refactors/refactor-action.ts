import ts from 'typescript';
import type { WorkspaceEdit } from '../../core/tool/index.js';
import type { TsProjectSession } from '../project/index.js';
import { toWorkspaceEdit } from './text-changes.js';

/**
 * The safe wrapper around TypeScript's own refactoring engine.
 *
 * Three things make calling it directly a trap. `getEditsForRefactor`
 * does not return undefined for a target it cannot handle — it throws,
 * with an internal Debug Failure or a TypeError from deep inside the
 * transform. An action can be listed and still be unavailable, carrying
 * a `notApplicableReason` instead of a refusal. And the descriptions
 * are prose for a menu, while the action names are stable identifiers.
 *
 * So: ask what applies, require the named action with no reason not to
 * run it, and surface TypeScript's own reason when there is one — those
 * strings ("Selection is not an import declaration.", "Cannot extract
 * range.") are better refusal messages than anything written here.
 */

export interface RefactorRequest {
  file: string;
  /** Offset, or a span for range-addressed refactors. */
  at: number | ts.TextRange;
  /** The refactor's stable name, e.g. "Move to file". */
  refactor: string;
  /** The action's stable name, e.g. "Move to file", "function_scope_1". */
  action: string;
  /** Extra arguments interactive refactors require (a target file). */
  interactive?: ts.InteractiveRefactorArguments;
}

/** Indentation the project actually uses, so generated code matches it. */
function inferFormatSettings(session: TsProjectSession): ts.FormatCodeSettings {
  let spaces = 0;
  let tabs = 0;
  const widths = new Map<number, number>();
  for (const sourceFile of session.sourceFiles().slice(0, 25)) {
    for (const line of sourceFile.getFullText().split('\n')) {
      const indent = /^[ \t]+/.exec(line)?.[0];
      if (!indent) continue;
      if (indent.startsWith('\t')) tabs++;
      else {
        spaces++;
        widths.set(indent.length, (widths.get(indent.length) ?? 0) + 1);
      }
    }
  }
  const convertTabsToSpaces = tabs <= spaces;
  // The commonest indent that divides evenly is the unit; 2 is the
  // TypeScript-ecosystem default and what this repo uses.
  let indentSize = 2;
  let best = 0;
  for (const candidate of [2, 4, 8]) {
    let votes = 0;
    for (const [width, count] of widths) {
      if (width % candidate === 0) votes += count;
    }
    if (votes > best) {
      best = votes;
      indentSize = candidate;
    }
  }
  // Spread TypeScript's defaults rather than listing settings: every
  // key left out of a from-scratch object reads as false, and the
  // engine takes that literally. Omitting
  // insertSpaceBeforeAndAfterBinaryOperators alone emits `a*b`.
  return {
    ...ts.getDefaultFormatCodeSettings('\n'),
    indentSize: convertTabsToSpaces ? indentSize : 4,
    tabSize: convertTabsToSpaces ? indentSize : 4,
    convertTabsToSpaces,
    newLineCharacter: '\n',
    semicolons: ts.SemicolonPreference.Insert,
  };
}

const settingsCache = new WeakMap<TsProjectSession, ts.FormatCodeSettings>();

export function formatSettings(session: TsProjectSession): ts.FormatCodeSettings {
  let settings = settingsCache.get(session);
  if (!settings) {
    settings = inferFormatSettings(session);
    settingsCache.set(session, settings);
  }
  return settings;
}

/**
 * Import style the project already writes. Generated imports that
 * disagree with their neighbours are the most visible way a refactoring
 * announces that a machine wrote the code — and under NodeNext, a
 * missing `.js` is not a style difference but a compile error.
 */
function inferImportStyle(session: TsProjectSession): {
  quotePreference: 'single' | 'double';
  importModuleSpecifierEnding: 'js' | 'minimal' | 'index';
} {
  let single = 0;
  let double = 0;
  let extensioned = 0;
  let bare = 0;

  for (const sourceFile of session.sourceFiles().slice(0, 40)) {
    for (const statement of sourceFile.statements) {
      const specifier = ts.isImportDeclaration(statement)
        ? statement.moduleSpecifier
        : ts.isExportDeclaration(statement)
          ? statement.moduleSpecifier
          : undefined;
      if (!specifier || !ts.isStringLiteral(specifier)) continue;
      if (specifier.getText(sourceFile).startsWith("'")) single++;
      else double++;
      if (!specifier.text.startsWith('.')) continue;
      if (/\.[cm]?js$/.test(specifier.text)) extensioned++;
      else bare++;
    }
  }
  return {
    quotePreference: double > single ? 'double' : 'single',
    importModuleSpecifierEnding: extensioned > bare ? 'js' : 'minimal',
  };
}

const preferenceCache = new WeakMap<TsProjectSession, ts.UserPreferences>();

export function userPreferences(session: TsProjectSession): ts.UserPreferences {
  let preferences = preferenceCache.get(session);
  if (!preferences) {
    preferences = {
      // Without this, refactors that write into a file they also create
      // return nothing at all rather than refusing.
      allowTextChangesInNewFiles: true,
      provideRefactorNotApplicableReason: true,
      includeCompletionsForModuleExports: true,
      ...inferImportStyle(session),
    };
    preferenceCache.set(session, preferences);
  }
  return preferences;
}

export interface ApplicableAction {
  refactor: string;
  action: string;
  description: string;
  kind: string | undefined;
}

/** Every action available at a target, excluding the inapplicable. */
export function applicableActions(
  session: TsProjectSession,
  file: string,
  at: number | ts.TextRange,
  kindPrefix?: string,
): ApplicableAction[] {
  const available: ApplicableAction[] = [];
  // triggerReason 'invoked' means "the user asked", which is exactly
  // what a tool call is. TypeScript gates whole refactor families on
  // it — Convert export, Convert import and Inline variable are
  // applicable at no position without it.
  //
  // includeInteractiveActions: refactors that need an argument the
  // caller supplies (Move to file's destination) are otherwise not
  // listed at all, and would look unavailable rather than unasked.
  const infos = session
    .languageService()
    .service.getApplicableRefactors(
      file,
      at,
      userPreferences(session),
      'invoked',
      kindPrefix,
      true,
    );
  for (const info of infos) {
    for (const action of info.actions) {
      if (action.notApplicableReason) continue;
      available.push({
        refactor: info.name,
        action: action.name,
        description: action.description,
        kind: action.kind,
      });
    }
  }
  return available;
}

/**
 * Why an action is unavailable, in TypeScript's own words — or
 * undefined when TypeScript believes it should have worked, which
 * means the failure is a bug in the engine rather than a bad target
 * and the caller needs to see the real error.
 */
function notApplicableReason(
  session: TsProjectSession,
  request: RefactorRequest,
): string | undefined {
  const infos = session
    .languageService()
    .service.getApplicableRefactors(
      request.file,
      request.at,
      userPreferences(session),
      'invoked',
      undefined,
      true,
    );
  for (const info of infos) {
    if (info.name !== request.refactor) continue;
    for (const action of info.actions) {
      if (action.name === request.action) return action.notApplicableReason ?? undefined;
    }
  }
  return `TypeScript offers no "${request.refactor}" refactoring at this position`;
}

export interface RefactorResult {
  edit: WorkspaceEdit;
  /** Where the language service wants a name typed, if anywhere. */
  renameLocation?: { file: string; offset: number };
}

/**
 * Run a refactoring, or throw with TypeScript's reason for refusing.
 *
 * Applicability is checked first, and that order matters rather than
 * being tidiness: the two entry points disagree about the target. The
 * edit path always adjusts the span it is given, while the
 * applicability path adjusts only when asked — so for a range that
 * does not land on node boundaries, TypeScript can refuse the target
 * and still produce a confident edit for a neighbouring one. Asking
 * "may I?" before "do it" is what keeps a slightly-wrong range from
 * silently refactoring the wrong code.
 */
export function runRefactor(
  session: TsProjectSession,
  request: RefactorRequest,
): RefactorResult {
  const result = tryRefactor(session, request);
  if (!result) {
    throw new Error(
      notApplicableReason(session, request) ?? `"${request.action}" produced no edits here`,
    );
  }
  return result;
}

/**
 * As runRefactor, but reports "applicable, yet produced nothing" as
 * `undefined` rather than an error. Some refactorings decline silently
 * for reasons that are not about the code being unsuitable — a caller
 * that can do the work itself needs to tell that apart from a genuine
 * refusal.
 */
export function tryRefactor(
  session: TsProjectSession,
  request: RefactorRequest,
): RefactorResult | undefined {
  const service = session.languageService().service;
  const refusal = notApplicableReason(session, request);
  if (refusal !== undefined) throw new Error(refusal);

  let edits: ts.RefactorEditInfo | undefined;
  try {
    edits = service.getEditsForRefactor(
      request.file,
      formatSettings(session),
      request.at,
      request.refactor,
      request.action,
      userPreferences(session),
      request.interactive,
    );
  } catch (error) {
    // The engine throws rather than refusing for targets it cannot
    // handle; its own applicability check gives the readable reason.
    // When it has none, the throw is the engine failing on a target it
    // accepted, and hiding it behind a tidy message would be a lie.
    const reason = notApplicableReason(session, request);
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      reason ?? `TypeScript could not apply "${request.action}" here: ${detail}`,
      { cause: error },
    );
  }

  if (!edits || edits.edits.length === 0) return undefined;

  const result: RefactorResult = { edit: toWorkspaceEdit(session, edits.edits) };
  if (edits.renameFilename !== undefined && edits.renameLocation !== undefined) {
    result.renameLocation = { file: edits.renameFilename, offset: edits.renameLocation };
  }
  return result;
}

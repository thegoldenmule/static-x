import path from 'node:path';
import ts from 'typescript';
import { applyWorkspaceEdit } from '../../../core/edits/index.js';
import type { Tool, WorkspaceEdit } from '../../../core/tool/index.js';
import type { TsProjectSession } from '../../project/index.js';
import { diagnosticsIntroducedBy } from '../guard.js';
import { filesTouched, refactorOutputSchema, type RefactorOutput } from '../output.js';
import { applicableActions, runRefactor } from '../refactor-action.js';
import { withName } from '../naming.js';
import { locateSelection, SELECTION_PROPERTIES } from '../selection.js';

/**
 * Lifts a selection into a new function, constant, method, or field —
 * ReSharper's Extract Method, Introduce Variable and Introduce Field,
 * which TypeScript offers as *scopes* on one operation rather than as
 * separate refactorings.
 *
 * The target is addressed by the code itself rather than by offsets;
 * see selection.ts for why an approximate range is dangerous here.
 *
 * Scope is never guessed. Called without one, the tool reports the
 * scopes TypeScript offers for this selection and edits nothing —
 * "extract to a method on Cart" and "extract to a constant in the
 * enclosing scope" are different refactorings with the same input, and
 * choosing between them belongs to the caller.
 */

export interface ExtractInput {
  file: string;
  select: string;
  within?: string;
  /** Which scope to extract into, from the reported `scopes`. */
  scope?: string;
  /** Name for the extracted symbol. Default: TypeScript's placeholder. */
  name?: string;
  apply?: boolean;
}

export interface ExtractScope {
  /** Stable identifier to pass back as `scope`. */
  scope: string;
  /** TypeScript's own description, e.g. "Extract to method in class 'Cart'". */
  description: string;
  kind: string | undefined;
}

export interface ExtractOutput extends RefactorOutput {
  /** The scopes available for this selection. */
  scopes: ExtractScope[];
  /** The name the extracted symbol was given. */
  name: string | undefined;
  /** What the selection resolved to, for confirming the right code moved. */
  selected: { text: string; line: number; kind: string } | undefined;
}

const IDENTIFIER = /^[$_\p{ID_Start}][$‌‍\p{ID_Continue}]*$/u;

function empty(): WorkspaceEdit {
  return { changes: {} };
}

/** The innermost node covering exactly the located range. */
function nodeAt(sourceFile: ts.SourceFile, range: ts.TextRange): ts.Node | undefined {
  let found: ts.Node | undefined;
  const visit = (node: ts.Node): void => {
    if (node.getStart(sourceFile) > range.pos || node.getEnd() < range.end) return;
    if (node.getStart(sourceFile) === range.pos && node.getEnd() === range.end) found = node;
    node.forEachChild(visit);
  };
  sourceFile.forEachChild(visit);
  return found;
}

/**
 * Whether a string literal is a directive prologue — `'use strict'`,
 * `'use client'`, `'use server'`.
 *
 * A directive is a string literal *only* while it is the whole
 * expression of a statement in the leading run of such statements. Bound
 * to a name it is an ordinary string, which is exactly the damage:
 * `const NAME = 'use client'` compiles identically and the file stops
 * being a client component. Nothing downstream of the extraction can
 * see that, because the bundler reads the prologue and the checker does
 * not model it at all.
 */
function isDirective(node: ts.Node): boolean {
  const statement = node.parent as ts.Node | undefined;
  if (!statement || !ts.isExpressionStatement(statement) || statement.expression !== node) {
    return false;
  }
  if (!ts.isStringLiteral(node) && !ts.isNoSubstitutionTemplateLiteral(node)) return false;

  const container = statement.parent as ts.Node | undefined;
  if (!container) return false;
  const statements = ts.isSourceFile(container)
    ? container.statements
    : ts.isBlock(container) || ts.isModuleBlock(container)
      ? container.statements
      : undefined;
  if (!statements) return false;

  // Only the leading run counts. A bare string further down the body is
  // a no-op expression, not a directive, and hoisting it is harmless.
  for (const candidate of statements) {
    if (candidate === statement) return true;
    if (!ts.isExpressionStatement(candidate) || !ts.isStringLiteral(candidate.expression)) {
      return false;
    }
  }
  return false;
}

/**
 * Whether a string literal is a module specifier the compiler resolves.
 *
 * `import('./m.js')` types its result from the literal itself. Replace
 * the literal with a `const` holding the same text and the call still
 * compiles — measured, no diagnostic — while its type collapses from
 * `typeof import("./m")` to `any`, taking every downstream property
 * check with it. Bundlers lose the static reference for the same
 * reason.
 */
function isModuleSpecifier(node: ts.Node): boolean {
  const parent = node.parent as ts.Node | undefined;
  if (!parent) return false;
  if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) {
    return parent.moduleSpecifier === node;
  }
  if (ts.isExternalModuleReference(parent)) return parent.expression === node;
  if (ts.isImportTypeNode(parent)) return true;
  if (!ts.isCallExpression(parent) || parent.arguments[0] !== node) return false;
  return (
    parent.expression.kind === ts.SyntaxKind.ImportKeyword ||
    (ts.isIdentifier(parent.expression) && parent.expression.text === 'require')
  );
}

export const extract: Tool<ExtractInput, ExtractOutput, TsProjectSession> = {
  name: 'ts/refactors/extract',
  description:
    'Lifts a selection into a new function, constant, class method, or readonly field — ' +
    "ReSharper's Extract Method, Introduce Variable and Introduce Field, which TypeScript " +
    'offers as scopes on one operation. The target is the code itself: pass `select` as the ' +
    'exact statement, run of statements, or expression to lift, with whitespace and comments ' +
    'free to differ, and `within` to name the enclosing function when the same code appears ' +
    'twice in the file. A selection that is not a whole statement run or expression is ' +
    'refused rather than widened to the nearest one. Called without `scope`, it reports the ' +
    'scopes available and edits nothing; pass one of them back to perform the extraction, ' +
    'with `name` for the extracted symbol. Parameters, return value, async-ness and captured ' +
    'type parameters are computed from data flow through the selection. Dry-run by default; ' +
    'apply: true writes to disk unless the in-memory typecheck reports newDiagnostics.',
  inputSchema: {
    type: 'object',
    properties: {
      file: { type: 'string', description: 'File the selection lives in' },
      ...SELECTION_PROPERTIES,
      scope: {
        type: 'string',
        description: 'Which scope to extract into, from a previous call\'s `scopes`',
      },
      name: { type: 'string', description: 'Name for the extracted symbol' },
      apply: { type: 'boolean', description: 'Write the edit to disk (default false)' },
    },
    required: ['file', 'select'],
    additionalProperties: false,
  },
  outputSchema: refactorOutputSchema(
    {
      scopes: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            scope: { type: 'string' },
            description: { type: 'string' },
            kind: { type: 'string' },
          },
        },
      },
      name: { type: 'string' },
      selected: { type: 'object' },
    },
    ['scopes'],
  ),

  async run(session, input) {
    if (input.name !== undefined && !IDENTIFIER.test(input.name)) {
      throw new Error(`"${input.name}" is not a valid identifier`);
    }

    const located = locateSelection(session, {
      file: input.file,
      select: input.select,
      ...(input.within === undefined ? {} : { within: input.within }),
    });
    const at = { pos: located.range.pos, end: located.range.end };
    const selected = { text: located.text, line: located.line, kind: located.kind };

    // Two string-literal positions where the literal is not a value but
    // a fact the compiler reads out of the source. Binding either to a
    // name compiles clean and loses that fact, so both are refused
    // before TypeScript is asked — it offers the extraction in both
    // cases and its output is wrong in both.
    const node = nodeAt(located.sourceFile, located.range);
    if (node && isDirective(node)) {
      throw new Error(
        `${located.text} at line ${String(located.line)} is a directive prologue, not a value. ` +
          'Bound to a name it is an ordinary string and the directive stops applying — the ' +
          'compiler models no part of this, so nothing would report it.',
      );
    }
    if (node && isModuleSpecifier(node)) {
      throw new Error(
        `${located.text} at line ${String(located.line)} is a module specifier, which the ` +
          'compiler resolves from the literal itself. Bound to a name the import still ' +
          'compiles and its type collapses to `any`, and a bundler loses the static reference.',
      );
    }

    const scopes: ExtractScope[] = applicableActions(
      session,
      located.file,
      at,
      'refactor.extract',
    ).map((action) => ({
      scope: action.action,
      description: action.description,
      kind: action.kind,
    }));

    if (scopes.length === 0) {
      throw new Error(
        `TypeScript cannot extract that selection (${located.kind} at line ${located.line})`,
      );
    }

    // No scope: this is the question "what can I do here?", and
    // answering it with an edit for a scope the caller did not choose
    // would be answering a different one.
    if (input.scope === undefined) {
      return {
        applied: false,
        edit: empty(),
        filesChanged: [],
        newDiagnostics: [],
        warnings: [],
        scopes,
        name: undefined,
        selected,
      };
    }

    const chosen = scopes.find((scope) => scope.scope === input.scope);
    if (!chosen) {
      throw new Error(
        `"${input.scope}" is not an available scope for that selection. ` +
          `Available: ${scopes.map((scope) => `${scope.scope} (${scope.description})`).join('; ')}`,
      );
    }

    const result = runRefactor(session, {
      file: located.file,
      at,
      refactor: 'Extract Symbol',
      action: chosen.scope,
    });

    let edit = result.edit;
    let name: string | undefined;
    const warnings: string[] = [];
    if (input.name !== undefined && result.renameLocation) {
      try {
        edit = withName(
          session,
          edit,
          path.resolve(result.renameLocation.file),
          result.renameLocation.offset,
          input.name,
        );
        name = input.name;
      } catch (error) {
        warnings.push(error instanceof Error ? error.message : String(error));
      }
    } else if (input.name !== undefined) {
      warnings.push('TypeScript reported no rename location, so the placeholder name stands');
    }

    const filesChanged = filesTouched(edit);
    const newDiagnostics = (await diagnosticsIntroducedBy(session, edit)).map(
      (diagnostic) => diagnostic.text,
    );

    if (input.apply !== true || newDiagnostics.length > 0) {
      return {
        applied: false,
        edit,
        filesChanged,
        newDiagnostics,
        warnings,
        scopes,
        name,
        selected,
      };
    }

    const written = await applyWorkspaceEdit(edit);
    session.invalidate(written);
    return {
      applied: true,
      edit,
      filesChanged,
      newDiagnostics,
      warnings,
      scopes,
      name,
      selected,
    };
  },
};

import path from 'node:path';
import ts from 'typescript';
import { applyWorkspaceEdit } from '../../../core/edits/index.js';
import type { TextEdit, Tool, WorkspaceEdit } from '../../../core/tool/index.js';
import { tokenKey } from '../../ast/structural.js';
import type { TsProjectSession } from '../../project/index.js';
import { diagnosticsIntroducedBy } from '../guard.js';
import { filesTouched, refactorOutputSchema, type RefactorOutput } from '../output.js';
import { withName } from '../naming.js';
import { applicableActions, runRefactor } from '../refactor-action.js';
import { locateSelection, SELECTION_PROPERTIES } from '../selection.js';

/**
 * Lifts an inline type into a named `type` alias or `interface` —
 * ReSharper's Introduce type alias, Convert Anonymous to Named Type,
 * and Introduce typedef, which are one operation here because
 * TypeScript's own `Extract type` offers the forms as actions on the
 * same selection.
 *
 * TypeScript does the extraction, and does it well: captured type
 * parameters propagate, so `{ value: T; tag: string }` inside a generic
 * function becomes `type NewType<T> = …` used as `NewType<T>`.
 *
 * What it does not do is look at the rest of the project. The same
 * shape written in five files stays written in five files, and running
 * the refactoring again on the second one produces a second alias with
 * the same body. `dedupe` is the half worth owning: every other inline
 * type in the project structurally identical to this one is replaced
 * with the new name too. That is a cross-file edit no model can make
 * from the file in front of it, because the precondition is knowing
 * what every other file contains.
 *
 * Identity is `tokenKey` — names and literal values included. `shapeKey`
 * is the wrong primitive here and would be actively harmful: it ignores
 * exactly those, so `{ host: string }` and `{ port: number }` share a
 * key and would collapse onto one alias.
 */

export interface ExtractTypeInput {
  file: string;
  select: string;
  within?: string;
  /** `alias` (default) or `interface`. A function type only allows alias. */
  form?: 'alias' | 'interface';
  /** Name for the extracted type. Default: TypeScript's placeholder. */
  name?: string;
  /**
   * Replace structurally identical inline types elsewhere in the
   * project too. Default false: it edits files beyond the selection.
   */
  dedupe?: boolean;
  apply?: boolean;
}

export interface DuplicateSite {
  file: string;
  line: number;
  character: number;
  text: string;
}

export interface ExtractTypeOutput extends RefactorOutput {
  /** The forms TypeScript offers for this selection. */
  forms: ('alias' | 'interface')[];
  name: string | undefined;
  /** Identical inline types found elsewhere, whether or not replaced. */
  duplicates: DuplicateSite[];
}

const IDENTIFIER = /^[$_\p{ID_Start}][$‌‍\p{ID_Continue}]*$/u;

const ACTION: Record<'alias' | 'interface', string> = {
  alias: 'Extract to type alias',
  interface: 'Extract to interface',
};

/**
 * Every other inline type in the project with the same tokens.
 *
 * Deliberately narrow: only type nodes that are anonymous shapes, since
 * replacing a named reference would be a rename rather than a dedupe.
 * The declaration the extraction itself creates is not in the program
 * yet, so it cannot be matched by accident.
 */
function duplicatesOf(
  session: TsProjectSession,
  key: string,
  exclude: { file: string; range: ts.TextRange },
): { sourceFile: ts.SourceFile; node: ts.TypeNode }[] {
  const found: { sourceFile: ts.SourceFile; node: ts.TypeNode }[] = [];
  for (const sourceFile of session.sourceFiles()) {
    const visit = (node: ts.Node): void => {
      if (
        (ts.isTypeLiteralNode(node) || ts.isFunctionTypeNode(node) || ts.isUnionTypeNode(node)) &&
        tokenKey(node, sourceFile) === key
      ) {
        const sameFile = path.resolve(sourceFile.fileName) === exclude.file;
        const overlaps =
          sameFile &&
          node.getStart(sourceFile) < exclude.range.end &&
          node.getEnd() > exclude.range.pos;
        if (!overlaps) found.push({ sourceFile, node });
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return found;
}

/**
 * Whether `file` can name the extracted type. The extraction puts the
 * declaration in the selection's own file without exporting it, so a
 * duplicate in another file has nothing to refer to — replacing it
 * would be a compile error the guard would catch, but refusing to
 * replace it and saying so is the better answer.
 */
function canReference(file: string, declaredIn: string): boolean {
  return path.resolve(file) === path.resolve(declaredIn);
}

export const extractType: Tool<ExtractTypeInput, ExtractTypeOutput, TsProjectSession> = {
  name: 'ts/refactors/extract-type',
  description:
    'Lifts an inline type — an object type literal, a union, a function type — into a named ' +
    "type alias or interface. This is ReSharper's Introduce type alias and Convert Anonymous " +
    'to Named Type. The target is the code itself: pass `select` as the exact type to lift, ' +
    'with whitespace and comments free to differ, and `within` to name the enclosing function ' +
    'when the same type appears twice in the file. Captured type parameters propagate, so a ' +
    'shape mentioning T becomes a generic alias. `form` chooses alias (default) or interface; ' +
    'a function type only allows alias, and the forms available come back in `forms`. With ' +
    'dedupe: true, structurally identical inline types elsewhere in the same file are replaced ' +
    'with the new name as well — they are reported in `duplicates` either way, including ones ' +
    'in other files that cannot be replaced because the declaration is not exported. Dry-run ' +
    'by default; apply: true writes to disk unless the typecheck reports newDiagnostics.',
  inputSchema: {
    type: 'object',
    properties: {
      file: { type: 'string', description: 'File the selection lives in' },
      ...SELECTION_PROPERTIES,
      form: {
        type: 'string',
        enum: ['alias', 'interface'],
        description: 'Extract to a type alias (default) or an interface',
      },
      name: { type: 'string', description: 'Name for the extracted type' },
      dedupe: {
        type: 'boolean',
        description: 'Also replace structurally identical inline types (default false)',
      },
      apply: { type: 'boolean', description: 'Write the edit to disk (default false)' },
    },
    required: ['file', 'select'],
    additionalProperties: false,
  },
  outputSchema: refactorOutputSchema(
    {
      forms: { type: 'array', items: { type: 'string', enum: ['alias', 'interface'] } },
      name: { type: 'string' },
      duplicates: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            file: { type: 'string' },
            line: { type: 'integer' },
            character: { type: 'integer' },
            text: { type: 'string' },
          },
        },
      },
    },
    ['forms', 'duplicates'],
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
    if (located.kind !== 'type') {
      throw new Error(
        `That selection is a ${located.kind}, not a type. ` +
          'Use ts/refactors/extract to lift statements or an expression.',
      );
    }
    const at = { pos: located.range.pos, end: located.range.end };

    const actions = applicableActions(session, located.file, at, 'refactor.extract');
    const forms = (['alias', 'interface'] as const).filter((form) =>
      actions.some((action) => action.action === ACTION[form]),
    );
    if (forms.length === 0) {
      throw new Error(
        `TypeScript cannot extract the type at line ${located.line} of ${input.file}`,
      );
    }

    const form = input.form ?? 'alias';
    if (!forms.includes(form)) {
      throw new Error(
        `TypeScript will not extract that type to ${form === 'alias' ? 'a type alias' : 'an interface'}` +
          ` (available: ${forms.join(', ')})`,
      );
    }

    const result = runRefactor(session, {
      file: located.file,
      at,
      refactor: 'Extract type',
      action: ACTION[form],
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
    }

    // Duplicates are reported whether or not they are replaced: knowing
    // the shape is written in six other places is the finding, and the
    // caller may want the alias exported rather than the edit widened.
    // Key the selection from its own node, so it is built exactly the
    // way the candidates it will be compared against are.
    const selectedKey = (() => {
      let match: ts.TypeNode | undefined;
      const visit = (node: ts.Node): void => {
        if (
          ts.isTypeNode(node) &&
          node.getStart(located.sourceFile) === located.range.pos &&
          node.getEnd() === located.range.end
        ) {
          match ??= node;
        }
        ts.forEachChild(node, visit);
      };
      visit(located.sourceFile);
      return match ? tokenKey(match, located.sourceFile) : undefined;
    })();

    const duplicates: DuplicateSite[] = [];
    const replaceable: { sourceFile: ts.SourceFile; node: ts.TypeNode }[] = [];
    if (selectedKey !== undefined) {
      for (const candidate of duplicatesOf(session, selectedKey, {
        file: located.file,
        range: located.range,
      })) {
        const start = candidate.node.getStart(candidate.sourceFile);
        const { line, character } = candidate.sourceFile.getLineAndCharacterOfPosition(start);
        duplicates.push({
          file: path.resolve(candidate.sourceFile.fileName),
          line,
          character,
          text: candidate.node.getText(candidate.sourceFile),
        });
        if (canReference(candidate.sourceFile.fileName, located.file)) replaceable.push(candidate);
      }
    }

    if (input.dedupe === true && name !== undefined) {
      const unreachable = duplicates.length - replaceable.length;
      if (unreachable > 0) {
        warnings.push(
          unreachable === 1
            ? `1 identical type in another file was left alone: the declaration is not exported, ` +
              `so that file cannot name it. Export "${name}" and rerun this there.`
            : `${unreachable} identical types in other files were left alone: the declaration is ` +
              `not exported, so those files cannot name it. Export "${name}" and rerun this there.`,
        );
      }
      const extra: Record<string, TextEdit[]> = {};
      for (const { sourceFile, node } of replaceable) {
        const file = path.resolve(sourceFile.fileName);
        const start = node.getStart(sourceFile);
        extra[file] = [
          ...(extra[file] ?? []),
          {
            range: {
              start: sourceFile.getLineAndCharacterOfPosition(start),
              end: sourceFile.getLineAndCharacterOfPosition(node.getEnd()),
            },
            newText: name,
          },
        ];
      }
      const merged: WorkspaceEdit = { ...edit, changes: { ...edit.changes } };
      for (const [file, edits] of Object.entries(extra)) {
        merged.changes[file] = [...(merged.changes[file] ?? []), ...edits];
      }
      edit = merged;
    } else if (input.dedupe === true && name === undefined) {
      warnings.push('dedupe needs a name: the placeholder would be what other sites referred to');
    }

    const filesChanged = filesTouched(edit);
    const newDiagnostics = (await diagnosticsIntroducedBy(session, edit)).map((d) => d.text);
    const output = { edit, filesChanged, newDiagnostics, warnings, forms, name, duplicates };

    if (input.apply !== true || newDiagnostics.length > 0) {
      return { applied: false, ...output };
    }
    const written = await applyWorkspaceEdit(edit);
    session.invalidate(written);
    return { applied: true, ...output };
  },
};

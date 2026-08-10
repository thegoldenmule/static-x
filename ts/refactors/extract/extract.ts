import path from 'node:path';
import ts from 'typescript';
import { applyWorkspaceEdit } from '../../../core/edits/index.js';
import type { TextEdit, Tool, WorkspaceEdit } from '../../../core/tool/index.js';
import type { TsProjectSession } from '../../project/index.js';
import { diagnosticsIntroducedBy } from '../guard.js';
import { filesTouched, refactorOutputSchema, type RefactorOutput } from '../output.js';
import { applicableActions, runRefactor } from '../refactor-action.js';
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

/** Offset of a position in `text`, for edits expressed in line/character. */
function offsetsOf(text: string): (line: number, character: number) => number {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') starts.push(i + 1);
  }
  return (line, character) => Math.min((starts[line] ?? text.length) + character, text.length);
}

interface PlacedEdit {
  edit: TextEdit;
  /** Where this edit's newText landed in the post-edit text. */
  start: number;
  end: number;
}

/**
 * Apply edits left to right, recording where each inserted chunk ends
 * up. The placement is what lets a rename computed against the post-edit
 * text be folded back into the edits themselves, instead of being
 * emitted as an opaque whole-file replacement.
 */
function place(text: string, edits: readonly TextEdit[]): { text: string; placed: PlacedEdit[] } {
  const at = offsetsOf(text);
  const ordered = [...edits].sort(
    (a, b) =>
      at(a.range.start.line, a.range.start.character) -
      at(b.range.start.line, b.range.start.character),
  );

  let result = '';
  let read = 0;
  const placed: PlacedEdit[] = [];
  for (const edit of ordered) {
    const start = at(edit.range.start.line, edit.range.start.character);
    const end = at(edit.range.end.line, edit.range.end.character);
    result += text.slice(read, start);
    placed.push({ edit, start: result.length, end: result.length + edit.newText.length });
    result += edit.newText;
    read = end;
  }
  result += text.slice(read);
  return { text: result, placed };
}

/**
 * Give the extracted symbol the caller's name.
 *
 * TypeScript names it `newFunction` and hands back the offset where a
 * user would start typing. Renaming through the language service rather
 * than substituting text means the declaration and every reference move
 * together, and it is the compiler deciding what counts as a reference.
 * The placeholder is a fresh identifier, so every rename location falls
 * inside the text this edit inserts; one that did not would mean the
 * rename had reached pre-existing code, which is a refusal rather than
 * something to patch around.
 */
function withName(
  session: TsProjectSession,
  edit: WorkspaceEdit,
  file: string,
  renameOffset: number,
  newName: string,
): WorkspaceEdit {
  const sourceFile = session.program().getSourceFile(file);
  if (!sourceFile) throw new Error(`${file} left the project mid-refactor`);
  const edits = edit.changes[file] ?? [];
  const { text, placed } = place(sourceFile.getFullText(), edits);

  const service = session.languageService();
  const restore = service.overlay(new Map([[file, text]]));
  let locations: readonly ts.RenameLocation[];
  try {
    locations =
      service.service.findRenameLocations(file, renameOffset, false, false, {}) ?? [];
  } finally {
    restore();
  }
  if (locations.length === 0) {
    throw new Error(`Could not rename the extracted symbol to "${newName}"`);
  }

  const rewritten = new Map(placed.map((entry) => [entry, entry.edit.newText]));
  for (const location of locations) {
    if (path.resolve(location.fileName) !== file) {
      throw new Error(`Renaming the extracted symbol reached ${location.fileName}`);
    }
    const { start, length } = location.textSpan;
    const owner = placed.find((entry) => start >= entry.start && start + length <= entry.end);
    if (!owner) {
      throw new Error(
        'Renaming the extracted symbol would change code outside the extraction; ' +
          `leaving it as TypeScript named it`,
      );
    }
    const current = rewritten.get(owner)!;
    const local = start - owner.start;
    rewritten.set(owner, current.slice(0, local) + newName + current.slice(local + length));
  }

  return {
    ...edit,
    changes: {
      ...edit.changes,
      [file]: placed.map((entry) => ({ range: entry.edit.range, newText: rewritten.get(entry)! })),
    },
  };
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

import path from 'node:path';
import ts from 'typescript';
import { applyWorkspaceEdit } from '../../../core/edits/index.js';
import type { TextEdit, Tool, WorkspaceEdit } from '../../../core/tool/index.js';
import { declarationAt, resolveTarget, SYMBOL_TARGET_PROPERTIES } from '../../ast/targets.js';
import type { TsProjectSession } from '../../project/index.js';
import { diagnosticsIntroducedBy } from '../guard.js';
import { relativeSpecifier } from '../imports.js';
import { filesTouched, refactorOutputSchema, type RefactorOutput } from '../output.js';
import {
  applicableActions,
  runRefactor,
  userPreferences,
  type RefactorResult,
} from '../refactor-action.js';
import { mergeWorkspaceEdits } from '../text-changes.js';

export interface MoveSymbolInput {
  /** Target by declaration name, optionally disambiguated by file... */
  symbol?: string;
  /** ...or by position: file plus zero-based line/character. */
  file?: string;
  line?: number;
  character?: number;
  /**
   * Destination: an existing file, or a path to create. Relative paths
   * resolve against the project root. Omitted, TypeScript picks a new
   * file named after the symbol, beside the source.
   */
  toFile?: string;
  /** Write the edit to disk. Default false: return the edit only. */
  apply?: boolean;
}

export interface MoveSymbolOutput extends RefactorOutput {
  /** Absolute paths the edit creates. */
  created: string[];
  /**
   * Existing files this symbol could move into, from TypeScript's own
   * ranking. Populated only when `toFile` was omitted.
   */
  destinationSuggestions: string[];
}

/**
 * The statement the move engine addresses. TypeScript moves whole
 * top-level statements, so a class member or a declaration nested in a
 * function has nothing to move — refusing here is clearer than letting
 * the engine move the enclosing statement instead.
 */
function topLevelStatement(declaration: ts.NamedDeclaration): ts.Statement | undefined {
  const node = ts.isVariableDeclaration(declaration) ? declaration.parent.parent : declaration;
  return node.parent !== undefined && ts.isSourceFile(node.parent)
    ? (node as ts.Statement)
    : undefined;
}

/**
 * Every name the moved statement binds. Usually one, but
 * `export const a = 1, b = 2;` moves as a unit and takes both names
 * with it, and the re-export pass has to redirect all of them.
 */
function boundNames(statement: ts.Statement): Set<string> {
  const names = new Set<string>();
  const addBinding = (binding: ts.BindingName): void => {
    if (ts.isIdentifier(binding)) {
      names.add(binding.text);
      return;
    }
    for (const element of binding.elements) {
      if (!ts.isOmittedExpression(element)) addBinding(element.name);
    }
  };
  if (ts.isVariableStatement(statement)) {
    for (const declaration of statement.declarationList.declarations) addBinding(declaration.name);
  } else if (ts.isDeclarationStatement(statement)) {
    const name = statement.name;
    if (name !== undefined && ts.isIdentifier(name)) names.add(name.text);
  }
  return names;
}



interface ReExportFixes {
  edit: WorkspaceEdit;
  warnings: string[];
}

/** Offsets an edit list covers in `sourceFile`, for overlap tests. */
function spansOf(
  sourceFile: ts.SourceFile,
  edits: readonly TextEdit[],
): { start: number; end: number }[] {
  return edits.map((edit) => ({
    start: sourceFile.getPositionOfLineAndCharacter(
      edit.range.start.line,
      edit.range.start.character,
    ),
    end: sourceFile.getPositionOfLineAndCharacter(edit.range.end.line, edit.range.end.character),
  }));
}

/**
 * Redirect barrels.
 *
 * The engine rewrites module specifiers by asking "which importers
 * name a symbol that moved" — but a re-export (`export { X } from
 * './old.js'`) is not an import of X into anything, and no file moved,
 * so it updates nothing and the barrel is left pointing at a module
 * that no longer declares the symbol. That is a broken build, not a
 * style nit: the guard reports it as TS2459/TS2305 and refuses the
 * whole move, which makes every symbol in a barrelled project
 * unmovable unless the specifier is fixed here.
 *
 * `export * from './old.js'` names nothing to redirect and silently
 * drops the symbol from that module's surface, so it is reported as a
 * warning instead.
 *
 * The engine's edits win where they overlap, but that has to be judged
 * per statement rather than per file. A module commonly both imports
 * the symbol and re-exports it; the engine rewrites the import and
 * leaves the re-export, so skipping the whole file because the engine
 * touched some of it leaves exactly the broken re-export this pass
 * exists to repair.
 */
function fixReExports(
  session: TsProjectSession,
  options: {
    names: ReadonlySet<string>;
    source: string;
    destination: string;
    /** The engine's own edits; where they overlap a statement, they win. */
    engineEdits: Readonly<Record<string, TextEdit[]>>;
  },
): ReExportFixes {
  const { names, source, destination, engineEdits } = options;
  const compilerOptions = session.program().getCompilerOptions();
  const changes: Record<string, TextEdit[]> = {};
  const warnings: string[] = [];

  // compilationFiles(), not sourceFiles(): the guard typechecks the
  // whole program, and the engine already rewrites importers outside
  // the project root, so stopping the repair at the root would leave
  // the tool rewriting one statement in a file and refusing to rewrite
  // another two lines below it.
  for (const sourceFile of session.compilationFiles()) {
    const file = path.resolve(sourceFile.fileName);
    if (file === source || file === destination) continue;
    const edits: TextEdit[] = [];
    const alreadyEdited = spansOf(sourceFile, engineEdits[file] ?? []);

    for (const statement of sourceFile.statements) {
      if (!ts.isExportDeclaration(statement)) continue;
      if (
        alreadyEdited.some(
          (span) =>
            span.start < statement.getEnd() && span.end > statement.getStart(sourceFile),
        )
      ) {
        continue;
      }
      const specifier = statement.moduleSpecifier;
      if (specifier === undefined || !ts.isStringLiteral(specifier)) continue;
      const resolved = ts.resolveModuleName(
        specifier.text,
        sourceFile.fileName,
        compilerOptions,
        ts.sys,
      ).resolvedModule;
      if (!resolved || path.resolve(resolved.resolvedFileName) !== source) continue;

      const clause = statement.exportClause;
      if (clause === undefined || ts.isNamespaceExport(clause)) {
        warnings.push(
          `${file} re-exports "${specifier.text}" with export *, which no longer carries ` +
            `${[...names].map((name) => `"${name}"`).join(', ')}; add an explicit re-export if that module's callers depend on it`,
        );
        continue;
      }

      const moved = clause.elements.filter((element) =>
        names.has((element.propertyName ?? element.name).text),
      );
      if (moved.length === 0) continue;

      // Match the specifier style already written on this line rather
      // than the project-wide inference: a barrel that omits the
      // extension is in a project where that resolves.
      const quote = sourceFile.text.charAt(specifier.getStart(sourceFile));
      const newSpecifier = relativeSpecifier(
        file,
        destination,
        /\.[cm]?js$/.test(specifier.text),
      );
      const kept = clause.elements.filter((element) => !moved.includes(element));
      const at = (offset: number) => sourceFile.getLineAndCharacterOfPosition(offset);

      if (kept.length === 0) {
        edits.push({
          range: { start: at(specifier.getStart(sourceFile)), end: at(specifier.getEnd()) },
          newText: `${quote}${newSpecifier}${quote}`,
        });
        continue;
      }
      // Some names stay behind: the one statement becomes two.
      const start = statement.getStart(sourceFile);
      const indent = ' '.repeat(at(start).character);
      const modifier = statement.isTypeOnly ? 'type ' : '';
      const list = (elements: readonly ts.ExportSpecifier[]) =>
        elements.map((element) => element.getText(sourceFile)).join(', ');
      edits.push({
        range: { start: at(start), end: at(statement.getEnd()) },
        newText:
          `export ${modifier}{ ${list(kept)} } from ${quote}${specifier.text}${quote};\n` +
          `${indent}export ${modifier}{ ${list(moved)} } from ${quote}${newSpecifier}${quote};`,
      });
    }
    if (edits.length > 0) changes[file] = edits;
  }
  return { edit: { changes }, warnings };
}

/**
 * Files whose only reach to the moved symbol is a namespace import used
 * in type position, which the engine leaves behind.
 *
 * It rewrites a namespace member only where the reference's parent is a
 * property access; `ns.X` written as a type annotation parses as a
 * qualified name instead, so the reference still points at the old
 * module and the guard refuses with TS2694. The refusal is right —
 * re-implementing the engine's alias derivation to fix it would mean
 * keeping a copy of it in step across TypeScript versions — but leaving
 * the caller to work out why from a bare diagnostic is not.
 */
function namespaceRefusals(
  diagnostics: readonly string[],
  source: string,
  names: ReadonlySet<string>,
): string[] {
  // TS2694 renders the module without its extension.
  const stem = source.replace(/\.[cm]?tsx?$/, '');
  const files = new Set<string>();
  for (const text of diagnostics) {
    if (!text.includes('TS2694') || !text.includes(stem)) continue;
    if (![...names].some((name) => text.includes(`'${name}'`))) continue;
    const file = /^(.*?)\(\d+,\d+\):/.exec(text)?.[1];
    if (file) files.add(file);
  }
  return [...files].map(
    (file) =>
      `${file} reaches the symbol through a namespace import. TypeScript's move engine ` +
      'rewrites `ns.X` only where it is a property access, and a type annotation written ' +
      '`ns.X` is a qualified name, so that reference still points at the old module and the ' +
      'move is refused. Convert that file to a named import and the move succeeds.',
  );
}

/** Does `file` import any of `names` from `source`? */
function importsNamesFrom(
  session: TsProjectSession,
  file: string,
  source: string,
  names: ReadonlySet<string>,
): boolean {
  const sourceFile = session.program().getSourceFile(file);
  if (!sourceFile) return false;
  const compilerOptions = session.program().getCompilerOptions();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    if (!bindings.elements.some((element) => names.has((element.propertyName ?? element.name).text))) {
      continue;
    }
    const resolved = ts.resolveModuleName(
      statement.moduleSpecifier.text,
      sourceFile.fileName,
      compilerOptions,
      ts.sys,
    ).resolvedModule;
    if (resolved && path.resolve(resolved.resolvedFileName) === source) return true;
  }
  return false;
}

/** The engine's internal failure, verbatim, including its cause. */
function failureText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : '';
  return `${message} ${cause}`;
}

export const moveSymbol: Tool<MoveSymbolInput, MoveSymbolOutput, TsProjectSession> = {
  name: 'ts/refactors/move-symbol',
  description:
    'Moves a top-level declaration (interface, type, class, function, const, enum) out of ' +
    'its file into another file — existing or newly created — exporting it if it was not ' +
    'exported, adding the imports the moved code needs, and rewriting the module specifier ' +
    'in every file that imports it. In TypeScript the module is the file, so this is also ' +
    'how a symbol changes module. Targets a declaration by name (symbol) or exact position; ' +
    'toFile names the destination, and omitting it lets TypeScript create a file named after ' +
    'the symbol (its candidate destinations come back in destinationSuggestions). Refuses ' +
    'targets that are not top-level statements, and refuses any move the in-memory typecheck ' +
    'says would not compile, reporting it in newDiagnostics. Barrel re-exports naming the ' +
    'symbol are redirected too; an export * that can no longer carry it is reported in ' +
    'warnings. Dry-run by default; apply: true writes to disk.',
  inputSchema: {
    type: 'object',
    properties: {
      ...SYMBOL_TARGET_PROPERTIES,
      toFile: {
        type: 'string',
        description:
          'Destination file, existing or to be created (relative to the project root); omit to let TypeScript name a new file',
      },
      apply: { type: 'boolean', description: 'Write the edit to disk (default false)' },
    },
    additionalProperties: false,
  },
  outputSchema: refactorOutputSchema({
    created: { type: 'array', items: { type: 'string' } },
    destinationSuggestions: { type: 'array', items: { type: 'string' } },
  }),
  async run(session, input) {
    const target = resolveTarget(session, input);
    const declaration = declarationAt(target);
    const statement = topLevelStatement(declaration);
    const symbolName = declaration.name?.getText(target.sourceFile) ?? '(unnamed)';
    const source = path.resolve(target.file);
    if (!statement) {
      throw new Error(
        `"${symbolName}" is not a top-level declaration of ${source}; only whole top-level ` +
          'statements move between files',
      );
    }
    // A range, not the caret offset: the engine moves the statements a
    // selection covers, and an empty selection covers none of them.
    const at: ts.TextRange = {
      pos: statement.getStart(target.sourceFile),
      end: statement.getEnd(),
    };

    const toNewFile = input.toFile === undefined;
    const refactor = toNewFile ? 'Move to a new file' : 'Move to file';
    const available = applicableActions(session, target.file, at, 'refactor.move');
    if (!available.some((action) => action.refactor === refactor)) {
      const offered = available.map((action) => `"${action.refactor}"`).join(', ') || 'none';
      throw new Error(
        `TypeScript offers no "${refactor}" refactoring for "${symbolName}" in ${source} ` +
          `(offered: ${offered})`,
      );
    }

    let destination: string | undefined;
    if (input.toFile !== undefined) {
      destination = path.resolve(session.rootPath, input.toFile);
      if (destination === source) throw new Error(`"${symbolName}" already lives in ${source}`);
      if (ts.sys.directoryExists(destination)) {
        throw new Error(`Destination ${destination} is a directory, not a file`);
      }
    }

    const names = boundNames(statement);
    let moved: RefactorResult;
    try {
      moved = runRefactor(session, {
        file: target.file,
        at,
        refactor,
        action: refactor,
        ...(destination === undefined ? {} : { interactive: { targetFile: destination } }),
      });
    } catch (error) {
      // The engine deletes the destination's import of the symbol and
      // adds the imports the moved code needs to that same statement,
      // then asserts its own changes do not overlap.
      if (
        destination !== undefined &&
        /Changes overlap/.test(failureText(error)) &&
        importsNamesFrom(session, destination, source, names)
      ) {
        throw new Error(
          `${destination} already imports "${symbolName}" from ${source}, and TypeScript's ` +
            'move engine cannot rewrite that import and add the imports the moved code needs ' +
            'in one pass (it fails with "Changes overlap"). Move to a new file, or to a ' +
            'destination that does not import the symbol.',
          { cause: error },
        );
      }
      throw error;
    }

    const created = (moved.edit.fileOps ?? [])
      .filter((op) => op.kind === 'create')
      .map((op) => path.resolve(op.file));
    const landedIn = destination ?? created[0];
    const fixes =
      landedIn === undefined
        ? { edit: { changes: {} }, warnings: [] }
        : fixReExports(session, {
            names,
            source,
            destination: landedIn,
            engineEdits: Object.fromEntries(
              Object.entries(moved.edit.changes).map(([file, edits]) => [
                path.resolve(file),
                edits,
              ]),
            ),
          });

    const edit = mergeWorkspaceEdits(moved.edit, fixes.edit);
    const filesChanged = filesTouched(edit);
    const destinationSuggestions = toNewFile
      ? session
          .languageService()
          .service.getMoveToRefactoringFileSuggestions(target.file, at, userPreferences(session))
          .files.map((file) => path.resolve(file))
          .sort()
      : [];

    const newDiagnostics = (await diagnosticsIntroducedBy(session, edit)).map((d) => d.text);
    const result = {
      edit,
      filesChanged,
      newDiagnostics,
      warnings: [...fixes.warnings, ...namespaceRefusals(newDiagnostics, source, names)],
      created,
      destinationSuggestions,
    };
    if (!input.apply || newDiagnostics.length > 0) return { applied: false, ...result };

    const written = await applyWorkspaceEdit(edit);
    session.invalidate(written);
    return { applied: true, ...result };
  },
};

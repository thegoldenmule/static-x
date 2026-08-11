import path from 'node:path';
import ts from 'typescript';
import { applyWorkspaceEdit } from '../../../core/edits/index.js';
import type { Tool } from '../../../core/tool/index.js';
import { resolveTarget } from '../../ast/targets.js';
import type { TsProjectSession } from '../../project/index.js';
import { diagnosticsIntroducedBy } from '../guard.js';
import { filesTouched, refactorOutputSchema, type RefactorOutput } from '../output.js';
import { applicableActions, runRefactor } from '../refactor-action.js';

/**
 * Converts between the forms a module can take: a default export and a
 * named one, a namespace import and named imports.
 *
 * ReSharper's nearest entry is Introduce Namespace Alias, and it is
 * only half the story — C# aliases a node in a global namespace tree,
 * while the only thing TypeScript has to alias is a module specifier.
 * The export half has no ReSharper counterpart at all, because C# has
 * no notion of one member of a namespace being the default one.
 *
 * What makes it worth a tool rather than an edit is entirely the blast
 * radius: changing a default export to a named one rewrites the import
 * clause in every file that imports it, and converting a namespace
 * import rewrites both the clause and every `ns.member` access in that
 * file. Those are the files a caller looking at the module never opened.
 *
 * The guard is a complete oracle here, which is rare: a missed importer
 * is TS2613 or TS1192, never a silent change of meaning.
 */

export type ModuleForm =
  | 'named-export'
  | 'default-export'
  | 'named-imports'
  | 'default-import'
  | 'namespace-import';

export interface ModuleFormInput {
  file: string;
  /** For export conversions: the exported declaration to convert. */
  symbol?: string;
  /** For import conversions: the module specifier whose import to convert. */
  module?: string;
  to: ModuleForm;
  apply?: boolean;
}

export type ModuleFormOutput = RefactorOutput;

const ACTIONS: Record<ModuleForm, { refactor: string; action: string; needs: 'symbol' | 'module' }> =
  {
    'named-export': {
      refactor: 'Convert export',
      action: 'Convert default export to named export',
      needs: 'symbol',
    },
    'default-export': {
      refactor: 'Convert export',
      action: 'Convert named export to default export',
      needs: 'symbol',
    },
    'named-imports': {
      refactor: 'Convert import',
      action: 'Convert namespace import to named imports',
      needs: 'module',
    },
    'default-import': {
      refactor: 'Convert import',
      action: 'Convert named imports to default import',
      needs: 'module',
    },
    'namespace-import': {
      refactor: 'Convert import',
      action: 'Convert named imports to namespace import',
      needs: 'module',
    },
  };

/** The import declaration in `file` for `specifier`. */
function importOf(sourceFile: ts.SourceFile, specifier: string): ts.ImportDeclaration {
  const matches = sourceFile.statements.filter(
    (statement): statement is ts.ImportDeclaration =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === specifier,
  );
  if (matches.length === 0) {
    const available = sourceFile.statements
      .filter(ts.isImportDeclaration)
      .map((statement) => (statement.moduleSpecifier as ts.StringLiteral).text);
    throw new Error(
      `${sourceFile.fileName} has no import from "${specifier}"` +
        (available.length > 0 ? `; it imports from ${available.map((s) => `"${s}"`).join(', ')}` : ''),
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `${sourceFile.fileName} imports from "${specifier}" ${matches.length} times; ` +
        'combine them before converting',
    );
  }
  return matches[0]!;
}

export const moduleForm: Tool<ModuleFormInput, ModuleFormOutput, TsProjectSession> = {
  name: 'ts/refactors/module-form',
  description:
    'Converts between the forms a module can take, rewriting every file affected: a default ' +
    'export to a named one or back (to: named-export | default-export, with symbol naming the ' +
    'declaration), and a namespace import to named imports or back (to: named-imports | ' +
    'default-import | namespace-import, with module naming the specifier). Changing an export ' +
    "form rewrites the import clause in every importer; converting a namespace import rewrites " +
    'both the clause and every ns.member access in that file — the files a caller looking at ' +
    'one module never opened. Refuses when TypeScript does not offer that conversion at the ' +
    'target, reporting its own reason. Dry-run by default; apply: true writes to disk unless ' +
    'the in-memory typecheck reports newDiagnostics.',
  inputSchema: {
    type: 'object',
    properties: {
      file: { type: 'string', description: 'File holding the export or import to convert' },
      symbol: { type: 'string', description: 'Exported declaration, for an export conversion' },
      module: { type: 'string', description: 'Module specifier, for an import conversion' },
      to: {
        type: 'string',
        enum: ['named-export', 'default-export', 'named-imports', 'default-import', 'namespace-import'],
        description: 'The form to convert to',
      },
      apply: { type: 'boolean', description: 'Write the edit to disk (default false)' },
    },
    required: ['file', 'to'],
    additionalProperties: false,
  },
  outputSchema: refactorOutputSchema(),

  async run(session, input) {
    const wanted = ACTIONS[input.to];
    if (!wanted) throw new Error(`Unknown form "${String(input.to)}"`);

    const file = path.resolve(session.rootPath, input.file);
    const sourceFile = session.program().getSourceFile(file);
    if (!sourceFile) throw new Error(`${file} is not a source file in this project`);

    let at: number;
    if (wanted.needs === 'symbol') {
      if (input.symbol === undefined) {
        throw new Error(`Converting to ${input.to} needs "symbol": the declaration to convert`);
      }
      at = resolveTarget(session, { symbol: input.symbol, file: input.file }).offset;
    } else {
      if (input.module === undefined) {
        throw new Error(`Converting to ${input.to} needs "module": the specifier to convert`);
      }
      at = importOf(sourceFile, input.module).getStart(sourceFile);
    }

    // The engine re-derives its own target and dispatches on that
    // rather than on the action it was handed, so asking for a
    // conversion it did not offer performs a *different* one. Checking
    // the action is among those listed is what keeps the answer the
    // question that was asked; runRefactor does that before running.
    const offered = applicableActions(session, file, at, 'refactor.rewrite');
    if (!offered.some((action) => action.action === wanted.action)) {
      const alternatives = offered
        .filter((action) => action.kind?.startsWith('refactor.rewrite.import') === true ||
          action.kind?.startsWith('refactor.rewrite.export') === true)
        .map((action) => `"${action.description}"`);
      throw new Error(
        `TypeScript does not offer "${wanted.action}" there` +
          (alternatives.length > 0 ? `; it offers ${alternatives.join(', ')}` : ''),
      );
    }

    const { edit } = runRefactor(session, {
      file,
      at,
      refactor: wanted.refactor,
      action: wanted.action,
    });

    const filesChanged = filesTouched(edit);
    const newDiagnostics = (await diagnosticsIntroducedBy(session, edit)).map((d) => d.text);
    const output = { edit, filesChanged, newDiagnostics, warnings: [] };

    if (input.apply !== true || newDiagnostics.length > 0) {
      return { applied: false, ...output };
    }
    const written = await applyWorkspaceEdit(edit);
    session.invalidate(written);
    return { applied: true, ...output };
  },
};

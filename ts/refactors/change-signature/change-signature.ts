import path from 'node:path';
import ts from 'typescript';
import { applyWorkspaceEdit } from '../../../core/edits/index.js';
import type { Tool, WorkspaceEdit } from '../../../core/tool/index.js';
import { memberHierarchy } from '../../ast/hierarchy.js';
import { declarationAt, resolveTarget, SYMBOL_TARGET_PROPERTIES } from '../../ast/targets.js';
import type { TsProjectSession } from '../../project/index.js';
import { diagnosticsIntroducedBy } from '../guard.js';
import { filesTouched, refactorOutputSchema, type RefactorOutput } from '../output.js';
import { applicableActions, runRefactor } from '../refactor-action.js';
import {
  assertOnlyCalls,
  callableOf,
  locationOf,
  resolveCall,
  surveyCallSites,
} from '../signatures.js';

/**
 * Converts a positional parameter list into a single destructured
 * options object, rewriting every call site: `f(a, b, c)` becomes
 * `f({ a, b, c })`.
 *
 * This is the half of ReSharper's Change Signature that is safe to
 * ship. The guard cannot see the other half: reordering two parameters
 * of compatible type, or widening one, compiles green and misbehaves at
 * runtime, and no amount of analysis closes that. Converting to named
 * arguments removes the trap by construction rather than guarding
 * against it — after the conversion, position carries no meaning.
 *
 * TypeScript performs the rewrite, including at call sites in files the
 * caller never opened and through namespace-qualified access. It has
 * two defects this tool exists to cover, both verified:
 *
 * - Given any reference that is not a call, it reports the refactoring
 *   as applicable and then returns *no edits at all* — no error, no
 *   reason. Silence is indistinguishable from success.
 * - It deduplicates call sites by source position without an equality
 *   comparer, so two calls at the same byte offset in different files
 *   collapse to one and the second is left calling positionally. Two
 *   near-identical sibling files are enough to trigger it, which is an
 *   ordinary shape for handlers, routes and adapters.
 *
 * The first is a refusal: the classifier decides what is rewritable
 * before the engine is asked anything, because an escape genuinely
 * makes the conversion unsafe. The second is not — the engine is wrong
 * about which calls to visit, not about what the conversion should be,
 * and the collision is an artifact of file layout rather than anything
 * about the code. So the calls it skipped are rewritten here, from the
 * same resolved signatures, and the repair is reported in `warnings`
 * rather than passed off as the engine's own work.
 */

export interface ChangeSignatureInput {
  symbol?: string;
  file?: string;
  line?: number;
  character?: number;
  apply?: boolean;
}

export interface CallSitePosition {
  file: string;
  line: number;
  character: number;
}

export interface ChangeSignatureOutput extends RefactorOutput {
  /** Every call the edit rewrites. */
  callSites: CallSitePosition[];
}

function positionsOf(references: readonly { file: string; line: number; character: number }[]) {
  return references.map((reference) => ({
    file: reference.file,
    line: reference.line,
    character: reference.character,
  }));
}

/** Whether any edit in `edit` touches this call's argument list. */
function argumentsRewritten(
  edit: WorkspaceEdit,
  call: ts.CallExpression | ts.NewExpression,
  sourceFile: ts.SourceFile,
): boolean {
  const edits = edit.changes[path.resolve(sourceFile.fileName)] ?? [];
  const args = call.arguments;
  if (!args) return false;
  return edits.some((candidate) => {
    const start = sourceFile.getPositionOfLineAndCharacter(
      candidate.range.start.line,
      candidate.range.start.character,
    );
    const end = sourceFile.getPositionOfLineAndCharacter(
      candidate.range.end.line,
      candidate.range.end.character,
    );
    return start < args.end && end > args.pos;
  });
}

/**
 * The options object a positional argument list becomes.
 *
 * Names come from the resolved signature rather than from the
 * declaration's parameter order, so a `this` parameter or an overload
 * cannot shift them. An argument already named after its parameter is
 * written in shorthand, which is what TypeScript's own conversion emits
 * and what a human would have written.
 */
function optionsObjectFor(
  call: ts.CallExpression | ts.NewExpression,
  signature: ts.Signature,
  sourceFile: ts.SourceFile,
): string {
  const fields: string[] = [];
  for (const [index, argument] of [...(call.arguments ?? [])].entries()) {
    const parameter = signature.parameters[index];
    const declaration = parameter?.declarations?.[0];
    if (!parameter || !declaration || !ts.isParameter(declaration) || !ts.isIdentifier(declaration.name)) {
      throw new Error(
        `Cannot name argument ${index + 1} of the call at ${locationOf(sourceFile, call.getStart(sourceFile))}`,
      );
    }
    const name = declaration.name.text;
    const text = argument.getText(sourceFile);
    fields.push(text === name ? name : `${name}: ${text}`);
  }
  return `{ ${fields.join(', ')} }`;
}

export const changeSignature: Tool<
  ChangeSignatureInput,
  ChangeSignatureOutput,
  TsProjectSession
> = {
  name: 'ts/refactors/change-signature',
  description:
    'Converts a function, method, or constructor from positional parameters to a single ' +
    'destructured options object, rewriting every call site project-wide: f(a, b, c) becomes ' +
    'f({ a, b, c }). Targets a declaration by name (symbol) or exact position. This is the ' +
    'form of a signature change worth trusting: reordering or retyping positional parameters ' +
    'compiles green and misbehaves at run time, which no guard can see, while named arguments ' +
    'remove that trap by construction. Refuses when the function is ever used as a value ' +
    '(arr.map(f), .call/.apply/.bind, typeof f, a decorator, a JSX component), because arity ' +
    'is checked by assignability there; on spread calls; on overload sets; and on a method ' +
    'that overrides or implements another. TypeScript silently drops calls that share a byte ' +
    'offset with one in another file; those are rewritten here instead and reported in ' +
    'warnings. Dry-run by default; apply: true writes to disk.',
  inputSchema: {
    type: 'object',
    properties: {
      ...SYMBOL_TARGET_PROPERTIES,
      apply: { type: 'boolean', description: 'Write the edit to disk (default false)' },
    },
    additionalProperties: false,
  },
  outputSchema: refactorOutputSchema(
    {
      callSites: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            file: { type: 'string' },
            line: { type: 'integer' },
            character: { type: 'integer' },
          },
        },
      },
    },
    ['callSites'],
  ),

  async run(session, input) {
    const target = resolveTarget(session, input);
    const declaration = declarationAt(target);
    const callable = callableOf(declaration);
    if (!callable) {
      throw new Error(
        `${target.file}:${target.position.line + 1} is not a function, method, or arrow-valued const`,
      );
    }
    const calleeName =
      declaration.name && ts.isIdentifier(declaration.name) ? declaration.name.text : '(anonymous)';

    if (callable.getSourceFile().isDeclarationFile) {
      throw new Error(`"${calleeName}" is declared in a .d.ts file, which has no implementation`);
    }
    const parameters = callable.parameters.filter(
      (parameter) => !(ts.isIdentifier(parameter.name) && parameter.name.text === 'this'),
    );
    if (parameters.length === 0) {
      throw new Error(`"${calleeName}" has no parameters to convert`);
    }
    if (parameters.some((parameter) => parameter.dotDotDotToken)) {
      throw new Error(
        `"${calleeName}" has a rest parameter, which collects arguments positionally and cannot become a named field`,
      );
    }

    // Overload sets share one implementation but many signatures, so a
    // call may resolve to a shape the edit does not describe.
    const checker = session.checker();
    const symbol = declaration.name ? checker.getSymbolAtLocation(declaration.name) : undefined;
    const callables = (symbol?.declarations ?? []).filter((node) => callableOf(node) !== undefined);
    if (callables.length > 1) {
      throw new Error(
        `"${calleeName}" is an overload set (${callables.length} declarations); each signature would need its own conversion`,
      );
    }

    if (ts.isMethodDeclaration(callable)) {
      const hierarchy = memberHierarchy(session, callable);
      if (hierarchy.unresolved.length > 0) {
        throw new Error(
          `"${calleeName}"'s class hierarchy cannot be resolved, so overrides may be invisible:\n  ${hierarchy.unresolved.join('\n  ')}`,
        );
      }
      const related = [...hierarchy.supertypes, ...hierarchy.subtypes];
      if (related.length > 0) {
        throw new Error(
          `"${calleeName}" is declared by ${related.map((member) => member.container).join(', ')} as well; ` +
            'a signature shared with a base or an implementer must change everywhere at once',
        );
      }
    }

    const survey = surveyCallSites(session, target.file, target.offset, calleeName);
    assertOnlyCalls(calleeName, survey, 'converting its parameters to an options object');

    const actions = applicableActions(
      session,
      target.file,
      target.offset,
      'refactor.rewrite.parameters',
    );
    const action = actions.find((candidate) => candidate.kind === 'refactor.rewrite.parameters.toDestructured');
    if (!action) {
      throw new Error(
        `TypeScript will not convert "${calleeName}" to a destructured object at this position`,
      );
    }

    const { edit } = runRefactor(session, {
      file: target.file,
      at: target.offset,
      refactor: action.refactor,
      action: action.action,
    });

    // TypeScript deduplicates call sites by source position without
    // comparing files, so a call sharing a byte offset with one in
    // another file is dropped and left calling positionally. The edit
    // looks fine and nothing is reported. Two byte-identical sibling
    // files are enough — an ordinary shape for handlers and routes.
    //
    // The defect is in which calls the engine visits, not in what the
    // conversion should be, so the missing edits are authored here
    // rather than the whole refactoring being refused over a bug in
    // somebody else's dedupe.
    const repaired: WorkspaceEdit = { ...edit, changes: { ...edit.changes } };
    const warnings: string[] = [];
    const missed: string[] = [];
    for (const reference of survey.calls) {
      const { call, sourceFile } = resolveCall(checker, reference, callable, calleeName);
      if (argumentsRewritten(edit, call, sourceFile)) continue;

      const signature = checker.getResolvedSignature(call);
      if (!signature) {
        missed.push(`${reference.file}:${reference.line + 1}:${reference.character + 1}`);
        continue;
      }
      const args = call.arguments;
      if (!args) {
        missed.push(`${reference.file}:${reference.line + 1}:${reference.character + 1}`);
        continue;
      }
      const file = path.resolve(sourceFile.fileName);
      repaired.changes[file] = [
        ...(repaired.changes[file] ?? []),
        {
          range: {
            start: sourceFile.getLineAndCharacterOfPosition(args.pos),
            end: sourceFile.getLineAndCharacterOfPosition(args.end),
          },
          newText: optionsObjectFor(call, signature, sourceFile),
        },
      ];
      warnings.push(
        `TypeScript skipped the call at ${reference.file}:${reference.line + 1}:${reference.character + 1} ` +
          '(it deduplicates call sites by position without comparing files); it was rewritten here instead',
      );
    }
    if (missed.length > 0) {
      throw new Error(
        `TypeScript rewrote the declaration but not every call, and these could not be ` +
          `rewritten here either — they would be left calling "${calleeName}" positionally:\n  ${missed.join('\n  ')}`,
      );
    }

    const edit2 = repaired;
    const filesChanged = filesTouched(edit2);
    const callSites = positionsOf(survey.calls);
    const newDiagnostics = (await diagnosticsIntroducedBy(session, edit2)).map(
      (diagnostic) => diagnostic.text,
    );

    if (input.apply !== true || newDiagnostics.length > 0) {
      return { applied: false, edit: edit2, filesChanged, newDiagnostics, warnings, callSites };
    }

    const written = await applyWorkspaceEdit(edit2);
    session.invalidate(written);
    return { applied: true, edit: edit2, filesChanged, newDiagnostics, warnings, callSites };
  },
};

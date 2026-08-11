import path from 'node:path';
import ts from 'typescript';
import { applyWorkspaceEdit } from '../../../core/edits/index.js';
import type { Position, TextEdit, Tool, WorkspaceEdit } from '../../../core/tool/index.js';
import { declarationAt, resolveTarget, SYMBOL_TARGET_PROPERTIES } from '../../ast/targets.js';
import type { TsProjectSession } from '../../project/index.js';
import { diagnosticsIntroducedBy } from '../guard.js';
import { filesTouched, refactorOutputSchema, type RefactorOutput } from '../output.js';
import { classifyReferences } from '../references.js';
import { describeReferences, locationOf } from '../signatures.js';
import { readExpression } from '../stability.js';

/**
 * Replaces `new C(…)` with a static factory and closes the constructor —
 * ReSharper's Replace Constructor with Factory Method.
 *
 * The TypeScript motivation is stronger than the C# one. A constructor
 * cannot be `async` and cannot return a subtype or a cached instance, so
 * a factory is not merely an indirection to hang policy on: it is the
 * only way to build an object that has to await something. Converting
 * first, and making the constructor unreachable from outside, is what
 * makes that change possible later without touching call sites again.
 *
 * What it must not do is leave a `new C(…)` behind. A closed constructor
 * with a missed site is `TS2673`, which the guard catches — the danger
 * is the opposite one, a site the reference search never names because
 * the class escaped into a variable first (`const K = C; new K()`). That
 * compiles before and after, so an escape is refused rather than
 * rewritten.
 *
 * The constructor is left `protected` rather than `private` when the
 * class has subclasses, because `private` would break every `super(…)`
 * call — the same edit, decided by what the hierarchy actually is.
 */

export interface ConstructorToFactoryInput {
  /** Class whose constructor to close, by name. */
  symbol?: string;
  file?: string;
  line?: number;
  character?: number;
  /** Factory method name (default `create`). */
  name?: string;
  apply?: boolean;
}

export interface ConstructionSite extends Position {
  file: string;
}

export interface ConstructorToFactoryOutput extends RefactorOutput {
  /** The factory's name, as written. */
  factory: string;
  /** Visibility the constructor was given. */
  visibility: 'private' | 'protected';
  /** Every `new` the edit rewrote. */
  sites: ConstructionSite[];
}

/** A constructor parameter as the factory must restate and forward it. */
interface ForwardedParameter {
  /** Text of the parameter in the factory's own signature. */
  declaration: string;
  /** Expression passing it on to the constructor. */
  argument: string;
}

/**
 * Restate one constructor parameter for the factory.
 *
 * Two things cannot survive verbatim. An accessibility modifier is legal
 * only on a constructor parameter — `static create(private x: string)`
 * is `TS2369` — so parameter properties lose the modifier and keep
 * everything else. And a destructured parameter has no name to forward,
 * so it is given one and its written type is reused; with no written
 * type there is nothing to give the generated name, and that is a
 * refusal rather than a guess.
 */
function forwardParameter(
  parameter: ts.ParameterDeclaration,
  index: number,
  sourceFile: ts.SourceFile,
  className: string,
): ForwardedParameter {
  const dots = parameter.dotDotDotToken ? '...' : '';
  const question = parameter.questionToken ? '?' : '';
  const type = parameter.type ? `: ${parameter.type.getText(sourceFile)}` : '';
  const initializer = parameter.initializer
    ? ` = ${parameter.initializer.getText(sourceFile)}`
    : '';

  if (ts.isIdentifier(parameter.name)) {
    const name = parameter.name.text;
    return {
      declaration: `${dots}${name}${question}${type}${initializer}`,
      argument: `${dots}${name}`,
    };
  }

  if (!parameter.type) {
    throw new Error(
      `${className}'s constructor destructures parameter ${String(index + 1)} and does not ` +
        'annotate it. The factory needs a name to forward, and the only type to give that name ' +
        'is inferred from the pattern, which cannot be written back out reliably. Annotate the ' +
        'parameter, or run ts/refactors/change-signature to convert it to an options object.',
    );
  }
  const name = `arg${String(index + 1)}`;
  return {
    declaration: `${dots}${name}${question}${type}${initializer}`,
    argument: `${dots}${name}`,
  };
}

/** The indentation of the line a node starts on. */
function indentOf(node: ts.Node, sourceFile: ts.SourceFile): string {
  const text = sourceFile.getFullText();
  let start = node.getStart(sourceFile);
  while (start > 0 && text[start - 1] !== '\n') start--;
  return /^[ \t]*/.exec(text.slice(start, node.getStart(sourceFile)))?.[0] ?? '  ';
}

/** Classes in the project that extend `target`. */
function subclassesOf(session: TsProjectSession, target: ts.ClassDeclaration): string[] {
  const checker = session.checker();
  const symbol = target.name ? checker.getSymbolAtLocation(target.name) : undefined;
  if (!symbol) return [];
  const found: string[] = [];
  for (const sourceFile of session.compilationFiles()) {
    const visit = (node: ts.Node): void => {
      if (ts.isClassLike(node)) {
        for (const clause of node.heritageClauses ?? []) {
          if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue;
          for (const type of clause.types) {
            let base = checker.getSymbolAtLocation(type.expression);
            if (base && base.flags & ts.SymbolFlags.Alias) base = checker.getAliasedSymbol(base);
            if (base === symbol) found.push(node.name?.text ?? '(anonymous class)');
          }
        }
      }
      node.forEachChild(visit);
    };
    sourceFile.forEachChild(visit);
  }
  return found;
}

export const constructorToFactory: Tool<
  ConstructorToFactoryInput,
  ConstructorToFactoryOutput,
  TsProjectSession
> = {
  name: 'ts/refactors/constructor-to-factory',
  description:
    "Replaces every `new C(...)` with a static factory and closes the constructor — ReSharper's " +
    'Replace Constructor with Factory Method. Targets the class by name (symbol) or exact ' +
    'position; the factory is named `create` unless `name` says otherwise. The point in ' +
    'TypeScript is that a constructor cannot be `async` and cannot return a cached instance or ' +
    'a subtype, so this is the edit that makes those possible later without touching call sites ' +
    'again. The constructor becomes `protected` when the class has subclasses and `private` ' +
    'otherwise, since `private` would break every `super(...)`. Refuses a class whose name ' +
    'reaches a binding it cannot follow — `const K = C`, or ' +
    '`const { C } = await import(...)` — because `new K()` is then not a reference to this class ' +
    'at all; an abstract class, which has no `new`; a class with no explicit constructor to ' +
    'close; overloaded constructor signatures; a constructor reading `new.target`, whose value ' +
    'the factory changes; a destructured constructor parameter with no written type, which ' +
    'leaves the factory nothing to forward; and a name already taken by another static member. ' +
    'Dry-run by default.',
  inputSchema: {
    type: 'object',
    properties: {
      ...SYMBOL_TARGET_PROPERTIES,
      name: { type: 'string', description: 'Factory method name (default "create")' },
      apply: { type: 'boolean', description: 'Write the edit to disk (default false)' },
    },
    additionalProperties: false,
  },
  outputSchema: refactorOutputSchema(
    {
      factory: { type: 'string' },
      visibility: { type: 'string', enum: ['private', 'protected'] },
      sites: {
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
    ['factory', 'visibility', 'sites'],
  ),

  async run(session, input) {
    const target = resolveTarget(session, input);
    const declaration = declarationAt(target);
    if (!ts.isClassDeclaration(declaration) || !declaration.name) {
      throw new Error(
        `${target.file}:${target.position.line + 1} is not a named class declaration`,
      );
    }
    const sourceFile = declaration.getSourceFile();
    const className = declaration.name.text;
    const factoryName = input.name ?? 'create';

    if ((declaration.modifiers ?? []).some((m) => m.kind === ts.SyntaxKind.AbstractKeyword)) {
      throw new Error(`${className} is abstract, so nothing constructs it directly`);
    }

    const constructors = declaration.members.filter(ts.isConstructorDeclaration);
    if (constructors.length === 0) {
      throw new Error(
        `${className} declares no constructor, so there is no signature for the factory to ` +
          'restate and nothing to close. Add one first if you want a factory.',
      );
    }
    if (constructors.length > 1) {
      throw new Error(
        `${className} has ${String(constructors.length)} constructor signatures. Which overload ` +
          'a call site chose is decided per site, so one factory cannot restate them all.',
      );
    }
    const constructor = constructors[0]!;

    for (const member of declaration.members) {
      const isStatic = ts.canHaveModifiers(member)
        ? (ts.getModifiers(member) ?? []).some((m) => m.kind === ts.SyntaxKind.StaticKeyword)
        : false;
      if (
        isStatic &&
        member.name &&
        ts.isIdentifier(member.name) &&
        member.name.text === factoryName
      ) {
        throw new Error(
          `${className} already declares a static "${factoryName}". Pass a different \`name\`.`,
        );
      }
    }

    // `new.target` is the constructor that was invoked. Reached through
    // a factory it is the class itself rather than whatever a caller
    // used, and nothing about that changes a type.
    let readsNewTarget = false;
    const findNewTarget = (node: ts.Node): void => {
      if (node.kind === ts.SyntaxKind.MetaProperty) readsNewTarget = true;
      if (ts.isClassLike(node) && node !== declaration) return;
      node.forEachChild(findNewTarget);
    };
    constructor.forEachChild(findNewTarget);
    if (readsNewTarget) {
      throw new Error(
        `${className}'s constructor reads \`new.target\`, which is the constructor a caller ` +
          'invoked. Every construction through the factory would report this class instead, and ' +
          'that is not a type change.',
      );
    }

    const references = classifyReferences(session, target.file, target.offset);
    // Allowlist, not denylist. This tool's one unforgivable failure is
    // leaving a `new` behind, and every kind that is not enumerated here
    // is one where the class value reaches a binding the reference
    // search cannot follow — `const { C } = await import(...)` being the
    // case that actually occurred, twice, in a real corpus. Refusing an
    // unfamiliar kind costs a run; passing one costs correctness.
    const SAFE: ReadonlySet<string> = new Set([
      'declaration',
      'import-binding',
      'export-specifier',
      'type-position',
      'new',
    ]);
    const escapes = references.filter((reference) => {
      if (SAFE.has(reference.kind)) return false;
      if (reference.kind !== 'read') return true;
      // Reaching a static member or testing `instanceof` does not reach
      // the constructor, so those reads are not escapes.
      const parent = reference.node.parent as ts.Node | undefined;
      if (parent && ts.isPropertyAccessExpression(parent) && parent.expression === reference.node) {
        return false;
      }
      const isInstanceOf =
        parent !== undefined &&
        ts.isBinaryExpression(parent) &&
        parent.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword &&
        parent.right === reference.node;
      return !isInstanceOf;
    });
    if (escapes.length > 0) {
      throw new Error(
        `${className} reaches a binding this cannot follow at:\n  ` +
          `${describeReferences(escapes)}\nA \`new\` through that binding is not a reference to ` +
          'this class, so closing the constructor would break it somewhere nothing points at.',
      );
    }

    const sites = references.filter((reference) => reference.kind === 'new');
    if (sites.length === 0) {
      throw new Error(
        `Nothing constructs ${className} in this project, so there are no call sites a factory ` +
          'would spare. If it is constructed downstream, that is outside what this can rewrite.',
      );
    }

    const subclasses = subclassesOf(session, declaration);
    const visibility: 'private' | 'protected' = subclasses.length > 0 ? 'protected' : 'private';

    const forwarded = constructor.parameters.map((parameter, index) =>
      forwardParameter(parameter, index, sourceFile, className),
    );
    const typeParameters = declaration.typeParameters
      ? `<${declaration.typeParameters.map((p) => p.getText(sourceFile)).join(', ')}>`
      : '';
    const typeArguments = declaration.typeParameters
      ? `<${declaration.typeParameters.map((p) => p.name.text).join(', ')}>`
      : '';

    const indent = indentOf(constructor, sourceFile);
    // The anchor sits at the member's first non-whitespace column, so
    // the opening line carries no indent of its own and the closing one
    // restores it for whatever followed.
    const factory =
      `/** Builds a ${className}. Prefer this to \`new\`. */\n` +
      `${indent}static ${factoryName}${typeParameters}(` +
      `${forwarded.map((p) => p.declaration).join(', ')}` +
      `): ${className}${typeArguments} {\n` +
      `${indent}  return new ${className}${typeArguments}(` +
      `${forwarded.map((p) => p.argument).join(', ')});\n` +
      `${indent}}\n\n${indent}`;

    const at = (offset: number) => sourceFile.getLineAndCharacterOfPosition(offset);
    const declarationPath = path.resolve(sourceFile.fileName);
    const changes: Record<string, TextEdit[]> = {};
    const push = (file: string, edit: TextEdit): void => {
      changes[file] = [...(changes[file] ?? []), edit];
    };

    // The factory goes immediately above the constructor it wraps, so
    // the two read together and the class's member order is otherwise
    // untouched. `getStart(sourceFile, true)` includes the JSDoc, which
    // belongs to the constructor and must stay with it; the visibility
    // keyword goes at the first real token, which is after that JSDoc.
    // With no JSDoc the two anchors coincide, and two zero-length edits
    // at one offset have no defined order — so that case is one edit.
    const withJsDoc = constructor.getStart(sourceFile, true);
    const firstToken = constructor.getStart(sourceFile);
    const ACCESSIBILITY = new Set<ts.SyntaxKind>([
      ts.SyntaxKind.PublicKeyword,
      ts.SyntaxKind.PrivateKeyword,
      ts.SyntaxKind.ProtectedKeyword,
    ]);
    const existing = (constructor.modifiers ?? []).find((m) => ACCESSIBILITY.has(m.kind));
    if (existing) {
      push(declarationPath, {
        range: { start: at(withJsDoc), end: at(withJsDoc) },
        newText: factory,
      });
      push(declarationPath, {
        range: { start: at(existing.getStart(sourceFile)), end: at(existing.getEnd()) },
        newText: visibility,
      });
    } else if (withJsDoc === firstToken) {
      push(declarationPath, {
        range: { start: at(withJsDoc), end: at(withJsDoc) },
        newText: `${factory}${visibility} `,
      });
    } else {
      push(declarationPath, {
        range: { start: at(withJsDoc), end: at(withJsDoc) },
        newText: factory,
      });
      push(declarationPath, {
        range: { start: at(firstToken), end: at(firstToken) },
        newText: `${visibility} `,
      });
    }

    const siteRecords: ConstructionSite[] = [];
    for (const site of sites) {
      const file = path.resolve(site.node.getSourceFile().fileName);
      const siteFile = site.node.getSourceFile();
      // `new ns.C()` reaches the class through a qualified name, so the
      // node to replace is the whole access rather than the identifier.
      const receiverNode = readExpression(site.node);
      const expression = receiverNode.parent;
      if (!expression || !ts.isNewExpression(expression)) {
        throw new Error(
          `${className} is constructed at ${locationOf(siteFile, site.offset)} in a form this ` +
            'cannot rewrite (a parenthesized or computed constructor reference). Closing the ' +
            'constructor while leaving that site is not something to do quietly.',
        );
      }

      // Rewrite only `new C` and leave `<T>(…)` exactly as written.
      //
      // Rebuilding the argument list from each argument's own text was
      // the first attempt, and it silently dropped every comment sitting
      // between arguments — including a `// @ts-expect-error`, whose
      // loss brought back the error it was suppressing. That is real
      // code in a real corpus, and it is a whole class of damage
      // (directives, `prettier-ignore`, explanatory notes) avoided
      // entirely by not reconstructing text the edit has no reason to
      // touch.
      const receiver = receiverNode.getText(siteFile);
      if (expression.arguments === undefined) {
        // `new C` with no argument list is still a construction, and the
        // factory has to be called.
        push(file, {
          range: {
            start: siteFile.getLineAndCharacterOfPosition(expression.getStart(siteFile)),
            end: siteFile.getLineAndCharacterOfPosition(expression.getEnd()),
          },
          newText: `${receiver}.${factoryName}()`,
        });
      } else {
        push(file, {
          range: {
            start: siteFile.getLineAndCharacterOfPosition(expression.getStart(siteFile)),
            end: siteFile.getLineAndCharacterOfPosition(receiverNode.getEnd()),
          },
          newText: `${receiver}.${factoryName}`,
        });
      }
      siteRecords.push({ file, line: site.line, character: site.character });
    }

    const warnings: string[] = [];
    if (subclasses.length > 0) {
      warnings.push(
        `${className} is extended by ${subclasses.join(', ')}, so the constructor is ` +
          '`protected` rather than `private` — `super(...)` still reaches it, and so does any ' +
          'subclass anyone adds later.',
      );
    }
    const exported = (declaration.modifiers ?? []).some(
      (m) => m.kind === ts.SyntaxKind.ExportKeyword,
    );
    if (exported) {
      warnings.push(
        `${path.relative(session.rootPath, sourceFile.fileName)} exports ${className}; consumers ` +
          'outside this project still call `new` on it, and that stops compiling for them.',
      );
    }

    const edit: WorkspaceEdit = { changes };
    const filesChanged = filesTouched(edit);
    const newDiagnostics = (await diagnosticsIntroducedBy(session, edit)).map((d) => d.text);
    const output = {
      edit,
      filesChanged,
      newDiagnostics,
      warnings,
      factory: factoryName,
      visibility,
      sites: siteRecords,
    };

    if (input.apply !== true || newDiagnostics.length > 0) {
      return { applied: false, ...output };
    }
    const written = await applyWorkspaceEdit(edit);
    session.invalidate(written);
    return { applied: true, ...output };
  },
};

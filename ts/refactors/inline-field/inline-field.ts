import path from 'node:path';
import ts from 'typescript';
import { applyWorkspaceEdit } from '../../../core/edits/index.js';
import type { Position, TextEdit, Tool, WorkspaceEdit } from '../../../core/tool/index.js';
import { memberHierarchy } from '../../ast/hierarchy.js';
import {
  declarationAt,
  resolveMemberTarget,
  SYMBOL_TARGET_PROPERTIES,
} from '../../ast/targets.js';
import type { TsProjectSession } from '../../project/index.js';
import { diagnosticsIntroducedBy } from '../guard.js';
import { removalSpans } from '../layout.js';
import { filesTouched, refactorOutputSchema, type RefactorOutput } from '../output.js';
import { classifyReferences, isUse, isWrite } from '../references.js';
import { describeReferences, locationOf } from '../signatures.js';
import {
  allocates,
  effectsBetween,
  isEffectfulNode,
  pathToDeclaration,
  readExpression,
  readsProperty,
  reassignedNames,
  repeatsOrSkips,
  usesReceiver,
} from '../stability.js';
import {
  captureConflicts,
  mayHaveEffects,
  needsParentheses,
  substituteExpression,
} from '../substitution.js';

/**
 * Replaces every read of a never-reassigned class property with its
 * initializer and deletes the property — ReSharper's Inline Field.
 *
 * TypeScript ships no refactoring for this, and the reason the local
 * case (`inline-variable`) does not cover it is that a field read has a
 * *receiver*. That one difference is where all the new hazards live:
 *
 * - `makeThing().size` replaced by the initializer drops the
 *   `makeThing()` call entirely. The property access was the only thing
 *   keeping that expression alive, and nothing about the result's type
 *   changes, so the guard sees a clean compile.
 * - An instance initializer that reads `this` means *this instance*.
 *   Inlined at `other.size` it reads the wrong object, or at a
 *   module-level read it does not compile — only the first of those is
 *   dangerous, and only the first is silent.
 * - A subclass redeclaring the property, or a base declaring it, means
 *   the read resolves by the receiver's runtime type. Substituting one
 *   declaration's initializer answers for all of them.
 * - Field initializers run in declaration order inside the constructor,
 *   so an initializer reading another field is order-dependent in a way
 *   a read site is not.
 *
 * What it shares with `inline-variable` is everything else, which is why
 * both are built on `stability.ts`: a call or an allocation duplicated
 * across reads, a name that resolves differently at a read, a name
 * assigned somewhere between. None of those shows up as a diagnostic.
 */

export interface InlineFieldInput {
  /** Property to inline, by name. */
  symbol?: string;
  /** Class the property is declared on, when the name is not unique. */
  class?: string;
  file?: string;
  line?: number;
  character?: number;
  apply?: boolean;
}

export interface ReadSite extends Position {
  file: string;
}

export interface InlineFieldOutput extends RefactorOutput {
  /** Every read the edit replaces. */
  readSites: ReadSite[];
  /** The initializer that was substituted, as written. */
  value: string;
}

/** Reference kinds that read the value and can take an expression. */
const READING: ReadonlySet<string> = new Set([
  'read',
  'destructure-read',
  'direct-call',
  'new',
  'spread-call',
]);

/**
 * The receiver a read is reached through, or undefined when the read is
 * a bare identifier — which for a property means a shorthand or an
 * unqualified name inside the class body.
 */
function receiverOf(site: ts.Node): ts.Expression | undefined {
  const parent = site.parent as ts.Node | undefined;
  if (parent && ts.isPropertyAccessExpression(parent) && parent.name === site) {
    return parent.expression;
  }
  if (parent && ts.isElementAccessExpression(parent) && parent.argumentExpression === site) {
    return parent.expression;
  }
  return undefined;
}

/**
 * Whether evaluating the receiver is itself observable.
 *
 * `cache.value` is free to drop; `load().value` is not, and dropping it
 * is invisible to a typecheck because the property's type is all the
 * expression contributed.
 */
function receiverHasEffects(receiver: ts.Expression): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (isEffectfulNode(node)) {
      found = true;
      return;
    }
    node.forEachChild(visit);
  };
  visit(receiver);
  return found || isEffectfulNode(receiver);
}

/** Whether a read's receiver is `this`, the only one an instance initializer can follow. */
function readsThroughThis(site: ts.Node): boolean {
  const receiver = receiverOf(site);
  return receiver === undefined || receiver.kind === ts.SyntaxKind.ThisKeyword;
}

/** The class or interface a member is declared on. */
function containerOf(declaration: ts.Node): ts.ClassLikeDeclaration | undefined {
  const parent = declaration.parent as ts.Node | undefined;
  return parent && ts.isClassLike(parent) ? parent : undefined;
}

function hasModifier(node: ts.PropertyDeclaration, kind: ts.SyntaxKind): boolean {
  return (node.modifiers ?? []).some((modifier) => modifier.kind === kind);
}

export const inlineField: Tool<InlineFieldInput, InlineFieldOutput, TsProjectSession> = {
  name: 'ts/refactors/inline-field',
  description:
    "Replaces every read of a class property with its initializer and deletes it — ReSharper's " +
    'Inline Field. Targets the property by name (symbol, optionally with class) or exact ' +
    'position, and follows it into every module that reads it, removing the whole declaration. ' +
    'Parentheses come from the compiler and are decided by the operand position the read sat ' +
    'in. Refuses a property that is assigned anywhere, including in a constructor, since its ' +
    'reads are then not all its initializer; one declared or overridden anywhere else in the ' +
    'hierarchy, where the read resolves by the receiver at runtime; a read through a receiver ' +
    'that does something observable, because the access is what keeps that call alive; an ' +
    'initializer reading `this` at any read not reached through `this`; a `declare`, `abstract`, ' +
    'decorated, or uninitialized property; and — as inline-variable does — an initializer that ' +
    'calls, allocates, or reads a property unless there is exactly one read, reached without a ' +
    'branch or a loop and with nothing observable evaluated in between. Dry-run by default.',
  inputSchema: {
    type: 'object',
    properties: {
      ...SYMBOL_TARGET_PROPERTIES,
      class: { type: 'string', description: 'Class the property is declared on' },
      apply: { type: 'boolean', description: 'Write the edit to disk (default false)' },
    },
    additionalProperties: false,
  },
  outputSchema: refactorOutputSchema(
    {
      readSites: {
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
      value: { type: 'string' },
    },
    ['readSites', 'value'],
  ),

  async run(session, input) {
    const target = resolveMemberTarget(session, input);
    const declaration = declarationAt(target);
    if (!ts.isPropertyDeclaration(declaration)) {
      throw new Error(
        `${target.file}:${target.position.line + 1} is not a class property — inline-variable ` +
          'covers `const` bindings and inline-function covers methods',
      );
    }
    const declarationFile = declaration.getSourceFile();
    if (declarationFile.isDeclarationFile) {
      throw new Error('A declaration file states a type and holds no initializer to inline');
    }
    const container = containerOf(declaration);
    if (!container) {
      throw new Error('The property is not declared on a class');
    }
    if (!ts.isIdentifier(declaration.name) && !ts.isPrivateIdentifier(declaration.name)) {
      throw new Error(
        'The property has a computed name, so what it is read as is not decided statically',
      );
    }
    const name = declaration.name.text;
    const className = container.name?.text ?? '(anonymous class)';

    if (hasModifier(declaration, ts.SyntaxKind.DeclareKeyword)) {
      throw new Error(`"${className}.${name}" is \`declare\`d, so it has no initializer here`);
    }
    if (hasModifier(declaration, ts.SyntaxKind.AbstractKeyword)) {
      throw new Error(
        `"${className}.${name}" is abstract — it states a shape that subclasses fill in, and ` +
          'holds no value of its own',
      );
    }
    if (ts.getDecorators(declaration)?.length) {
      throw new Error(
        `"${className}.${name}" is decorated. A decorator observes the property at class ` +
          'definition time, so removing the property changes what runs, and nothing about that ' +
          'is visible to a typecheck.',
      );
    }

    const initializer = declaration.initializer;
    if (!initializer) {
      throw new Error(
        `"${className}.${name}" has no initializer, so there is nothing to substitute. A field ` +
          'assigned in the constructor holds a different value per instance.',
      );
    }

    // A property declared or overridden elsewhere in the hierarchy is
    // resolved by the receiver's runtime type, so one initializer is not
    // the answer for every read.
    const hierarchy = memberHierarchy(session, declaration);
    if (hierarchy.unresolved.length > 0) {
      throw new Error(
        `"${className}"'s hierarchy cannot be resolved (${hierarchy.unresolved.join(', ')}), so ` +
          'whether this property is declared elsewhere too is unknown',
      );
    }
    const elsewhere = [...hierarchy.supertypes, ...hierarchy.subtypes];
    if (elsewhere.length > 0) {
      throw new Error(
        `"${name}" is also declared on ${[...new Set(elsewhere.map((d) => d.container))].join(', ')}. ` +
          'Which declaration a read gets is decided by the receiver at runtime, so substituting ' +
          "this one's initializer answers for objects it does not describe.",
      );
    }

    const references = classifyReferences(session, target.file, target.offset);
    const writes = references.filter(isWrite);
    if (writes.length > 0) {
      throw new Error(
        `"${className}.${name}" is assigned after it is initialized, so its reads are not all ` +
          `its initializer:\n  ${describeReferences(writes)}`,
      );
    }
    const reads = references.filter((reference) => READING.has(reference.kind));
    const unusable = references.filter(isUse).filter((reference) => !READING.has(reference.kind));
    if (unusable.length > 0) {
      throw new Error(
        `"${className}.${name}" is used where an expression cannot go — a type query, or a ` +
          `position that names the property rather than reading it:\n  ${describeReferences(unusable)}`,
      );
    }
    if (reads.length === 0) {
      throw new Error(
        `Nothing reads "${className}.${name}", so there is nothing to inline into. Delete it.`,
      );
    }

    // The access is what keeps the receiver's evaluation alive. Replace
    // it with the initializer and the call the receiver made is gone,
    // with the same type at the same place and no diagnostic.
    const effectful = reads.filter((read) => {
      const receiver = receiverOf(read.node);
      return receiver !== undefined && receiverHasEffects(receiver);
    });
    if (effectful.length > 0) {
      throw new Error(
        `"${className}.${name}" is read through a receiver that does something observable:\n  ` +
          `${describeReferences(effectful)}\nThe property access is the only thing evaluating ` +
          'that expression, so inlining would drop it.',
      );
    }

    const checker = session.checker();
    const volatile =
      mayHaveEffects(initializer) || allocates(initializer) || readsProperty(checker, initializer);
    if (volatile) {
      const why = mayHaveEffects(initializer)
        ? 'could do something observable'
        : allocates(initializer)
          ? 'builds a new object every time it is evaluated'
          : 'reads a property, which may hold something else by then';
      if (reads.length > 1) {
        throw new Error(
          `The initializer of "${className}.${name}" ${why}, and it is read ` +
            `${String(reads.length)} times — inlining would evaluate it once per read:\n  ` +
            describeReferences(reads),
        );
      }
      const read = reads[0]!;
      if (path.resolve(read.file) !== path.resolve(declarationFile.fileName)) {
        throw new Error(
          `The initializer of "${className}.${name}" ${why}, and its only read is in another ` +
            'module, where when it runs relative to this one is a fact about module loading order',
        );
      }
      const { between, common } = pathToDeclaration(read.node, declaration);
      if (!common || repeatsOrSkips(between)) {
        throw new Error(
          `The initializer of "${className}.${name}" ${why}, and the read at ` +
            `${locationOf(declarationFile, read.offset)} sits behind a branch, a loop or a ` +
            'nested function — inlining would change how many times it happens',
        );
      }
      if (effectsBetween(common, declaration.getEnd(), read.node.getStart())) {
        throw new Error(
          `The initializer of "${className}.${name}" ${why}, and something else observable is ` +
            `evaluated before the read at ${locationOf(declarationFile, read.offset)} — ` +
            'inlining would reorder the two',
        );
      }
    }

    // An instance initializer reading `this` describes one object. A
    // static one reads the class, which every `Class.name` read reaches
    // the same way, so only the instance case is constrained.
    const isStatic = hasModifier(declaration, ts.SyntaxKind.StaticKeyword);
    if (usesReceiver(initializer) && !isStatic) {
      const foreign = reads.filter((read) => !readsThroughThis(read.node));
      if (foreign.length > 0) {
        throw new Error(
          `The initializer of "${className}.${name}" reads \`this\`, which means the instance it ` +
            `was declared on. These reads are through another object:\n  ${describeReferences(foreign)}`,
        );
      }
    }

    const unstable = reassignedNames(session, initializer);
    if (unstable.length > 0) {
      throw new Error(
        `The initializer of "${className}.${name}" reads ` +
          `${unstable.map((n) => `"${n}"`).join(', ')}, which ` +
          `${unstable.length === 1 ? 'is' : 'are'} assigned elsewhere — a read would get ` +
          'whatever it holds then, not what it held here. Both compile.',
      );
    }

    const warnings: string[] = [];
    if (declaration.type) {
      const declared = checker.getTypeAtLocation(declaration.name);
      const actual = checker.getTypeAtLocation(initializer);
      if (declared !== actual) {
        warnings.push(
          `"${className}.${name}" is annotated \`${declaration.type.getText(declarationFile)}\` ` +
            `and its initializer's own type is \`${checker.typeToString(actual)}\`. A read was ` +
            'typed by the annotation and the expression replacing it is not, which can change an ' +
            'overload choice or a contextual type without changing whether it compiles.',
        );
      }
    }
    if (!hasModifier(declaration, ts.SyntaxKind.PrivateKeyword) && !ts.isPrivateIdentifier(declaration.name)) {
      warnings.push(
        `"${name}" was part of ${className}'s public shape; removing it is a change consumers ` +
          'outside this project would notice.',
      );
    }

    // One substitution serves every read: with no parameters to bind,
    // what changes between sites is only whether it needs wrapping.
    const substituted = substituteExpression(initializer, declarationFile, new Map());

    const changes: Record<string, TextEdit[]> = {};
    const readSites: ReadSite[] = [];
    for (const read of reads) {
      const sourceFile = read.node.getSourceFile();

      // Every name the initializer depends on has to still mean the same
      // thing here. One that resolves to a different symbol compiles and
      // silently computes something else — the failure the guard is
      // blind to, and the reason this runs before the edit is built.
      const conflicts = captureConflicts(checker, initializer, read.node, new Set());
      if (conflicts.length > 0) {
        const missing = conflicts.filter((conflict) => conflict.reason === 'missing');
        const shadowed = conflicts.filter((conflict) => conflict.reason === 'different');
        throw new Error(
          `The initializer of "${className}.${name}" cannot be evaluated at ` +
            `${locationOf(sourceFile, read.offset)}: ` +
            [
              missing.length > 0
                ? `${missing.map((c) => `"${c.name}"`).join(', ')} ${missing.length === 1 ? 'is' : 'are'} not in scope there`
                : '',
              shadowed.length > 0
                ? `${shadowed.map((c) => `"${c.name}"`).join(', ')} ${shadowed.length === 1 ? 'means' : 'mean'} something different there`
                : '',
            ]
              .filter(Boolean)
              .join('; '),
        );
      }

      const site = readExpression(read.node);
      const inlined = needsParentheses(substituted.expression, site)
        ? `(${substituted.text})`
        : substituted.text;

      const file = path.resolve(sourceFile.fileName);
      changes[file] = [
        ...(changes[file] ?? []),
        {
          range: {
            start: sourceFile.getLineAndCharacterOfPosition(site.getStart(sourceFile)),
            end: sourceFile.getLineAndCharacterOfPosition(site.getEnd()),
          },
          newText: inlined,
        },
      ];
      readSites.push({ file, line: read.line, character: read.character });
    }

    const declarationPath = path.resolve(declarationFile.fileName);
    const at = (offset: number) => declarationFile.getLineAndCharacterOfPosition(offset);
    changes[declarationPath] = [
      ...(changes[declarationPath] ?? []),
      ...removalSpans(declarationFile, [declaration]).map((span) => ({
        range: { start: at(span.start), end: at(span.end) },
        newText: '',
      })),
    ];

    const edit: WorkspaceEdit = { changes };
    const filesChanged = filesTouched(edit);
    const newDiagnostics = (await diagnosticsIntroducedBy(session, edit)).map((d) => d.text);
    const output = {
      edit,
      filesChanged,
      newDiagnostics,
      warnings,
      readSites,
      value: initializer.getText(declarationFile),
    };

    if (input.apply !== true || newDiagnostics.length > 0) {
      return { applied: false, ...output };
    }
    const written = await applyWorkspaceEdit(edit);
    session.invalidate(written);
    return { applied: true, ...output };
  },
};

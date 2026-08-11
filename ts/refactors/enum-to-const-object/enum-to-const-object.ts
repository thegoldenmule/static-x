import path from 'node:path';
import ts from 'typescript';
import { applyWorkspaceEdit } from '../../../core/edits/index.js';
import type { Tool, WorkspaceEdit } from '../../../core/tool/index.js';
import { declarationAt, resolveTarget, SYMBOL_TARGET_PROPERTIES } from '../../ast/targets.js';
import type { TsProjectSession } from '../../project/index.js';
import { diagnosticsIntroducedBy } from '../guard.js';
import { filesTouched, refactorOutputSchema, type RefactorOutput } from '../output.js';
import { classifyReferences, type ClassifiedReference } from '../references.js';

/**
 * Replaces an `enum` with an `as const` object plus a type alias of the
 * same name — ReSharper's "convert to scoped enum", as far as it
 * translates.
 *
 * The C++ refactoring makes enumerators require qualification and stop
 * converting to `int`. TypeScript members are already qualified, so the
 * transferable half is the strictness, and the modern TypeScript answer
 * is a different declaration form:
 *
 *     enum Color { Red = 'red', Blue = 'blue' }
 *     const Color = { Red: 'red', Blue: 'blue' } as const;
 *     type Color = (typeof Color)[keyof typeof Color];
 *
 * The value and the type share a name — legal, and the whole point:
 * `Color.Red` and `let c: Color` keep meaning what they meant, in every
 * file, through every barrel, with no use site edited.
 *
 * What the form cannot express is what this tool spends its length
 * refusing. Two of those refusals matter more than the rest because the
 * compiler will not make them for you: a numeric enum's reverse mapping
 * read through a non-literal key is `any` under a loose tsconfig, so
 * the edit silently returns `undefined` at runtime; and the loss of
 * nominality only ever *removes* errors, which a guard that compares
 * diagnostics before and after is structurally unable to see.
 */

export interface EnumToConstObjectInput {
  symbol?: string;
  file?: string;
  line?: number;
  character?: number;
  apply?: boolean;
}

export interface ConstMember {
  /** The member name, unquoted. */
  name: string;
  /** The value as it is written in the emitted object literal. */
  value: string;
}

export interface EnumToConstObjectOutput extends RefactorOutput {
  /** The members, in declaration order, with the values written out. */
  members: ConstMember[];
}

/** The literal text of a member's value, or undefined when it is computed. */
function literalValue(
  member: ts.EnumMember,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
): string | undefined {
  const initializer = member.initializer;
  if (!initializer) {
    // Auto-numbering: the value exists only in the checker.
    const constant = checker.getConstantValue(member);
    return typeof constant === 'number' ? String(constant) : undefined;
  }
  if (ts.isStringLiteral(initializer) || ts.isNumericLiteral(initializer)) {
    return initializer.getText(sourceFile);
  }
  // `enum E { A = -1 }` is a literal with a sign, not an expression.
  if (
    ts.isPrefixUnaryExpression(initializer) &&
    initializer.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(initializer.operand)
  ) {
    return initializer.getText(sourceFile);
  }
  return undefined;
}

/** A member's name unquoted: `'a-b' = 'x'` is the key `a-b`. */
function memberName(member: ts.EnumMember, sourceFile: ts.SourceFile): string {
  return ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)
    ? member.name.text
    : member.name.getText(sourceFile);
}

/** `Color['Red']` — a forward read a plain object serves identically. */
function readsALiteralMember(
  access: ts.ElementAccessExpression,
  names: ReadonlySet<string>,
): boolean {
  const argument = access.argumentExpression;
  return ts.isStringLiteral(argument) && names.has(argument.text);
}

/**
 * The element access this reference is the object of, when the key is
 * not the literal name of a member.
 *
 * For a numeric enum that is the reverse mapping — `Rank[0]` is
 * `'Bronze'` because the emitted object holds both directions — and no
 * const object has it. It is worth finding here rather than leaving to
 * the compile guard: under `noImplicitAny` the converted form is
 * TS7053, but with `strict` off the same expression is `any`, compiles
 * clean, and evaluates to `undefined`.
 */
function nonMemberAccess(
  reference: ClassifiedReference,
  names: ReadonlySet<string>,
): ts.ElementAccessExpression | undefined {
  const parent = reference.node.parent as ts.Node | undefined;
  if (!parent || !ts.isElementAccessExpression(parent)) return undefined;
  if (parent.expression !== reference.node) return undefined;
  return readsALiteralMember(parent, names) ? undefined : parent;
}

/**
 * Whether the reference is the left of a qualified name in a type —
 * `kind: Shape.Circle`. An enum opens a type namespace; a const object
 * does not, so the member type has to be respelled `typeof Shape.Circle`
 * by hand. `typeof Shape.Circle` itself is already fine and is excluded.
 */
function isMemberTypeUse(reference: ClassifiedReference): boolean {
  const parent = reference.node.parent as ts.Node | undefined;
  if (!parent || !ts.isQualifiedName(parent) || parent.left !== reference.node) return false;
  for (let current: ts.Node | undefined = parent.parent; current; current = current.parent) {
    if (ts.isTypeQueryNode(current)) return false;
    if (ts.isTypeNode(current)) break;
  }
  return true;
}

/** Whether the reference hands the enum object itself to something. */
function isObjectEscape(reference: ClassifiedReference): boolean {
  if (reference.kind !== 'read') return false;
  const parent = reference.node.parent as ts.Node | undefined;
  if (!parent) return false;
  const reaches =
    (ts.isPropertyAccessExpression(parent) && parent.expression === reference.node) ||
    (ts.isElementAccessExpression(parent) && parent.expression === reference.node);
  return !reaches;
}

function shortLocation(session: TsProjectSession, reference: ClassifiedReference): string {
  return `${path.relative(session.rootPath, reference.file)}:${reference.line + 1}:${reference.character + 1}`;
}

/** The indentation of the line the declaration starts on. */
function indentAt(sourceFile: ts.SourceFile, offset: number): string {
  const text = sourceFile.getFullText();
  let lineStart = offset;
  while (lineStart > 0 && text[lineStart - 1] !== '\n') lineStart--;
  const prefix = text.slice(lineStart, offset);
  return /^\s*$/.test(prefix) ? prefix : '';
}

/**
 * The object literal's body: the enum's own body with each member's
 * `Name = value` rewritten to `Name: value`, and every other character
 * — comments, blank lines, indentation, the trailing comma or its
 * absence — carried across untouched. Reconstructing the body instead
 * would silently drop a member's doc comment.
 */
function objectBody(
  declaration: ts.EnumDeclaration,
  sourceFile: ts.SourceFile,
  values: readonly string[],
): string {
  const text = sourceFile.getFullText();
  const children = declaration.getChildren(sourceFile);
  const open = children.find((child) => child.kind === ts.SyntaxKind.OpenBraceToken);
  const close = children.find((child) => child.kind === ts.SyntaxKind.CloseBraceToken);
  if (!open || !close) throw new Error(`"${declaration.name.text}" has no enum body to convert`);

  const pieces: string[] = [];
  let cursor = open.getEnd();
  for (const [index, member] of declaration.members.entries()) {
    pieces.push(text.slice(cursor, member.getStart(sourceFile)));
    pieces.push(`${member.name.getText(sourceFile)}: ${values[index]!}`);
    cursor = member.getEnd();
  }
  pieces.push(text.slice(cursor, close.getStart(sourceFile)));
  return pieces.join('');
}

export const enumToConstObject: Tool<
  EnumToConstObjectInput,
  EnumToConstObjectOutput,
  TsProjectSession
> = {
  name: 'ts/refactors/enum-to-const-object',
  description:
    'Replaces an enum declaration with an `as const` object and a type alias of the same name: ' +
    "enum Color { Red = 'red' } becomes const Color = { Red: 'red' } as const; type Color = " +
    '(typeof Color)[keyof typeof Color]. A value and a type may share a name, so Color.Red and ' +
    'let c: Color keep working at every use site, through every barrel, with no other file ' +
    'edited — what goes away is the reverse mapping, the numeric assignability, and the runtime ' +
    'enum object, which is what erasableSyntaxOnly and isolatedModules projects need. Targets ' +
    'the enum by name (symbol) or exact position. Refuses a const enum (it has no runtime object ' +
    'and inlining is its purpose), an ambient enum, a declaration-merged enum, a member whose ' +
    'initializer is not a literal (keeping it widens the member to number under as const, and ' +
    'folding it discards the expression), a reverse-mapping or dynamic access like ' +
    'Rank[value], and a member used as a type like kind: ' +
    'Shape.Circle. A numeric enum used where a number is expected — the bit-flag idiom Flags.Read ' +
    '| Flags.Write — is refused by the compile guard, which reports the assignment TypeScript ' +
    'permits for enums and not for a union of literals. warnings always report the loss of ' +
    'nominality, which the guard cannot see because it only removes errors. Dry-run by default.',
  inputSchema: {
    type: 'object',
    properties: {
      ...SYMBOL_TARGET_PROPERTIES,
      symbol: { type: 'string', description: 'Enum name to target' },
      apply: { type: 'boolean', description: 'Write the edit to disk (default false)' },
    },
    additionalProperties: false,
  },
  outputSchema: refactorOutputSchema(
    {
      members: {
        type: 'array',
        description: 'The converted members, in declaration order',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            value: { type: 'string', description: 'As written in the emitted object literal' },
          },
          required: ['name', 'value'],
        },
      },
    },
    ['members'],
  ),

  async run(session, input) {
    const target = resolveTarget(session, input);
    const declaration = declarationAt(target);
    if (!ts.isEnumDeclaration(declaration)) {
      throw new Error(
        `${target.file}:${target.position.line + 1} is a ${ts.SyntaxKind[declaration.kind]}, not an enum`,
      );
    }
    const name = declaration.name.text;
    const sourceFile = declaration.getSourceFile();
    const modifiers = ts.getCombinedModifierFlags(declaration);

    if ((modifiers & ts.ModifierFlags.Const) !== 0) {
      throw new Error(
        `"${name}" is a const enum, which has no runtime object to convert: its members are ` +
          'inlined at every use, and that is the reason to write one. Drop the `const` first if ' +
          'the inlining is not wanted.',
      );
    }
    if ((modifiers & ts.ModifierFlags.Ambient) !== 0 || sourceFile.isDeclarationFile) {
      throw new Error(
        `"${name}" is ambient: it declares an enum that something else creates, so replacing it ` +
          'with a const object would assert a runtime shape this project does not build.',
      );
    }

    const checker = session.checker();
    const symbol = checker.getSymbolAtLocation(declaration.name);
    const merged = (symbol?.declarations ?? []).filter((node) => node !== declaration);
    if (merged.length > 0) {
      const where = merged
        .map((node) => {
          const file = node.getSourceFile();
          const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
          return `${path.relative(session.rootPath, file.fileName)}:${line + 1} (${ts.SyntaxKind[node.kind]})`;
        })
        .join(', ');
      throw new Error(
        `"${name}" is declaration-merged with ${where}. A const and a type alias declare one ` +
          'thing each and merge with nothing, so the other declarations would become redeclarations.',
      );
    }

    if (declaration.members.length === 0) {
      throw new Error(`"${name}" has no members, so the converted type would be \`never\``);
    }

    const values: string[] = [];
    const computed: string[] = [];
    for (const member of declaration.members) {
      const value = literalValue(member, sourceFile, checker);
      if (value === undefined) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(member.getStart(sourceFile));
        computed.push(`${member.name.getText(sourceFile)} at line ${line + 1}`);
        values.push('');
      } else {
        values.push(value);
      }
    }
    if (computed.length > 0) {
      // There are two ways to convert one of these and both are worse
      // than refusing. Keeping the expression widens the member, since
      // `as const` narrows literals only: `{ Large: base * 2 } as
      // const` is `number`, so the union type stops naming the members
      // and the strictness this refactoring exists for is gone.
      // Folding it to the constant the checker computed keeps the type
      // narrow but rewrites the source into a value, cutting the link
      // to whatever the author derived it from.
      throw new Error(
        `"${name}" has members whose initializer is not a literal: ${computed.join(', ')}. ` +
          'Keeping the expression widens the member — `{ Large: base * 2 } as const` is ' +
          '`number`, not `4` — and folding it to the value the checker computed would cut the ' +
          "member's link to what it was derived from. Neither is a change to make on your behalf.",
      );
    }

    const memberNames = new Set(
      declaration.members.map((member) => memberName(member, sourceFile)),
    );
    const references = classifyReferences(session, sourceFile.fileName, target.offset);

    const reverse = references.flatMap((reference) => {
      const access = nonMemberAccess(reference, memberNames);
      return access
        ? [`${shortLocation(session, reference)} — ${access.getText(access.getSourceFile())}`]
        : [];
    });
    if (reverse.length > 0) {
      throw new Error(
        `"${name}" is read through a key that is not a member name, which only the enum's ` +
          `runtime object answers:\n  ${reverse.join('\n  ')}\n` +
          "A numeric enum's emitted object holds both directions, name to value and value back " +
          'to name; a const object holds the forward one only. Under noImplicitAny the converted ' +
          'read is TS7053, but with strict off it is `any`, compiles clean, and is undefined at ' +
          'runtime — so the compile guard would not always repeat this refusal.',
      );
    }

    const memberTypes = references
      .filter((reference) => isMemberTypeUse(reference))
      .map((reference) => `${shortLocation(session, reference)} — ${reference.node.parent.getText()}`);
    if (memberTypes.length > 0) {
      throw new Error(
        `"${name}" has members used as types, which needs an enum's type namespace:\n  ` +
          `${memberTypes.join('\n  ')}\n` +
          `Respell each as \`typeof ${name}.Member\` first; that form survives the conversion.`,
      );
    }

    const warnings = [
      `An enum type is nominal: only ${name}'s own members were assignable to ${name}. The ` +
        'converted type is a union of literals, so a bare literal — or a member of another enum ' +
        'with the same value — now typechecks where it did not. The compile guard cannot see ' +
        'this: it reports diagnostics the edit introduces, and this edit only removes them.',
    ];
    // The emitter gives a numeric member two entries, `A -> 0` and
    // `0 -> "A"`; a string member gets one. So the runtime key count
    // changes for exactly the numeric ones, and nothing typechecked
    // observes it.
    const numeric = declaration.members.filter(
      (member) => typeof checker.getConstantValue(member) === 'number',
    ).length;
    if (numeric > 0) {
      const escapes = references
        .filter((reference) => isObjectEscape(reference))
        .map((reference) => shortLocation(session, reference));
      warnings.push(
        `${name} has ${numeric} numeric member${numeric === 1 ? '' : 's'}, so its runtime ` +
          `object also held the reverse mapping: Object.keys(${name}) returned ` +
          `${declaration.members.length + numeric} entries, the names and the numbers, and the ` +
          `const object returns ${declaration.members.length}` +
          (escapes.length > 0
            ? `. These read the object itself: ${escapes.join(', ')}.`
            : '. Nothing in this project reads the object itself, but a JavaScript caller or a ' +
              'reflective read outside the compilation would see the difference.'),
      );
    }

    const exported = (modifiers & ts.ModifierFlags.Export) !== 0 ? 'export ' : '';
    const indent = indentAt(sourceFile, declaration.getStart(sourceFile));
    const body = objectBody(declaration, sourceFile, values);
    const newText =
      `${exported}const ${name} = {${body}} as const;\n` +
      `${indent}${exported}type ${name} = (typeof ${name})[keyof typeof ${name}];`;

    const file = path.resolve(sourceFile.fileName);
    const edit: WorkspaceEdit = {
      changes: {
        [file]: [
          {
            range: {
              start: sourceFile.getLineAndCharacterOfPosition(declaration.getStart(sourceFile)),
              end: sourceFile.getLineAndCharacterOfPosition(declaration.getEnd()),
            },
            newText,
          },
        ],
      },
    };

    const members: ConstMember[] = declaration.members.map((member, index) => ({
      name: memberName(member, sourceFile),
      value: values[index]!,
    }));
    const filesChanged = filesTouched(edit);
    const newDiagnostics = (await diagnosticsIntroducedBy(session, edit)).map((d) => d.text);
    const output = { edit, filesChanged, newDiagnostics, warnings, members };

    if (input.apply !== true || newDiagnostics.length > 0) {
      return { applied: false, ...output };
    }
    session.invalidate(await applyWorkspaceEdit(edit));
    return { applied: true, ...output };
  },
};

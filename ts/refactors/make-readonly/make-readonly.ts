import path from 'node:path';
import ts from 'typescript';
import { applyWorkspaceEdit } from '../../../core/edits/index.js';
import type { Tool, WorkspaceEdit } from '../../../core/tool/index.js';
import { declarationAt, resolveTarget, SYMBOL_TARGET_PROPERTIES } from '../../ast/targets.js';
import type { TsProjectSession } from '../../project/index.js';
import { diagnosticsIntroducedBy } from '../guard.js';
import { filesTouched, refactorOutputSchema, type RefactorOutput } from '../output.js';
import { classifyReferences, isWrite, type ClassifiedReference } from '../references.js';
import { toWorkspaceEdit } from '../text-changes.js';

/**
 * Adds `readonly` to a class property nothing writes.
 *
 * This is the one refactoring here whose in-memory typecheck is a
 * complete oracle rather than a backstop. Adding `readonly` to a
 * property that is written produces exactly TS2540 at the offending
 * write, so a mistake in the reference analysis cannot ship a wrong
 * edit — the worst case is a refusal carrying the compiler's own
 * location. The analysis exists to explain the refusal before the
 * compiler proves it, not to be trusted instead of it.
 *
 * ReSharper's version of this is "make auto-property get-only".
 * TypeScript has no auto-properties: there is one member kind, the
 * property declaration, with `readonly`, `private` and `#name` as
 * modifiers on it. So the honest translation adds the modifier — with
 * the caveats in `warnings`, because TypeScript's `readonly` is
 * materially weaker than a get-only property.
 */

export interface MakeReadonlyInput {
  /** Property name; `#field` matches with or without the `#`. */
  symbol?: string;
  /** Declaring class name, when one project holds several matches. */
  class?: string;
  /** Target by position: file plus zero-based line/character. */
  file?: string;
  line?: number;
  character?: number;
  /** Write the edit to disk. Default false: return the edit only. */
  apply?: boolean;
}

/** A write that forbids the modifier, in the compiler's terms. */
export interface BlockingWrite {
  file: string;
  line: number;
  character: number;
  kind: string;
}

/**
 * `writes` is non-empty exactly when the refusal is about assignment:
 * each entry is a place TypeScript would report TS2540, which is also
 * what `newDiagnostics` then carries.
 */
export interface MakeReadonlyOutput extends RefactorOutput {
  writes: BlockingWrite[];
}

/** A class property, including the parameter-property spelling. */
type PropertyTarget = ts.PropertyDeclaration | ts.ParameterPropertyDeclaration;

// prettier-ignore
const ARRAY_MUTATORS: ReadonlySet<string> = new Set([
  'copyWithin', 'fill', 'pop', 'push', 'reverse', 'shift', 'sort', 'splice', 'unshift',
]);
const COLLECTION_MUTATORS: ReadonlySet<string> = new Set(['add', 'clear', 'delete', 'set']);
const COLLECTIONS: ReadonlySet<string> = new Set(['Map', 'Set', 'WeakMap', 'WeakSet']);

const ALWAYS_WARN = [
  'readonly is erased at compile time: the emitted JavaScript carries no such attribute, ' +
    'so a JavaScript caller, Object.assign, or an "as any" cast still writes this property.',
  'Assignability ignores readonly: passing this object where a mutable property is expected ' +
    'typechecks, so writes through that alias are never reported.',
  'readonly is shallow: it forbids replacing the value, not mutating it — ' +
    'readonly items: string[] still permits items.push(...).',
];

function isPropertyTarget(node: ts.Node): node is PropertyTarget {
  return (
    ts.isPropertyDeclaration(node) ||
    (ts.isParameter(node) &&
      node.parent !== undefined &&
      ts.isParameterPropertyDeclaration(node, node.parent))
  );
}

/** The class a property belongs to; for a parameter property, the constructor's. */
function declaringClass(declaration: PropertyTarget): ts.ClassLikeDeclaration {
  return ts.isParameter(declaration) ? declaration.parent.parent : declaration.parent;
}

function classNameOf(declaration: PropertyTarget): string | undefined {
  return declaringClass(declaration).name?.text;
}

function nameOf(declaration: PropertyTarget): string {
  return declaration.name.getText(declaration.getSourceFile());
}

function locate(declaration: PropertyTarget): string {
  const sourceFile = declaration.getSourceFile();
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(
    declaration.name.getStart(sourceFile),
  );
  return `${sourceFile.fileName}:${line + 1}:${character + 1}`;
}

/**
 * Class properties named `symbol`. Unlike the shared declaration
 * search this matches `#field` (a PrivateIdentifier is not an
 * Identifier) and understands the parameter-property spelling, both of
 * which are ordinary properties to this tool.
 */
function findProperties(
  session: TsProjectSession,
  symbol: string,
  fileFilter?: string,
): PropertyTarget[] {
  const unprefixed = (name: string) => (name.startsWith('#') ? name.slice(1) : name);
  const wanted = unprefixed(symbol);
  const found: PropertyTarget[] = [];
  for (const sourceFile of session.sourceFiles()) {
    if (fileFilter && !sourceFile.fileName.endsWith(fileFilter)) continue;
    const visit = (node: ts.Node) => {
      if (
        isPropertyTarget(node) &&
        (ts.isIdentifier(node.name) || ts.isPrivateIdentifier(node.name)) &&
        unprefixed(node.name.text) === wanted
      ) {
        found.push(node);
      }
      node.forEachChild(visit);
    };
    visit(sourceFile);
  }
  return found;
}

function resolveProperty(session: TsProjectSession, input: MakeReadonlyInput): PropertyTarget {
  if (input.symbol !== undefined) {
    const wantedClass = input.class;
    const candidates = findProperties(session, input.symbol, input.file).filter(
      (declaration) => wantedClass === undefined || classNameOf(declaration) === wantedClass,
    );
    if (candidates.length === 0) {
      const scope = wantedClass === undefined ? '' : ` on class ${wantedClass}`;
      throw new Error(`No class property named "${input.symbol}"${scope} found in project`);
    }
    if (candidates.length > 1) {
      const listed = candidates
        .map((c) => `${classNameOf(c) ?? '(anonymous class)'} at ${locate(c)}`)
        .join('\n  ');
      throw new Error(
        `"${input.symbol}" names a property on several classes; disambiguate with class or ` +
          `file/line/character:\n  ${listed}`,
      );
    }
    return candidates[0]!;
  }

  const declaration = declarationAt(resolveTarget(session, input));
  if (!isPropertyTarget(declaration)) {
    throw new Error(
      `readonly applies to class properties; the declaration here is a ` +
        `${ts.SyntaxKind[declaration.kind]}`,
    );
  }
  return declaration;
}

/** The nearest enclosing function, which is what the compiler's own readonly check consults. */
function containingFunction(node: ts.Node): ts.Node | undefined {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isFunctionLike(current)) return current;
  }
  return undefined;
}

/**
 * Whether a write would survive the modifier, mirroring the compiler's
 * `isAssignmentToReadonlyEntity`: only `this.x = ...`, written
 * directly in the constructor of the class that declares `x`. A write
 * inside an arrow function in that constructor is not exempt, and
 * neither is one through any receiver other than `this`.
 */
function isConstructorWrite(reference: ClassifiedReference, declaration: PropertyTarget): boolean {
  const access = reference.node.parent;
  if (!access || !(ts.isPropertyAccessExpression(access) || ts.isElementAccessExpression(access))) {
    return false;
  }
  if (access.expression.kind !== ts.SyntaxKind.ThisKeyword) return false;
  const enclosing = containingFunction(reference.node);
  return (
    enclosing !== undefined &&
    ts.isConstructorDeclaration(enclosing) &&
    enclosing.parent === declaringClass(declaration)
  );
}

function typeText(checker: ts.TypeChecker, type: ts.Type, at: ts.Node): string {
  return checker.typeToString(type, at, ts.TypeFormatFlags.NoTruncation);
}

/**
 * The annotation the modifier forces the tool to write out.
 * `count = 0` is a `number` today only because a mutable property
 * widens its initializer; `readonly count = 0` is the literal type
 * `0`, and the constructor assignment that used to compile becomes
 * TS2322. Naming the widened type keeps the property's public type
 * exactly what it already was.
 */
function widenedAnnotation(
  session: TsProjectSession,
  declaration: PropertyTarget,
): string | undefined {
  if (declaration.type || !declaration.initializer) return undefined;
  const checker = session.checker();
  const initializer = typeText(
    checker,
    checker.getTypeAtLocation(declaration.initializer),
    declaration,
  );
  const widened = typeText(
    checker,
    checker.getWidenedType(checker.getTypeAtLocation(declaration)),
    declaration,
  );
  return initializer === widened ? undefined : widened;
}

function buildEdit(session: TsProjectSession, declaration: PropertyTarget): WorkspaceEdit {
  const sourceFile = declaration.getSourceFile();
  // Before the name, so the modifier lands after accessibility and
  // `static` — the order the grammar requires — and after decorators.
  const changes: ts.TextChange[] = [
    { span: { start: declaration.name.getStart(sourceFile), length: 0 }, newText: 'readonly ' },
  ];
  const annotation = widenedAnnotation(session, declaration);
  if (annotation !== undefined) {
    const afterName = ts.isPropertyDeclaration(declaration)
      ? (declaration.exclamationToken ?? declaration.questionToken ?? declaration.name).getEnd()
      : (declaration.questionToken ?? declaration.name).getEnd();
    changes.push({ span: { start: afterName, length: 0 }, newText: `: ${annotation}` });
  }
  return toWorkspaceEdit(session, [{ fileName: sourceFile.fileName, textChanges: changes }]);
}

/** Mutators for the property's type, when the type is one this tool knows mutates in place. */
function mutatorsFor(checker: ts.TypeChecker, type: ts.Type): ReadonlySet<string> | undefined {
  for (const part of type.isUnion() ? type.types : [type]) {
    if (checker.isArrayType(part) || checker.isTupleType(part)) return ARRAY_MUTATORS;
    const name = part.getSymbol()?.getName();
    if (name !== undefined && COLLECTIONS.has(name)) return COLLECTION_MUTATORS;
  }
  return undefined;
}

/** `x.prop.push(...)` — the method name, when the call mutates the value in place. */
function mutatingCall(
  reference: ClassifiedReference,
  mutators: ReadonlySet<string>,
): string | undefined {
  const access = reference.node.parent;
  if (!access) return undefined;
  const callee = access.parent;
  if (!callee || !ts.isPropertyAccessExpression(callee) || callee.expression !== access) {
    return undefined;
  }
  const call = callee.parent;
  if (!call || !ts.isCallExpression(call) || call.expression !== callee) return undefined;
  return mutators.has(callee.name.text) ? callee.name.text : undefined;
}

function shortLocation(session: TsProjectSession, reference: ClassifiedReference): string {
  const relative = path.relative(session.rootPath, reference.file);
  return `${relative}:${reference.line + 1}:${reference.character + 1}`;
}

export const makeReadonly: Tool<MakeReadonlyInput, MakeReadonlyOutput, TsProjectSession> = {
  name: 'ts/refactors/make-readonly',
  description:
    'Adds the readonly modifier to a class property — including the parameter-property form ' +
    'constructor(private count: number) — when nothing writes it outside the declaring ' +
    "class's constructor. Every reference is classified by parent node, so a destructuring " +
    'read (const { count } = c) is not mistaken for a write. Any other write refuses the ' +
    'edit and is listed in writes with its location and kind. The edit is then typechecked ' +
    'in memory, which is a complete oracle here: a missed write is TS2540 in newDiagnostics ' +
    'and blocks the apply, so a wrong analysis cannot produce a wrong edit. A property with ' +
    'no type annotation gains one (count = 0 becomes readonly count: number = 0) because ' +
    'readonly would otherwise narrow it to the literal type of its initializer. Dry-run by ' +
    'default; apply: true writes to disk. warnings always report what readonly does not ' +
    'do — it is erased at runtime, assignability ignores it, and it does not freeze the ' +
    'value it holds.',
  inputSchema: {
    type: 'object',
    properties: {
      // The shared targeting fields, with symbol narrowed to properties.
      ...SYMBOL_TARGET_PROPERTIES,
      symbol: {
        type: 'string',
        description: 'Property name to target (#field, with or without the #)',
      },
      class: { type: 'string', description: 'Declaring class name, to disambiguate symbol' },
      apply: { type: 'boolean', description: 'Write the edit to disk (default false)' },
    },
    additionalProperties: false,
  },
  outputSchema: refactorOutputSchema({
    writes: {
      type: 'array',
      description: 'Writes that forbid the modifier; empty unless the edit was refused for them',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          line: { type: 'integer' },
          character: { type: 'integer' },
          kind: { type: 'string' },
        },
        required: ['file', 'line', 'character', 'kind'],
      },
    },
  }),
  async run(session, input) {
    const declaration = resolveProperty(session, input);
    const sourceFile = declaration.getSourceFile();
    const name = nameOf(declaration);
    if (declaration.modifiers?.some((m) => m.kind === ts.SyntaxKind.ReadonlyKeyword)) {
      throw new Error(`${name} at ${locate(declaration)} is already readonly`);
    }

    const references = classifyReferences(
      session,
      sourceFile.fileName,
      declaration.name.getStart(sourceFile),
    );
    const writes: BlockingWrite[] = references
      .filter((reference) => isWrite(reference) && !isConstructorWrite(reference, declaration))
      .map((reference) => ({
        file: reference.file,
        line: reference.line,
        character: reference.character,
        kind: reference.kind,
      }))
      .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.character - b.character);

    const warnings = [...ALWAYS_WARN];
    const checker = session.checker();
    const mutators = mutatorsFor(checker, checker.getTypeAtLocation(declaration));
    if (mutators) {
      const calls = references.flatMap((reference) => {
        const method = mutatingCall(reference, mutators);
        return method ? [`${method}() at ${shortLocation(session, reference)}`] : [];
      });
      const held = typeText(checker, checker.getTypeAtLocation(declaration), declaration);
      warnings.push(
        `${name} holds ${held}, which readonly does not freeze` +
          (calls.length > 0
            ? `; these mutations are unaffected by this edit: ${calls.join(', ')}.`
            : '; callers can still mutate it in place.'),
      );
    }

    const edit = buildEdit(session, declaration);
    const filesChanged = filesTouched(edit);
    const newDiagnostics = (await diagnosticsIntroducedBy(session, edit)).map((d) => d.text);

    if (!input.apply || writes.length > 0 || newDiagnostics.length > 0) {
      return { applied: false, edit, filesChanged, newDiagnostics, warnings, writes };
    }
    session.invalidate(await applyWorkspaceEdit(edit));
    return { applied: true, edit, filesChanged, newDiagnostics, warnings, writes };
  },
};

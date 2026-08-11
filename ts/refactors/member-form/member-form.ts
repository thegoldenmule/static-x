import path from 'node:path';
import ts from 'typescript';
import { applyWorkspaceEdit } from '../../../core/edits/index.js';
import type { TextEdit, Tool, WorkspaceEdit } from '../../../core/tool/index.js';
import { memberHierarchy } from '../../ast/hierarchy.js';
import { declarationAt, resolveTarget, SYMBOL_TARGET_PROPERTIES } from '../../ast/targets.js';
import type { TsProjectSession } from '../../project/index.js';
import { diagnosticsIntroducedBy } from '../guard.js';
import { filesTouched, refactorOutputSchema, type RefactorOutput } from '../output.js';
import { classifyReferences, isUse, type ClassifiedReference } from '../references.js';
import { applicableActions, tryRefactor } from '../refactor-action.js';
import { mayHaveEffects, substituteExpression } from '../substitution.js';

/**
 * How a class member is spelled: method, accessor, or plain field.
 *
 * ReSharper splits this across three entries — Convert Method to
 * Property, Convert Property to Auto-Property, Convert property to
 * method(s) — but they are one axis with three positions on it, and
 * every move along it breaks the same use sites in the same way. So one
 * tool owns the axis, and `to` says where the member should land.
 *
 * What makes it a tool rather than a text edit is the second half of
 * each conversion: `getFoo()` becoming `get foo()` is two tokens at the
 * declaration and an unbounded number of call sites in files the caller
 * never opened. The compiler finds those; nothing else does.
 *
 * The refusals are where the care goes, because two of the three
 * directions can compile perfectly and mean something else:
 *
 * - Collapsing a `get`/`set` pair into a field **discards both bodies**.
 *   That is only sound when the bodies do nothing but read and write one
 *   backing field, so anything else is refused before an edit exists.
 * - `o.x += 1` becoming `o.setX(o.getX() + 1)` evaluates the receiver
 *   twice, which is a behaviour change whenever the receiver does
 *   anything — refused on `mayHaveEffects`.
 * - `o.x ||= v` assigns only when `o.x` is falsy; `o.setX(o.getX() || v)`
 *   assigns always. The three logical assignment operators are refused
 *   for that reason alone.
 *
 * The guard still runs, and it does catch the structural half — a class
 * whose shape stops satisfying an interface is a hard error at the
 * assignment. It cannot catch any of the three above, which is why they
 * are decided here.
 */

export type MemberForm = 'accessor' | 'field' | 'method';

export interface MemberFormInput {
  /** Member to convert, by name. */
  symbol?: string;
  /** Class the member is declared on, when the name is not unique. */
  class?: string;
  file?: string;
  line?: number;
  character?: number;
  /** Spelling the member should end up in. */
  to: MemberForm;
  /** Name for the reading half: the accessor, or the get method. */
  getName?: string;
  /** Name for the writing half: the set method. */
  setName?: string;
  apply?: boolean;
}

export interface MemberUseSite {
  file: string;
  line: number;
  character: number;
  /** The reference classifier's kind, e.g. `read`, `compound-write`. */
  kind: string;
}

export interface MemberFormOutput extends RefactorOutput {
  /** Every reference the conversion had to reason about, pre-edit. */
  useSites: MemberUseSite[];
}

type MemberTarget =
  | ts.PropertyDeclaration
  | ts.MethodDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration;

/** The member being converted, with both halves when it is a pair. */
interface Member {
  container: ts.ClassLikeDeclaration;
  /** Name as written, which is also the name references use. */
  name: string;
  form: MemberForm;
  field?: ts.PropertyDeclaration;
  method?: ts.MethodDeclaration;
  getter?: ts.GetAccessorDeclaration;
  setter?: ts.SetAccessorDeclaration;
  /** Declaration references are resolved from. */
  primary: MemberTarget;
}

/**
 * Compound assignment operators, and the binary operator each one
 * expands to. The three logical forms are deliberately absent: they
 * short-circuit, so the expansion assigns where the original did not.
 */
const COMPOUND_OPERATORS = new Map<ts.SyntaxKind, string>([
  [ts.SyntaxKind.PlusEqualsToken, '+'],
  [ts.SyntaxKind.MinusEqualsToken, '-'],
  [ts.SyntaxKind.AsteriskEqualsToken, '*'],
  [ts.SyntaxKind.AsteriskAsteriskEqualsToken, '**'],
  [ts.SyntaxKind.SlashEqualsToken, '/'],
  [ts.SyntaxKind.PercentEqualsToken, '%'],
  [ts.SyntaxKind.LessThanLessThanEqualsToken, '<<'],
  [ts.SyntaxKind.GreaterThanGreaterThanEqualsToken, '>>'],
  [ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken, '>>>'],
  [ts.SyntaxKind.AmpersandEqualsToken, '&'],
  [ts.SyntaxKind.BarEqualsToken, '|'],
  [ts.SyntaxKind.CaretEqualsToken, '^'],
]);

const SHORT_CIRCUIT_OPERATORS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
]);

const OWN_PROPERTY_WARNING =
  'A field is an own property and an accessor lives on the prototype, so this changes what ' +
  'Object.keys, object spread and JSON.stringify see. Nothing in the type system records that ' +
  'difference, so the typecheck cannot report it.';

const COMPUTED_KEY_WARNING =
  'A reference reached through a computed key (o[k]) is invisible to both this tool and the ' +
  'typecheck, and this conversion changes the name it would have to spell.';

function isMemberTarget(node: ts.Node): node is MemberTarget {
  return (
    ts.isPropertyDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

function nameTextOf(declaration: MemberTarget): string | undefined {
  return ts.isIdentifier(declaration.name) || ts.isPrivateIdentifier(declaration.name)
    ? declaration.name.text
    : undefined;
}

function locate(declaration: ts.Node): string {
  const sourceFile = declaration.getSourceFile();
  const start = (isMemberTarget(declaration) ? declaration.name : declaration).getStart(sourceFile);
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(start);
  return `${sourceFile.fileName}:${line + 1}:${character + 1}`;
}

function containerOf(declaration: MemberTarget): ts.ClassLikeDeclaration | undefined {
  const parent = declaration.parent as ts.Node | undefined;
  return parent && ts.isClassLike(parent) ? parent : undefined;
}

/**
 * Class members named `symbol`.
 *
 * `#x` matches with or without its hash, but only as a fallback: a
 * class may declare `#unit` and `get unit()` at once — the private
 * backing field and its public accessor — and matching both would
 * report one member declared twice rather than two members. So an exact
 * spelling wins outright, and the hash-insensitive pass runs only when
 * nothing matched exactly.
 */
function findMembers(
  session: TsProjectSession,
  symbol: string,
  fileFilter?: string,
): MemberTarget[] {
  const unprefixed = (name: string) => (name.startsWith('#') ? name.slice(1) : name);
  const wanted = unprefixed(symbol);
  const exact: MemberTarget[] = [];
  const loose: MemberTarget[] = [];
  for (const sourceFile of session.sourceFiles()) {
    if (fileFilter && !sourceFile.fileName.endsWith(fileFilter)) continue;
    const visit = (node: ts.Node) => {
      if (isMemberTarget(node) && containerOf(node)) {
        const name = nameTextOf(node);
        if (name === symbol) exact.push(node);
        else if (name !== undefined && unprefixed(name) === wanted) loose.push(node);
      }
      node.forEachChild(visit);
    };
    visit(sourceFile);
  }
  return exact.length > 0 ? exact : loose;
}

/**
 * Constructor parameter properties named `symbol`. They are fields, but
 * their declaration lives in the parameter list — re-spelling one means
 * editing the constructor signature, which is `change-signature`'s
 * territory rather than this tool's.
 */
function findParameterProperties(
  session: TsProjectSession,
  symbol: string,
): ts.ParameterPropertyDeclaration[] {
  const found: ts.ParameterPropertyDeclaration[] = [];
  for (const sourceFile of session.sourceFiles()) {
    const visit = (node: ts.Node) => {
      if (
        ts.isParameter(node) &&
        node.parent !== undefined &&
        ts.isParameterPropertyDeclaration(node, node.parent) &&
        ts.isIdentifier(node.name) &&
        node.name.text === symbol
      ) {
        found.push(node);
      }
      node.forEachChild(visit);
    };
    visit(sourceFile);
  }
  return found;
}

/**
 * Group the declarations of one member. A `get`/`set` pair is two
 * declarations of a single member, so the two are gathered rather than
 * reported as an ambiguity; anything else with two declarations under
 * one name is an overload list, which this tool cannot re-spell.
 */
function gather(declarations: readonly MemberTarget[]): Member {
  const container = containerOf(declarations[0]!)!;
  const name = nameTextOf(declarations[0]!)!;
  const getter = declarations.find(ts.isGetAccessorDeclaration);
  const setter = declarations.find(ts.isSetAccessorDeclaration);
  const field = declarations.find(ts.isPropertyDeclaration);
  const method = declarations.find(ts.isMethodDeclaration);

  const accessors = (getter ? 1 : 0) + (setter ? 1 : 0);
  if (declarations.length !== accessors + (field ? 1 : 0) + (method ? 1 : 0) || (field && method)) {
    throw new Error(
      `"${name}" has ${declarations.length} declarations on ${container.name?.text ?? 'this class'}` +
        ' — an overload list or a declaration merge, neither of which has one spelling to change',
    );
  }
  if (accessors > 0 && (field || method)) {
    throw new Error(`"${name}" is declared both as an accessor and as a ${field ? 'field' : 'method'}`);
  }
  const form: MemberForm = accessors > 0 ? 'accessor' : method ? 'method' : 'field';
  return {
    container,
    name,
    form,
    ...(field ? { field } : {}),
    ...(method ? { method } : {}),
    ...(getter ? { getter } : {}),
    ...(setter ? { setter } : {}),
    primary: (getter ?? setter ?? field ?? method)!,
  };
}

/**
 * Resolve the member to convert. `class` narrows before an ambiguity
 * error would fire: `getName` on two unrelated classes is two members,
 * and picking either without being told is how a tool converts the
 * wrong one.
 */
function resolveMember(session: TsProjectSession, input: MemberFormInput): Member {
  if (input.symbol !== undefined) {
    const candidates = findMembers(session, input.symbol, input.file).filter(
      (candidate) =>
        input.class === undefined || containerOf(candidate)?.name?.text === input.class,
    );
    if (candidates.length === 0) {
      const asParameter = findParameterProperties(session, input.symbol);
      if (asParameter.length > 0) {
        throw new Error(
          `"${input.symbol}" is a constructor parameter property (${locate(asParameter[0]!)}). Its ` +
            'declaration is a parameter, so re-spelling it edits the constructor signature — ' +
            'promote it to a class property first.',
        );
      }
      const scope = input.class === undefined ? '' : ` on class ${input.class}`;
      throw new Error(`No class member named "${input.symbol}"${scope} found in project`);
    }
    const byContainer = new Map<ts.ClassLikeDeclaration, MemberTarget[]>();
    for (const candidate of candidates) {
      const container = containerOf(candidate)!;
      byContainer.set(container, [...(byContainer.get(container) ?? []), candidate]);
    }
    if (byContainer.size > 1) {
      const listed = candidates
        .map((c) => `${containerOf(c)?.name?.text ?? '(anonymous class)'} at ${locate(c)}`)
        .join('\n  ');
      throw new Error(
        `"${input.symbol}" names a member on several classes; disambiguate with class or ` +
          `file/line/character:\n  ${listed}`,
      );
    }
    return gather([...byContainer.values()][0]!);
  }

  const declaration = declarationAt(resolveTarget(session, input));
  if (!isMemberTarget(declaration) || !containerOf(declaration)) {
    throw new Error(
      `The declaration here is a ${ts.SyntaxKind[declaration.kind]}; this tool converts class ` +
        'fields, methods and accessors',
    );
  }
  const name = nameTextOf(declaration);
  if (name === undefined) {
    throw new Error(`The member at ${locate(declaration)} has a computed name`);
  }
  const container = containerOf(declaration)!;
  return gather(
    container.members.filter(
      (member): member is MemberTarget =>
        isMemberTarget(member) && nameTextOf(member) === name,
    ),
  );
}

/** Absolute-path form of a node's file, which edit keys are written in. */
function fileOf(node: ts.Node): string {
  return path.resolve(node.getSourceFile().fileName);
}

function rangeOf(sourceFile: ts.SourceFile, start: number, end: number) {
  return {
    start: sourceFile.getLineAndCharacterOfPosition(start),
    end: sourceFile.getLineAndCharacterOfPosition(end),
  };
}

interface Span {
  start: number;
  end: number;
}

/**
 * Whole-line spans that remove `nodes` — their own lines, their leading
 * comments, and the blank line that separated each from what came
 * before.
 *
 * Taking the *preceding* blank rather than the following one is what
 * keeps the last member of a class from leaving an empty line above the
 * closing brace. The exception is a member that opens the class body,
 * where there is no preceding blank to take and keeping the following
 * one would open the body with an empty line — so those extend forward
 * instead, bounded by the next span so the two can never overlap.
 * `applyTextEdits` rejects overlapping edits, and this tool routinely
 * removes two or three adjacent members at once.
 */
function removalSpans(sourceFile: ts.SourceFile, nodes: readonly ts.Node[]): Span[] {
  const text = sourceFile.getFullText();
  const lineStartAt = (offset: number): number => {
    let at = offset;
    while (at > 0 && text[at - 1] !== '\n') at--;
    return at;
  };

  const raw = nodes
    .map((node) => {
      let start = lineStartAt(node.getStart(sourceFile, true));
      while (start > 0) {
        const previous = lineStartAt(start - 1);
        if (text.slice(previous, start).trim() !== '') break;
        start = previous;
      }
      let end = node.getEnd();
      while (end < text.length && text[end] !== '\n') end++;
      if (end < text.length) end++;
      return { start, end };
    })
    .sort((a, b) => a.start - b.start);

  const merged: Span[] = [];
  for (const span of raw) {
    const last = merged[merged.length - 1];
    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }

  for (const [index, span] of merged.entries()) {
    if (!text.slice(0, span.start).trimEnd().endsWith('{')) continue;
    const limit = merged[index + 1]?.start ?? text.length;
    for (;;) {
      const lineEnd = text.indexOf('\n', span.end);
      if (lineEnd === -1 || lineEnd + 1 > limit) break;
      if (text.slice(span.end, lineEnd).trim() !== '') break;
      span.end = lineEnd + 1;
    }
  }
  return merged;
}

/**
 * Blank lines a removal span opens and closes with.
 *
 * A span swallows the separators around the member it removes, so a
 * replacement has to put them back or the member that follows welds
 * itself to the one that replaced it.
 */
function blankLinesAround(text: string, span: Span): { before: string; after: string } {
  const lines = text.slice(span.start, span.end).split('\n');
  let before = 0;
  while (before < lines.length - 1 && lines[before]!.trim() === '') before++;
  let after = 0;
  for (let index = lines.length - 2; index > before && lines[index]!.trim() === ''; index--) {
    after++;
  }
  return { before: '\n'.repeat(before), after: '\n'.repeat(after) };
}

/** Column a node starts at, which is the indent its replacement wants. */
function indentOf(node: ts.Node): string {
  const sourceFile = node.getSourceFile();
  return ' '.repeat(
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile, false)).character,
  );
}

/** Leading comment block, which a re-spelled member should keep. */
function docCommentOf(node: ts.Node): string {
  const sourceFile = node.getSourceFile();
  const text = sourceFile
    .getFullText()
    .slice(node.getStart(sourceFile, true), node.getStart(sourceFile, false))
    .trim();
  return text;
}

function modifierText(flags: ts.ModifierFlags, extra: { readonly?: boolean } = {}): string {
  const parts: string[] = [];
  if (flags & ts.ModifierFlags.Private) parts.push('private');
  else if (flags & ts.ModifierFlags.Protected) parts.push('protected');
  if (flags & ts.ModifierFlags.Static) parts.push('static');
  if (extra.readonly ?? Boolean(flags & ts.ModifierFlags.Readonly)) parts.push('readonly');
  return parts.length === 0 ? '' : `${parts.join(' ')} `;
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function requireIdentifier(name: string, what: string): string {
  if (!IDENTIFIER.test(name)) throw new Error(`"${name}" is not a valid identifier for ${what}`);
  return name;
}

function capitalize(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * `getFoo` → `foo`. A second capital is left alone, because `getURL`
 * reads as `URL` and never as `uRL`.
 */
function derivedAccessorName(methodName: string): string | undefined {
  const match = /^(?:get|is|has)([A-Z].*)$/.exec(methodName);
  if (!match) return undefined;
  const rest = match[1]!;
  const second = rest.charAt(1);
  return second !== '' && second === second.toUpperCase() && /[A-Za-z]/.test(second)
    ? rest
    : rest.charAt(0).toLowerCase() + rest.slice(1);
}

/** A member name free on this class, `_x` then `_x2`, `_x3`. */
function freeMemberName(container: ts.ClassLikeDeclaration, base: string): string {
  const taken = new Set(
    container.members.flatMap((member) =>
      member.name && (ts.isIdentifier(member.name) || ts.isPrivateIdentifier(member.name))
        ? [member.name.text]
        : [],
    ),
  );
  if (!taken.has(base)) return base;
  for (let suffix = 2; ; suffix++) {
    if (!taken.has(`${base}${suffix}`)) return `${base}${suffix}`;
  }
}

/** References to the member, from whichever declaration carries the name. */
function referencesTo(session: TsProjectSession, declaration: ts.NamedDeclaration): ClassifiedReference[] {
  const sourceFile = declaration.getSourceFile();
  return classifyReferences(
    session,
    path.resolve(sourceFile.fileName),
    declaration.name!.getStart(sourceFile),
  );
}

function describeUse(reference: ClassifiedReference): MemberUseSite {
  return {
    file: reference.file,
    line: reference.line,
    character: reference.character,
    kind: reference.kind,
  };
}

/** Refuse a reference spelled as a string key: no rewrite can reach it. */
function refuseStringKeys(references: readonly ClassifiedReference[], name: string): void {
  const keyed = references.filter((reference) => ts.isStringLiteralLike(reference.node));
  if (keyed.length === 0) return;
  throw new Error(
    `"${name}" is reached through a string key at ` +
      keyed.map((k) => `${k.file}:${k.line + 1}:${k.character + 1}`).join(', ') +
      '. Renaming the member would leave that access pointing at nothing, and the typecheck ' +
      'reports it only because the key is a literal — a computed one would compile.',
  );
}

/** The property access a reference reads the member through. */
function accessOf(reference: ClassifiedReference): ts.PropertyAccessExpression | undefined {
  const parent = reference.node.parent as ts.Node | undefined;
  return parent && ts.isPropertyAccessExpression(parent) && parent.name === reference.node
    ? parent
    : undefined;
}

interface Rewrite {
  file: string;
  sourceFile: ts.SourceFile;
  start: number;
  end: number;
  newText: string;
}

interface Conversion {
  rewrites: Rewrite[];
  warnings: string[];
  useSites: MemberUseSite[];
}

/* ------------------------------------------------------------------ */
/* method → accessor                                                   */
/* ------------------------------------------------------------------ */

function methodToAccessor(
  session: TsProjectSession,
  member: Member,
  input: MemberFormInput,
): Conversion {
  const method = member.method!;
  const sourceFile = method.getSourceFile();
  const where = `${member.container.name?.text ?? '(anonymous class)'}.${member.name}`;

  if (input.setName !== undefined) {
    throw new Error('setName has no meaning converting a method to a getter; drop it');
  }
  if (method.parameters.length > 0) {
    throw new Error(
      `${where} takes ${method.parameters.length} parameter(s). Only a zero-argument method reads ` +
        'as a property.',
    );
  }
  if (method.typeParameters && method.typeParameters.length > 0) {
    throw new Error(`${where} is generic, and an accessor cannot declare type parameters`);
  }
  if (method.questionToken) {
    throw new Error(`${where} is optional, which an accessor cannot be`);
  }
  if (method.asteriskToken) throw new Error(`${where} is a generator`);
  const flags = ts.getCombinedModifierFlags(method);
  if (flags & ts.ModifierFlags.Async) {
    throw new Error(`${where} is async, and an accessor cannot be — its body would have to change`);
  }

  const accessorName =
    input.getName !== undefined
      ? requireIdentifier(input.getName, 'the accessor')
      : derivedAccessorName(member.name);
  if (accessorName === undefined) {
    throw new Error(
      `${where} is not named get*/is*/has*, so there is no property name to derive. Pass getName.`,
    );
  }
  if (
    accessorName !== member.name &&
    member.container.members.some(
      (other) =>
        other !== method &&
        other.name !== undefined &&
        ts.isIdentifier(other.name) &&
        other.name.text === accessorName,
    )
  ) {
    throw new Error(`${member.container.name?.text ?? 'The class'} already declares "${accessorName}"`);
  }

  const references = referencesTo(session, method).filter(isUse);
  refuseStringKeys(references, member.name);

  const rewrites: Rewrite[] = [];
  const useSites: MemberUseSite[] = [];
  const unreachable: string[] = [];
  for (const reference of references) {
    const access = accessOf(reference);
    const call = access?.parent;
    if (
      !access ||
      !call ||
      !ts.isCallExpression(call) ||
      call.expression !== access ||
      call.questionDotToken !== undefined ||
      call.arguments.length > 0 ||
      (call.typeArguments?.length ?? 0) > 0
    ) {
      unreachable.push(
        `${reference.file}:${reference.line + 1}:${reference.character + 1} (${reference.kind}: ` +
          `${(reference.node.parent ?? reference.node).getText().slice(0, 48).replace(/\s+/g, ' ')})`,
      );
      continue;
    }
    const useFile = reference.node.getSourceFile();
    rewrites.push({
      file: path.resolve(useFile.fileName),
      sourceFile: useFile,
      start: reference.node.getStart(useFile),
      end: call.getEnd(),
      newText: accessorName,
    });
    useSites.push(describeUse(reference));
  }
  if (unreachable.length > 0) {
    throw new Error(
      `${where} is used in ways a property read cannot replace — detached as a value, called ` +
        `with arguments, or through an optional call:\n  ${unreachable.join('\n  ')}`,
    );
  }

  // `get ` before the name, so it lands after accessibility and static.
  const nameStart = method.name.getStart(sourceFile);
  rewrites.push({
    file: fileOf(method),
    sourceFile,
    start: nameStart,
    end: method.name.getEnd(),
    newText: `get ${accessorName}`,
  });

  const warnings: string[] = [COMPUTED_KEY_WARNING];
  if (method.body && mayHaveEffects(method.body)) {
    warnings.push(
      `${where} does work a plain read now triggers: a getter runs on every property access, ` +
        'including ones a debugger, a spread, or a logging call makes.',
    );
  }
  return { rewrites, warnings, useSites };
}

/* ------------------------------------------------------------------ */
/* field → accessor, on TypeScript's own engine                        */
/* ------------------------------------------------------------------ */

function fieldToAccessor(
  session: TsProjectSession,
  member: Member,
  input: MemberFormInput,
): { edit: WorkspaceEdit; warnings: string[]; useSites: MemberUseSite[] } {
  const field = member.field!;
  const sourceFile = field.getSourceFile();
  const where = `${member.container.name?.text ?? '(anonymous class)'}.${member.name}`;

  if (input.getName !== undefined || input.setName !== undefined) {
    throw new Error(
      'getName/setName do not apply here: the accessor keeps the field\'s name, and TypeScript\'s ' +
        'own generator picks the backing field name',
    );
  }

  const at = { pos: field.name.getStart(sourceFile), end: field.name.getEnd() };
  // A caret finds nothing: getAccessorConvertiblePropertyAtPosition
  // requires the span to overlap the property name, and the refactor is
  // listed only when it does. Hence a range over the name exactly.
  const offered = applicableActions(session, path.resolve(sourceFile.fileName), at).find(
    (action) => action.kind === 'refactor.rewrite.property.generateAccessors',
  );
  if (!offered) {
    throw new Error(
      `TypeScript will not generate accessors for ${where}; it accepts only a property with an ` +
        'accessibility, static or readonly modifier and a plain name',
    );
  }
  const result = tryRefactor(session, {
    file: path.resolve(sourceFile.fileName),
    at,
    refactor: offered.refactor,
    action: offered.action,
  });
  if (!result) throw new Error(`TypeScript produced no edits generating accessors for ${where}`);

  // The engine re-derives its own target, so the edit is checked for
  // the accessor it was asked for rather than assumed to contain one.
  const produced = (result.edit.changes[path.resolve(sourceFile.fileName)] ?? [])
    .map((change) => change.newText)
    .join('\n');
  const renamed = member.name.startsWith('_');
  const accessorName = renamed ? member.name.replace(/^_+/, '') : member.name;
  if (!produced.includes(`get ${accessorName}`)) {
    throw new Error(
      `TypeScript generated something other than a "${accessorName}" accessor for ${where}`,
    );
  }
  const edit = { ...result.edit, changes: { ...result.edit.changes } };
  for (const [key, edits] of Object.entries(edit.changes)) {
    edit.changes[key] = orderInsertions(edits);
  }

  const references = referencesTo(session, field).filter(isUse);
  const warnings = [OWN_PROPERTY_WARNING];
  if (renamed) {
    warnings.push(
      `${where} already starts with an underscore, so TypeScript keeps the field's name and ` +
        `names the accessor "${accessorName}" — a rename this tool did not ask for. Every use ` +
        'outside the class still spells the old name and now reads a private field, which the ' +
        'compile guard reports as TS2341.',
    );
  }
  return { edit, warnings, useSites: references.map(describeUse) };
}

/**
 * Reverse runs of insertions that share a position.
 *
 * `applyTextEdits` works backwards through the file, so two insertions
 * at the same offset come out in the opposite order to the one they
 * were listed in — and TypeScript lists the getter first. Left alone,
 * the generated pair reads `set` above `get`, which looks like a defect
 * in this tool rather than an artefact of how edits are applied.
 */
function orderInsertions(edits: readonly TextEdit[]): TextEdit[] {
  const ordered = [...edits];
  const key = (edit: TextEdit) =>
    `${edit.range.start.line}:${edit.range.start.character}:${edit.range.end.line}:${edit.range.end.character}`;
  for (let start = 0; start < ordered.length; ) {
    let end = start + 1;
    while (end < ordered.length && key(ordered[end]!) === key(ordered[start]!)) end++;
    const empty =
      ordered[start]!.range.start.line === ordered[start]!.range.end.line &&
      ordered[start]!.range.start.character === ordered[start]!.range.end.character;
    if (empty && end - start > 1) ordered.splice(start, end - start, ...ordered.slice(start, end).reverse());
    start = end;
  }
  return ordered;
}

/* ------------------------------------------------------------------ */
/* accessor → field                                                    */
/* ------------------------------------------------------------------ */

/**
 * Whether an access reads the accessor's own object rather than some
 * other one. `return this._x` collapses; `return other._x` names a
 * field on a different object that happens to share a name with one of
 * ours, and collapsing it would move the read to the wrong receiver
 * while still compiling.
 */
function readsOwnState(access: ts.PropertyAccessExpression, containerName: string | undefined): boolean {
  const receiver = access.expression;
  if (receiver.kind === ts.SyntaxKind.ThisKeyword) return true;
  return ts.isIdentifier(receiver) && containerName !== undefined && receiver.text === containerName;
}

/** The one field a trivial getter returns, if that is all it does. */
function getterBacking(
  getter: ts.GetAccessorDeclaration,
  containerName: string | undefined,
): ts.MemberName | undefined {
  const statements = getter.body?.statements ?? [];
  if (statements.length !== 1) return undefined;
  const only = statements[0]!;
  if (!ts.isReturnStatement(only) || !only.expression) return undefined;
  const returned = only.expression;
  if (!ts.isPropertyAccessExpression(returned)) return undefined;
  return readsOwnState(returned, containerName) ? returned.name : undefined;
}

/** The one field a trivial setter assigns its parameter to. */
function setterBacking(
  setter: ts.SetAccessorDeclaration,
  containerName: string | undefined,
): ts.MemberName | undefined {
  const statements = setter.body?.statements ?? [];
  if (statements.length !== 1) return undefined;
  const only = statements[0]!;
  if (!ts.isExpressionStatement(only)) return undefined;
  const assignment = only.expression;
  if (
    !ts.isBinaryExpression(assignment) ||
    assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
    !ts.isPropertyAccessExpression(assignment.left) ||
    !readsOwnState(assignment.left, containerName)
  ) {
    return undefined;
  }
  const parameter = setter.parameters[0];
  if (
    !parameter ||
    !ts.isIdentifier(parameter.name) ||
    !ts.isIdentifier(assignment.right) ||
    assignment.right.text !== parameter.name.text
  ) {
    return undefined;
  }
  return assignment.left.name;
}

function accessorToField(
  session: TsProjectSession,
  member: Member,
  input: MemberFormInput,
): Conversion & { anchor: ts.Node; removed: ts.Node[]; declaration: string } {
  const { getter, setter } = member;
  const where = `${member.container.name?.text ?? '(anonymous class)'}.${member.name}`;
  if (input.getName !== undefined || input.setName !== undefined) {
    throw new Error('getName/setName do not apply here: the field keeps the accessor\'s name');
  }
  if (!getter) {
    throw new Error(
      `${where} is a setter with no getter. Collapsing it into a field would make it readable, ` +
        'which is a shape change rather than a re-spelling.',
    );
  }

  const backingName = getterBacking(getter, member.container.name?.text);
  if (!backingName) {
    throw new Error(
      `${where}'s getter does more than return one field, so collapsing it into a field would ` +
        'silently drop the body. Only `return this.<field>;` collapses.',
    );
  }
  if (setter) {
    const written = setterBacking(setter, member.container.name?.text);
    if (!written) {
      throw new Error(
        `${where}'s setter does more than assign its parameter to one field, so collapsing it ` +
          'would silently drop the body. Only `this.<field> = <parameter>;` collapses.',
      );
    }
    if (written.text !== backingName.text) {
      throw new Error(
        `${where} reads "${backingName.text}" and writes "${written.text}"; there is no single ` +
          'backing field to collapse into',
      );
    }
  }

  const backing = member.container.members.find(
    (candidate): candidate is ts.PropertyDeclaration =>
      ts.isPropertyDeclaration(candidate) &&
      (ts.isIdentifier(candidate.name) || ts.isPrivateIdentifier(candidate.name)) &&
      candidate.name.text === backingName.text,
  );
  if (!backing) {
    throw new Error(
      `${where}'s getter returns "${backingName.text}", which ` +
        `${member.container.name?.text ?? 'this class'} does not declare — the field it reads ` +
        'lives somewhere this tool cannot remove',
    );
  }

  // The field's type is the accessor's public type, stated rather than
  // inferred: a getter-only pair becomes `readonly`, and `readonly x = 0`
  // takes the literal type `0` where the getter said `number`.
  const checker = session.checker();
  const annotation =
    getter.type?.getText(getter.getSourceFile()) ??
    backing.type?.getText(backing.getSourceFile()) ??
    checker.typeToString(
      checker.getWidenedType(checker.getTypeAtLocation(backing)),
      backing,
      ts.TypeFormatFlags.NoTruncation,
    );
  const initializer = backing.initializer?.getText(backing.getSourceFile());
  const modifiers = modifierText(ts.getCombinedModifierFlags(getter), { readonly: !setter });
  const doc = docCommentOf(getter);
  const indent = indentOf(getter);
  const declaration =
    (doc ? `${doc}\n${indent}` : '') +
    `${modifiers}${member.name}: ${annotation}` +
    (initializer === undefined ? '' : ` = ${initializer}`) +
    ';';

  // Every other use of the backing field becomes a use of the field
  // that replaces it — including the constructor assignment, which
  // `readonly` still permits.
  const removedRanges = [getter, ...(setter ? [setter] : [])].map((node) => ({
    file: fileOf(node),
    start: node.getStart(node.getSourceFile(), true),
    end: node.getEnd(),
  }));
  const backingReferences = referencesTo(session, backing).filter(isUse);
  refuseStringKeys(backingReferences, backingName.text);

  const rewrites: Rewrite[] = [];
  const useSites: MemberUseSite[] = [];
  for (const reference of backingReferences) {
    const useFile = reference.node.getSourceFile();
    const start = reference.node.getStart(useFile);
    const inside = removedRanges.some(
      (range) =>
        range.file === path.resolve(useFile.fileName) && start >= range.start && start < range.end,
    );
    if (inside) continue;
    rewrites.push({
      file: path.resolve(useFile.fileName),
      sourceFile: useFile,
      start,
      end: reference.node.getEnd(),
      newText: member.name,
    });
    useSites.push(describeUse(reference));
  }
  useSites.push(...referencesTo(session, getter).filter(isUse).map(describeUse));

  const warnings = [OWN_PROPERTY_WARNING];
  if (!setter) {
    warnings.push(
      `${where} had no setter, so the field is readonly — which TypeScript erases at compile ` +
        'time, unlike a getter with no setter, whose absence of a set trap is a runtime fact.',
    );
  }
  return {
    rewrites,
    warnings,
    useSites,
    anchor: getter,
    removed: [backing, getter, ...(setter ? [setter] : [])],
    declaration,
  };
}

/* ------------------------------------------------------------------ */
/* field | accessor → method                                           */
/* ------------------------------------------------------------------ */

interface MethodPlan {
  getName: string;
  setName: string;
  /** Whether the member can be written after the conversion. */
  writable: boolean;
}

/**
 * Rewrite every use of a member that becomes a get/set method pair.
 *
 * Three of the four kinds are mechanical. The fourth, a compound write,
 * is where the conversion can be wrong while compiling: the receiver
 * appears twice in the result, so anything it does happens twice, and a
 * short-circuiting operator assigns where it used to skip. Both are
 * refused rather than warned about, because the guard sees neither.
 */
function methodUseRewrites(
  member: Member,
  plan: MethodPlan,
  references: readonly ClassifiedReference[],
  /** Backing field a write bypasses the setter for, when there is none. */
  backingWrite: string | undefined,
): Conversion {
  const where = `${member.container.name?.text ?? '(anonymous class)'}.${member.name}`;
  const rewrites: Rewrite[] = [];
  const useSites: MemberUseSite[] = [];
  const unreachable: string[] = [];
  const at = (reference: ClassifiedReference) =>
    `${reference.file}:${reference.line + 1}:${reference.character + 1}`;

  for (const reference of references) {
    const useFile = reference.node.getSourceFile();
    const file = path.resolve(useFile.fileName);
    const access = accessOf(reference);
    if (!access) {
      unreachable.push(
        `${at(reference)} (${reference.kind}: ` +
          `${(reference.node.parent ?? reference.node).getText().slice(0, 48).replace(/\s+/g, ' ')})`,
      );
      continue;
    }
    const nameStart = reference.node.getStart(useFile);
    const nameEnd = reference.node.getEnd();
    const record = () => useSites.push(describeUse(reference));

    if (reference.kind === 'read' || reference.kind === 'direct-call' || reference.kind === 'spread-call') {
      rewrites.push({ file, sourceFile: useFile, start: nameStart, end: nameEnd, newText: `${plan.getName}()` });
      record();
      continue;
    }

    if (reference.kind === 'write') {
      const assignment = access.parent;
      if (!assignment || !ts.isBinaryExpression(assignment) || assignment.left !== access) {
        unreachable.push(`${at(reference)} (write through an expression this cannot rewrite)`);
        continue;
      }
      if (backingWrite !== undefined) {
        // A readonly field keeps its constructor assignment, and there
        // is no setter to route it through: it writes the backing field.
        rewrites.push({
          file,
          sourceFile: useFile,
          start: nameStart,
          end: nameEnd,
          newText: backingWrite,
        });
        record();
        continue;
      }
      if (!ts.isExpressionStatement(assignment.parent)) {
        throw new Error(
          `${where} is assigned at ${at(reference)} in a position whose value is used; ` +
            `${plan.setName}(…) returns void, so the meaning would change`,
        );
      }
      // Three adjacent edits rather than one replacement, so a
      // reference to the same member inside the right-hand side gets
      // its own rewrite instead of being swallowed.
      rewrites.push(
        { file, sourceFile: useFile, start: nameStart, end: nameEnd, newText: `${plan.setName}(` },
        {
          file,
          sourceFile: useFile,
          start: access.getEnd(),
          end: assignment.right.getStart(useFile),
          newText: '',
        },
        {
          file,
          sourceFile: useFile,
          start: assignment.right.getEnd(),
          end: assignment.right.getEnd(),
          newText: ')',
        },
      );
      record();
      continue;
    }

    if (reference.kind === 'compound-write') {
      if (!plan.writable) {
        unreachable.push(`${at(reference)} (compound write to a readonly member)`);
        continue;
      }
      const outer = access.parent;
      const receiver = access.expression;
      if (mayHaveEffects(receiver)) {
        throw new Error(
          `${where} is compound-assigned at ${at(reference)} through a receiver that does work ` +
            `(\`${receiver.getText(useFile).slice(0, 48)}\`). The expansion evaluates it twice, ` +
            'which the typecheck cannot see. Hoist the receiver into a local first.',
        );
      }
      if (ts.isBinaryExpression(outer) && SHORT_CIRCUIT_OPERATORS.has(outer.operatorToken.kind)) {
        throw new Error(
          `${where} is assigned with ${outer.operatorToken.getText(useFile)} at ${at(reference)}. ` +
            'That operator only assigns when the current value permits it, and the expansion ' +
            'assigns always — a behaviour change no typecheck reports.',
        );
      }
      if (!ts.isExpressionStatement(outer.parent)) {
        throw new Error(
          `${where} is compound-assigned at ${at(reference)} in a position whose value is used; ` +
            `${plan.setName}(…) returns void, so the meaning would change`,
        );
      }

      let operator: string;
      let valueText: string;
      let selfReference: ts.Node | undefined;
      if (ts.isBinaryExpression(outer)) {
        const mapped = COMPOUND_OPERATORS.get(outer.operatorToken.kind);
        if (mapped === undefined) {
          unreachable.push(`${at(reference)} (${outer.operatorToken.getText(useFile)})`);
          continue;
        }
        operator = mapped;
        valueText = outer.right.getText(useFile);
        selfReference = outer.right;
      } else {
        operator = outer.kind === ts.SyntaxKind.PostfixUnaryExpression
          ? (outer as ts.PostfixUnaryExpression).operator === ts.SyntaxKind.PlusPlusToken
            ? '+'
            : '-'
          : (outer as ts.PrefixUnaryExpression).operator === ts.SyntaxKind.PlusPlusToken
            ? '+'
            : '-';
        valueText = '1';
      }
      const inValue = selfReference;
      if (
        inValue &&
        references.some(
          (other) =>
            other.file === file &&
            other.offset >= inValue.getStart(useFile) &&
            other.offset < inValue.getEnd(),
        )
      ) {
        throw new Error(
          `${where} appears on both sides of the compound assignment at ${at(reference)}; the ` +
            'expansion replaces the whole expression, so the inner use would be left unconverted',
        );
      }

      // The compiler's own parenthesizer decides the brackets: `o.x *= a + b`
      // must expand to `o.setX(o.getX() * (a + b))`, and a rule written
      // here rather than asked for is the classic way to get that wrong.
      const template = ts.createSourceFile(
        '__member-form.ts',
        `__receiver.${plan.setName}(__receiver.${plan.getName}() ${operator} __value);`,
        ts.ScriptTarget.Latest,
        true,
      );
      const expression = (template.statements[0] as ts.ExpressionStatement).expression;
      const { text } = substituteExpression(
        expression,
        template,
        new Map([
          ['__receiver', receiver.getText(useFile)],
          ['__value', valueText],
        ]),
      );
      rewrites.push({
        file,
        sourceFile: useFile,
        start: outer.getStart(useFile),
        end: outer.getEnd(),
        newText: text,
      });
      record();
      continue;
    }

    unreachable.push(`${at(reference)} (${reference.kind})`);
  }

  if (unreachable.length > 0) {
    throw new Error(
      `${where} is used in ways a get/set method pair cannot replace — destructured, held as a ` +
        `value, or read in a type position:\n  ${unreachable.join('\n  ')}`,
    );
  }
  return { rewrites, warnings: [], useSites };
}

export const memberForm: Tool<MemberFormInput, MemberFormOutput, TsProjectSession> = {
  name: 'ts/refactors/member-form',
  description:
    'Changes how a class member is spelled and rewrites every use site the change breaks — ' +
    "ReSharper's Convert Method to Property, Convert Property to Auto-Property and Convert " +
    'property to method(s) in one tool, since they are one axis. to: "accessor" turns a ' +
    'zero-argument getFoo(): T into get foo(): T and every x.getFoo() into x.foo, and turns a ' +
    "plain field into a backing field plus accessors using TypeScript's own generator. to: " +
    '"field" collapses a get/set pair that only reads and writes one backing field into a plain ' +
    'property, removes the backing field, rewrites its remaining uses, and makes a getter with ' +
    'no setter readonly. to: "method" turns a field or accessor into getX()/setX(v), rewriting ' +
    'reads into calls, writes into setX(v), and o.x += 1 into o.setX(o.getX() + 1). Refuses ' +
    'what it cannot rewrite: a destructured or detached use, a member reached through a string ' +
    'key, a member a base class or subclass also declares, a compound write through a receiver ' +
    'that does work (it would run twice), a short-circuiting ||=/&&=/??=, and a get/set pair ' +
    'whose bodies do more than move one field. Target by name (symbol), narrowed by class, or ' +
    'by exact position. Dry-run by default; apply: true writes to disk unless the typecheck ' +
    'reports newDiagnostics.',
  inputSchema: {
    type: 'object',
    properties: {
      ...SYMBOL_TARGET_PROPERTIES,
      symbol: { type: 'string', description: 'Member name to target' },
      class: {
        type: 'string',
        description: 'Class the member is declared on, when the name is not unique',
      },
      to: {
        type: 'string',
        enum: ['accessor', 'field', 'method'],
        description: 'Spelling the member should end up in',
      },
      getName: {
        type: 'string',
        description:
          'Name for the reading half — the accessor (default: getFoo becomes foo) or the get ' +
          'method (default: getX)',
      },
      setName: { type: 'string', description: 'Name for the set method (default: setX)' },
      apply: { type: 'boolean', description: 'Write the edit to disk (default false)' },
    },
    required: ['to'],
    additionalProperties: false,
  },
  outputSchema: refactorOutputSchema(
    {
      useSites: {
        type: 'array',
        description: 'Every reference the conversion reasoned about, in the pre-edit tree',
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
    },
    ['useSites'],
  ),

  async run(session, input) {
    if (input.to !== 'accessor' && input.to !== 'field' && input.to !== 'method') {
      throw new Error(`to must be "accessor", "field" or "method"; got ${JSON.stringify(input.to)}`);
    }

    const member = resolveMember(session, input);
    const className = member.container.name?.text ?? '(anonymous class)';
    const where = `${className}.${member.name}`;
    const declarations = [member.field, member.method, member.getter, member.setter].filter(
      (node): node is MemberTarget => node !== undefined,
    );

    if (member.form === input.to) {
      throw new Error(`${where} is already spelled as ${input.to === 'accessor' ? 'an' : 'a'} ${input.to}`);
    }
    if (member.name.startsWith('#')) {
      throw new Error(
        `${where} is a #private member, reachable only inside its own class body. Re-spelling ` +
          'one is a single-file edit with no cross-file blast radius, which is not what this ' +
          'tool is for.',
      );
    }
    for (const declaration of declarations) {
      if ((ts.getDecorators(declaration) ?? []).length > 0) {
        throw new Error(
          `${where} is decorated, and a decorator applies to one member kind — changing the ` +
            'spelling changes what it decorates',
        );
      }
      const flags = ts.getCombinedModifierFlags(declaration);
      if (flags & ts.ModifierFlags.Abstract || flags & ts.ModifierFlags.Ambient) {
        throw new Error(`${where} is abstract or ambient: it has no body to re-spell`);
      }
      if (
        (ts.isMethodDeclaration(declaration) ||
          ts.isGetAccessorDeclaration(declaration) ||
          ts.isSetAccessorDeclaration(declaration)) &&
        declaration.body === undefined
      ) {
        throw new Error(`${where} has no body`);
      }
    }

    // A member the hierarchy shares is not the only declaration of
    // itself: re-spelling one leaves the others, and the class that
    // still declares the old form goes on satisfying the old contract.
    const hierarchy = memberHierarchy(session, member.primary);
    if (hierarchy.unresolved.length > 0) {
      throw new Error(
        `${className}'s hierarchy cannot be resolved (${hierarchy.unresolved.join(', ')}), so ` +
          'another declaration of this member could be invisible here',
      );
    }
    if (hierarchy.supertypes.length + hierarchy.subtypes.length > 0) {
      const others = [...hierarchy.supertypes, ...hierarchy.subtypes]
        .map((other) => `${other.container} (${other.file}:${other.line + 1})`)
        .join(', ');
      throw new Error(
        `${where} is also declared by ${others}; re-spelling one declaration of a shared member ` +
          'leaves the others behind',
      );
    }

    const changes: Record<string, TextEdit[]> = {};
    const add = (file: string, edit: TextEdit): void => {
      changes[file] = [...(changes[file] ?? []), edit];
    };
    const emit = (rewrites: readonly Rewrite[]): void => {
      for (const rewrite of rewrites) {
        add(rewrite.file, {
          range: rangeOf(rewrite.sourceFile, rewrite.start, rewrite.end),
          newText: rewrite.newText,
        });
      }
    };

    let edit: WorkspaceEdit;
    let warnings: string[];
    let useSites: MemberUseSite[];

    if (input.to === 'accessor' && member.form === 'method') {
      const conversion = methodToAccessor(session, member, input);
      emit(conversion.rewrites);
      edit = { changes };
      warnings = conversion.warnings;
      useSites = conversion.useSites;
    } else if (input.to === 'accessor') {
      const delegated = fieldToAccessor(session, member, input);
      edit = delegated.edit;
      warnings = delegated.warnings;
      useSites = delegated.useSites;
    } else if (input.to === 'field') {
      if (member.form !== 'accessor') {
        throw new Error(
          `${where} is a method. A method with a constant body is not a field — converting it ` +
            'would change when the body runs; use to: "accessor" instead.',
        );
      }
      const conversion = accessorToField(session, member, input);
      emit(conversion.rewrites);

      const sourceFile = member.container.getSourceFile();
      const text = sourceFile.getFullText();
      const spans = removalSpans(sourceFile, conversion.removed);
      const anchorStart = conversion.anchor.getStart(sourceFile, true);
      for (const span of spans) {
        const holdsAnchor = anchorStart >= span.start && anchorStart < span.end;
        const blanks = blankLinesAround(text, span);
        add(path.resolve(sourceFile.fileName), {
          range: rangeOf(sourceFile, span.start, span.end),
          newText: holdsAnchor
            ? `${blanks.before}${indentOf(conversion.anchor)}${conversion.declaration}\n${blanks.after}`
            : '',
        });
      }
      edit = { changes };
      warnings = conversion.warnings;
      useSites = conversion.useSites;
    } else {
      // to: 'method'
      const readonlyField =
        member.form === 'field' &&
        (ts.getCombinedModifierFlags(member.field!) & ts.ModifierFlags.Readonly) !== 0;
      const writable = member.form === 'field' ? !readonlyField : member.setter !== undefined;
      const plan: MethodPlan = {
        getName: requireIdentifier(input.getName ?? `get${capitalize(member.name)}`, 'the get method'),
        setName: requireIdentifier(input.setName ?? `set${capitalize(member.name)}`, 'the set method'),
        writable,
      };
      if (!writable && input.setName !== undefined) {
        throw new Error(`${where} cannot be written, so there is no set method for setName to name`);
      }
      for (const name of writable ? [plan.getName, plan.setName] : [plan.getName]) {
        if (
          member.container.members.some(
            (other) =>
              !declarations.includes(other as MemberTarget) &&
              other.name !== undefined &&
              ts.isIdentifier(other.name) &&
              other.name.text === name,
          )
        ) {
          throw new Error(`${className} already declares "${name}"`);
        }
      }

      const references = referencesTo(session, member.primary).filter(isUse);
      refuseStringKeys(references, member.name);

      const sourceFile = member.container.getSourceFile();
      const backingName =
        member.form === 'field' ? freeMemberName(member.container, `_${member.name}`) : undefined;
      const conversion = methodUseRewrites(
        member,
        plan,
        references,
        readonlyField ? backingName : undefined,
      );
      emit(conversion.rewrites);

      if (member.form === 'field') {
        const field = member.field!;
        const checker = session.checker();
        const flags = ts.getCombinedModifierFlags(field);
        const isStatic = (flags & ts.ModifierFlags.Static) !== 0;
        if (isStatic && member.container.name === undefined) {
          throw new Error(`${where} is static on an anonymous class, which the bodies cannot name`);
        }
        const receiver = isStatic ? member.container.name!.text : 'this';
        const typeText =
          field.type?.getText(sourceFile) ??
          checker.typeToString(
            checker.getWidenedType(checker.getTypeAtLocation(field)),
            field,
            ts.TypeFormatFlags.NoTruncation,
          );
        const indent = indentOf(field);
        const body = `${indent}  `;
        const access = modifierText(flags, { readonly: false });
        const doc = docCommentOf(field);
        const backingModifiers = modifierText(
          flags & (ts.ModifierFlags.Static | ts.ModifierFlags.Readonly),
        );
        const parts = [
          `${doc ? `${doc}\n${indent}` : ''}private ${backingModifiers}${backingName!}` +
            `${field.questionToken ? '?' : ''}${field.exclamationToken ? '!' : ''}: ${typeText}` +
            (field.initializer ? ` = ${field.initializer.getText(sourceFile)}` : '') +
            ';',
          `${access}${plan.getName}(): ${typeText} {\n${body}return ${receiver}.${backingName!};\n${indent}}`,
        ];
        if (writable) {
          parts.push(
            `${access}${plan.setName}(value: ${typeText}) {\n${body}${receiver}.${backingName!} = value;\n${indent}}`,
          );
        }
        const span = removalSpans(sourceFile, [field])[0]!;
        const blanks = blankLinesAround(sourceFile.getFullText(), span);
        add(path.resolve(sourceFile.fileName), {
          range: rangeOf(sourceFile, span.start, span.end),
          newText:
            blanks.before +
            parts.map((part) => `${indent}${part}`).join('\n\n') +
            `\n${blanks.after}`,
        });
        conversion.warnings.push(OWN_PROPERTY_WARNING);
      } else {
        // An accessor pair keeps both bodies; only the spelling moves.
        for (const [accessor, keyword, name] of [
          [member.getter, ts.SyntaxKind.GetKeyword, plan.getName] as const,
          [member.setter, ts.SyntaxKind.SetKeyword, plan.setName] as const,
        ]) {
          if (!accessor) continue;
          const token = accessor
            .getChildren(sourceFile)
            .find((child) => child.kind === keyword);
          if (!token) throw new Error(`${where} has no ${ts.SyntaxKind[keyword]} to replace`);
          add(path.resolve(sourceFile.fileName), {
            range: rangeOf(sourceFile, token.getStart(sourceFile), accessor.name.getEnd()),
            newText: name,
          });
        }
      }

      edit = { changes };
      warnings = [COMPUTED_KEY_WARNING, ...conversion.warnings];
      useSites = conversion.useSites;
    }

    const filesChanged = filesTouched(edit);
    const newDiagnostics = (await diagnosticsIntroducedBy(session, edit)).map((d) => d.text);
    const output = {
      edit,
      filesChanged,
      newDiagnostics,
      warnings,
      useSites: useSites.sort(
        (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.character - b.character,
      ),
    };

    if (input.apply !== true || newDiagnostics.length > 0) return { applied: false, ...output };
    session.invalidate(await applyWorkspaceEdit(edit));
    return { applied: true, ...output };
  },
};

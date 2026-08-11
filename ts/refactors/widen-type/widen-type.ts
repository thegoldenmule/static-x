import path from 'node:path';
import ts from 'typescript';
import { applyWorkspaceEdit } from '../../../core/edits/index.js';
import type { Tool, WorkspaceEdit } from '../../../core/tool/index.js';
import { declarationAt, resolveTarget, SYMBOL_TARGET_PROPERTIES } from '../../ast/targets.js';
import type { TsProjectSession } from '../../project/index.js';
import { diagnosticsIntroducedBy } from '../guard.js';
import { filesTouched, refactorOutputSchema, type RefactorOutput } from '../output.js';
import { formatSettings, userPreferences } from '../refactor-action.js';
import { classifyReferences, isUse } from '../references.js';
import { unalias } from '../substitution.js';
import { mergeWorkspaceEdits, toWorkspaceEdit } from '../text-changes.js';

/**
 * Replaces a type annotation with the least specific type that still
 * typechecks — ReSharper's Use Base Type Where Possible.
 *
 * **This is a search, not an analysis, and that is the whole design.**
 * "Still typechecks everywhere" is not something this tool has to
 * reason about: it is literally what `diagnosticsIntroducedBy`
 * computes. So the tool proposes a candidate annotation, typechecks the
 * whole project with it, and keeps the first one that comes back clean.
 * Where every other refactoring here uses the guard as a backstop under
 * an analysis it hopes is right, this one uses the guard as the answer.
 * A wrong candidate cannot ship; the worst a bad candidate generator
 * can do is waste a typecheck.
 *
 * That holds because a type annotation is *erased*. Changing one cannot
 * change what the program does at runtime, so every consequence of the
 * change is a compile-time consequence, and the compile is exactly what
 * the guard runs. There are two documented exceptions, and both are
 * refused or warned about before any candidate is built rather than
 * after: `emitDecoratorMetadata`, which turns an annotation into an
 * emitted runtime constructor reference, and declaration emit, which
 * carries the annotation past the edge of this compilation to consumers
 * the guard never sees.
 *
 * TypeScript is structurally typed, so the candidates are richer than
 * ReSharper's declared ancestors: any named type the annotated type
 * satisfies qualifies, and in `structural` mode a type synthesized from
 * exactly the members the code touches qualifies too.
 */

export type WidenMode = 'declared' | 'structural';

export interface WidenTypeInput {
  symbol?: string;
  file?: string;
  line?: number;
  character?: number;
  /**
   * `declared` (default) tries named types — ancestors first, then any
   * other named type the annotation satisfies. `structural` also tries
   * a type literal built from the members actually used.
   */
  mode?: WidenMode;
  /** How many candidates to typecheck. Default 8, maximum 32. */
  maxCandidates?: number;
  apply?: boolean;
}

/** A candidate the search tried and the compiler rejected. */
export interface RejectedCandidate {
  type: string;
  reason: string;
}

export interface WidenTypeOutput extends RefactorOutput {
  /** The annotation as written today. */
  from: string;
  /** The annotation chosen, or undefined when nothing widened. */
  to: string | undefined;
  /**
   * The search space, widest first. Everything before `to` was
   * typechecked and rejected; everything after it was never reached,
   * because the search stops at the first candidate that compiles.
   */
  candidates: string[];
  /** Candidates the compiler ruled out, with the diagnostic that did it. */
  rejected: RejectedCandidate[];
}

const DEFAULT_MAX_CANDIDATES = 8;
const MAX_MAX_CANDIDATES = 32;

/** Declarations that carry a widenable annotation. */
type Annotated =
  | ts.ParameterDeclaration
  | ts.VariableDeclaration
  | ts.PropertyDeclaration
  | ts.PropertySignature;

function isAnnotatable(node: ts.Node): node is Annotated {
  return (
    ts.isParameter(node) ||
    ts.isVariableDeclaration(node) ||
    ts.isPropertyDeclaration(node) ||
    ts.isPropertySignature(node)
  );
}

function locate(declaration: ts.Node): string {
  const sourceFile = declaration.getSourceFile();
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(
    declaration.getStart(sourceFile),
  );
  return `${sourceFile.fileName}:${line + 1}:${character + 1}`;
}

/**
 * Annotatable declarations named `symbol`.
 *
 * The shared `resolveTarget` resolves same-file duplicates to the first
 * match, on the reasoning that overloads and declaration merges name
 * one symbol. That reasoning does not hold here: three functions in one
 * file with a parameter called `value` are three unrelated symbols, and
 * silently widening the first would be a confidently wrong refactor.
 * So this searches for itself and refuses a tie.
 */
function findAnnotated(
  session: TsProjectSession,
  symbol: string,
  fileFilter?: string,
): Annotated[] {
  const found: Annotated[] = [];
  for (const sourceFile of session.sourceFiles()) {
    if (fileFilter && !sourceFile.fileName.endsWith(fileFilter)) continue;
    const visit = (node: ts.Node): void => {
      if (isAnnotatable(node) && ts.isIdentifier(node.name) && node.name.text === symbol) {
        found.push(node);
      }
      node.forEachChild(visit);
    };
    visit(sourceFile);
  }
  return found;
}

function resolveAnnotated(session: TsProjectSession, input: WidenTypeInput): Annotated {
  if (input.symbol !== undefined) {
    const candidates = findAnnotated(session, input.symbol, input.file);
    if (candidates.length === 0) {
      throw new Error(
        `No parameter, variable, or property named "${input.symbol}" found in project`,
      );
    }
    if (candidates.length > 1) {
      throw new Error(
        `"${input.symbol}" names ${String(candidates.length)} declarations; disambiguate with ` +
          `file/line/character:\n  ${candidates.map(locate).join('\n  ')}`,
      );
    }
    return candidates[0]!;
  }

  const declaration = declarationAt(resolveTarget(session, input));
  if (!isAnnotatable(declaration)) {
    throw new Error(
      'A type annotation belongs to a parameter, variable, or property; the declaration here ' +
        `is a ${ts.SyntaxKind[declaration.kind]}`,
    );
  }
  return declaration;
}

/**
 * The expression that denotes the annotated value at a reference.
 *
 * For a parameter the reference *is* the value; for a property the
 * reference is the name in `shelter.star`, and the value is the whole
 * access. Getting this wrong reads members off the receiver instead of
 * off the annotated declaration.
 */
function valueExpression(node: ts.Node): ts.Node {
  const parent = node.parent as ts.Node | undefined;
  if (parent && ts.isPropertyAccessExpression(parent) && parent.name === node) return parent;
  return node;
}

/**
 * Members the project actually reads off the annotated value.
 *
 * This is not what decides the answer — the guard does — but it is a
 * cheap necessary condition: a candidate missing a member the code
 * reads cannot possibly typecheck, so filtering on it skips a
 * whole-project typecheck that was certain to fail. Uses that are not
 * member reads (the value passed on, spread, compared) add nothing here
 * and are left entirely to the guard.
 */
function usedMembers(session: TsProjectSession, declaration: Annotated): Set<string> {
  const sourceFile = declaration.getSourceFile();
  const members = new Set<string>();
  const references = classifyReferences(
    session,
    sourceFile.fileName,
    declaration.name.getStart(sourceFile),
  );
  for (const reference of references) {
    if (!isUse(reference)) continue;
    const value = valueExpression(reference.node);
    const parent = value.parent as ts.Node | undefined;
    if (!parent) continue;

    if (ts.isPropertyAccessExpression(parent) && parent.expression === value) {
      members.add(parent.name.getText(parent.getSourceFile()));
      continue;
    }
    if (
      ts.isElementAccessExpression(parent) &&
      parent.expression === value &&
      ts.isStringLiteralLike(parent.argumentExpression)
    ) {
      members.add(parent.argumentExpression.text);
      continue;
    }
    // `const { name, age } = pet` reads members through a pattern.
    const pattern =
      ts.isVariableDeclaration(parent) && parent.initializer === value
        ? parent.name
        : undefined;
    if (pattern && ts.isObjectBindingPattern(pattern)) {
      for (const element of pattern.elements) {
        const key = element.propertyName ?? element.name;
        if (ts.isIdentifier(key) || ts.isStringLiteral(key)) members.add(key.text);
      }
    }
  }
  return members;
}

interface Candidate {
  /** The text written into the annotation. */
  text: string;
  /** Named candidates carry a symbol; a synthesized literal does not. */
  symbol?: ts.Symbol;
}

/** A candidate that is an existing named type, so it can be ordered. */
interface NamedCandidate extends Candidate {
  symbol: ts.Symbol;
  type: ts.Type;
}

/** Types named by a declaration's own `extends`/`implements` clauses. */
function heritageOf(checker: ts.TypeChecker, type: ts.Type): ts.Type[] {
  const types: ts.Type[] = [];
  for (const declaration of type.getSymbol()?.declarations ?? []) {
    if (!ts.isClassLike(declaration) && !ts.isInterfaceDeclaration(declaration)) continue;
    for (const clause of declaration.heritageClauses ?? []) {
      // Both clause kinds matter: getBaseTypes reports only `extends`
      // for a class, so `implements Aged` would otherwise be invisible.
      for (const expression of clause.types) types.push(checker.getTypeAtLocation(expression));
    }
  }
  return types;
}

/** Every ancestor of `type`, transitively, nearest first. */
function ancestorsOf(checker: ts.TypeChecker, type: ts.Type): ts.Type[] {
  const seen = new Set<ts.Type>([type]);
  const ordered: ts.Type[] = [];
  let frontier = [type];
  while (frontier.length > 0) {
    const next: ts.Type[] = [];
    for (const current of frontier) {
      for (const parent of heritageOf(checker, current)) {
        if (seen.has(parent)) continue;
        seen.add(parent);
        ordered.push(parent);
        next.push(parent);
      }
    }
    frontier = next;
  }
  return ordered;
}

/** Named type declarations the project holds, in source order. */
function namedTypesInProject(session: TsProjectSession): ts.Node[] {
  const declarations: ts.Node[] = [];
  for (const sourceFile of session.sourceFiles()) {
    const visit = (node: ts.Node): void => {
      if (
        ts.isInterfaceDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isTypeAliasDeclaration(node)
      ) {
        declarations.push(node);
      }
      node.forEachChild(visit);
    };
    visit(sourceFile);
  }
  return declarations;
}

/**
 * Every name visible at `site`, indexed.
 *
 * Built once because `getSymbolsInScope` walks the whole symbol table —
 * over two thousand symbols in a project with the default lib — and the
 * search asks about it once per named type in the project.
 *
 * The meaning has to be `SymbolFlags.All`. An imported binding's flags
 * are `Alias`, not `Type`, so asking for `SymbolFlags.Type` silently
 * omits every type the file imported, which is most of them — and the
 * tool would then propose importing a name the file already has.
 */
function scopeIndex(checker: ts.TypeChecker, site: ts.Node): Map<string, ts.Symbol[]> {
  const index = new Map<string, ts.Symbol[]>();
  for (const symbol of checker.getSymbolsInScope(site, ts.SymbolFlags.All)) {
    const name = symbol.getName();
    index.set(name, [...(index.get(name) ?? []), symbol]);
  }
  return index;
}

/**
 * A symbol that is written down under the name it reports.
 *
 * The check exists because `type Shape = { name: string }` produces a
 * type whose own symbol is the *type literal*, named `__type`. Trusting
 * `type.getSymbol().getName()` would propose `__type` as an annotation
 * — measured, not guessed.
 */
function declaresItsName(symbol: ts.Symbol): boolean {
  return (symbol.declarations ?? []).some(
    (declaration) =>
      (ts.isInterfaceDeclaration(declaration) ||
        ts.isClassDeclaration(declaration) ||
        ts.isTypeAliasDeclaration(declaration) ||
        ts.isEnumDeclaration(declaration)) &&
      declaration.name !== undefined &&
      ts.isIdentifier(declaration.name) &&
      declaration.name.text === symbol.getName(),
  );
}

/**
 * The name a candidate type would be written as, or undefined when it
 * has none that can be written.
 *
 * An alias wins over the type's own symbol: `type DogBox = Box<string>`
 * is spelled `DogBox` in one token, where its underlying type would
 * need `Box<string>` reassembled from type arguments. A type that still
 * needs type arguments after that is skipped rather than written wrong
 * — the only ready source of that text is `typeToString`, which falls
 * back to an absolute `import("/…")` path for anything out of scope.
 */
function writableName(
  checker: ts.TypeChecker,
  type: ts.Type,
): { text: string; symbol: ts.Symbol } | undefined {
  const alias = type.aliasSymbol;
  if (alias) {
    if ((type.aliasTypeArguments ?? []).length > 0) return undefined;
    return declaresItsName(alias) ? { text: alias.getName(), symbol: alias } : undefined;
  }
  const symbol = type.getSymbol();
  if (!symbol || !declaresItsName(symbol)) return undefined;
  if (checker.getTypeArguments(type as ts.TypeReference).length > 0) return undefined;
  const generic = (symbol.declarations ?? []).some(
    (declaration) => (declaration as ts.ClassLikeDeclaration).typeParameters?.length,
  );
  return generic ? undefined : { text: symbol.getName(), symbol };
}

/**
 * Whether the candidate's name can simply be written at the annotation.
 *
 * `'in-scope'` when the name already resolves to this very symbol,
 * `'importable'` when nothing there claims the name, and `'taken'` when
 * something else does — where an import would be TS2440 rather than a
 * widening.
 */
function nameAvailability(
  checker: ts.TypeChecker,
  scope: ReadonlyMap<string, ts.Symbol[]>,
  symbol: ts.Symbol,
): 'in-scope' | 'importable' | 'taken' {
  const claimants = scope.get(symbol.getName());
  if (!claimants || claimants.length === 0) return 'importable';
  return claimants.some((claimant) => unalias(checker, claimant) === symbol)
    ? 'in-scope'
    : 'taken';
}

/**
 * The member list of a synthesized type literal, or undefined when a
 * member cannot be written down.
 *
 * `typeToString` falls back to `import("/absolute/path").Name` for a
 * type whose name is not in scope, which is a machine-specific absolute
 * path — never something to write into a source file. A member that
 * stringifies that way disqualifies the whole synthesis.
 */
function synthesizeMembers(
  checker: ts.TypeChecker,
  type: ts.Type,
  site: ts.Node,
  members: ReadonlySet<string>,
): string[] | undefined {
  const written: string[] = [];
  for (const name of [...members].sort()) {
    const property = checker.getPropertyOfType(type, name);
    if (!property) return undefined;
    const propertyType = checker.getTypeOfSymbolAtLocation(property, site);
    const optional = (property.flags & ts.SymbolFlags.Optional) !== 0 ? '?' : '';
    const readonly = (property.declarations ?? []).some(
      (declaration) =>
        (ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Readonly) !== 0,
    )
      ? 'readonly '
      : '';

    // Methods stay methods. A method written as a property is checked
    // contravariantly under strictFunctionTypes while the method it
    // came from is bivariant, so the property spelling can fail where
    // the original passed — losing a widening that was in fact legal.
    const isMethod = (property.declarations ?? []).some(
      (declaration) =>
        ts.isMethodDeclaration(declaration) || ts.isMethodSignature(declaration),
    );
    const signatures = checker.getSignaturesOfType(propertyType, ts.SignatureKind.Call);
    if (isMethod && signatures.length > 0 && optional === '') {
      for (const signature of signatures) {
        written.push(`${name}${checker.signatureToString(signature, site)};`);
      }
      continue;
    }
    written.push(
      `${readonly}${name}${optional}: ${checker.typeToString(propertyType, site, ts.TypeFormatFlags.NoTruncation)};`,
    );
  }
  return written.some((member) => member.includes('import("')) ? undefined : written;
}

/**
 * Order candidates widest first, so the first one the guard accepts is
 * the least specific one that works.
 *
 * "Wider" is assignability: B is narrower than A when B is assignable
 * to A and A is not assignable to B. That is a partial order, not a
 * total one — `Named` and `Aged` are simply incomparable — so this
 * peels off maximal elements one layer at a time rather than sorting.
 */
function widestFirst(checker: ts.TypeChecker, candidates: NamedCandidate[]): NamedCandidate[] {
  const strictlyWider = (wide: NamedCandidate, narrow: NamedCandidate): boolean =>
    checker.isTypeAssignableTo(narrow.type, wide.type) &&
    !checker.isTypeAssignableTo(wide.type, narrow.type);

  const remaining = [...candidates];
  const ordered: NamedCandidate[] = [];
  while (remaining.length > 0) {
    const layer = remaining.filter(
      (candidate) => !remaining.some((other) => other !== candidate && strictlyWider(other, candidate)),
    );
    // A cycle of mutually assignable types would leave the layer empty;
    // take everything left rather than looping forever.
    const taken = layer.length > 0 ? layer : [...remaining];
    taken.sort(
      (a, b) =>
        checker.getPropertiesOfType(a.type).length - checker.getPropertiesOfType(b.type).length ||
        a.text.localeCompare(b.text),
    );
    ordered.push(...taken);
    for (const candidate of taken) remaining.splice(remaining.indexOf(candidate), 1);
  }
  return ordered;
}

/**
 * Ask the language service for the import a candidate name needs.
 *
 * Authoring this by hand would mean re-deciding quote style, specifier
 * extension, whether an existing import from that module should absorb
 * the name, and where in the sorted list it goes. The engine already
 * knows, and it answers the question in the only place it can be asked:
 * against a file that has the annotation and therefore the TS2304.
 *
 * The fix's offsets are measured in the patched text, so they are
 * mapped back through the single replacement that produced it.
 */
function importFixFor(
  session: TsProjectSession,
  file: string,
  patched: string,
  replaced: { start: number; end: number; newLength: number },
): ts.TextChange[] | undefined {
  const service = session.languageService();
  const restore = service.overlay(new Map([[file, patched]]));
  try {
    const missing = service.service
      .getSemanticDiagnostics(file)
      .filter(
        (diagnostic) =>
          diagnostic.code === 2304 &&
          diagnostic.start !== undefined &&
          diagnostic.start >= replaced.start &&
          diagnostic.start < replaced.start + replaced.newLength,
      );
    if (missing.length !== 1) return undefined;
    const at = missing[0]!;
    const fixes = service.service.getCodeFixesAtPosition(
      file,
      at.start!,
      at.start! + (at.length ?? 0),
      [2304],
      formatSettings(session),
      userPreferences(session),
    );
    const fix = fixes.find((action) => action.fixName === 'import');
    if (!fix) return undefined;
    // An import fix is local by construction; anything else is a
    // different action wearing the same name, and is not trusted.
    if (fix.changes.length !== 1 || path.resolve(fix.changes[0]!.fileName) !== path.resolve(file)) {
      return undefined;
    }

    const mapped: ts.TextChange[] = [];
    for (const change of fix.changes[0]!.textChanges) {
      const start = change.span.start;
      if (start <= replaced.start) {
        mapped.push(change);
        continue;
      }
      if (start >= replaced.start + replaced.newLength) {
        mapped.push({
          ...change,
          span: {
            ...change.span,
            start: start - replaced.newLength + (replaced.end - replaced.start),
          },
        });
        continue;
      }
      return undefined; // inside the new annotation: not an import edit
    }
    return mapped;
  } finally {
    restore();
  }
}

/** Is the declaration reachable from outside this compilation? */
function isExported(declaration: Annotated): boolean {
  for (let node: ts.Node | undefined = declaration; node; node = node.parent) {
    if (ts.canHaveModifiers(node) && ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export) {
      return true;
    }
    if (ts.isSourceFile(node)) return false;
  }
  return false;
}

/** Decorators on the declaration or the member it belongs to. */
function hasDecorators(declaration: Annotated): boolean {
  if (ts.canHaveDecorators(declaration) && (ts.getDecorators(declaration)?.length ?? 0) > 0) {
    return true;
  }
  const owner = ts.isParameter(declaration) ? declaration.parent : undefined;
  return (
    owner !== undefined &&
    ts.canHaveDecorators(owner) &&
    (ts.getDecorators(owner)?.length ?? 0) > 0
  );
}

export const widenType: Tool<WidenTypeInput, WidenTypeOutput, TsProjectSession> = {
  name: 'ts/refactors/widen-type',
  description:
    'Replaces a type annotation on a parameter, variable, or property with the least specific ' +
    "type that still typechecks everywhere — ReSharper's Use Base Type Where Possible. This " +
    'is a search, not an analysis: each candidate annotation is typechecked against the whole ' +
    'project in memory and the first one that introduces no diagnostic wins, which is sound ' +
    'because a type annotation is erased and every consequence of changing one is therefore a ' +
    'compile-time consequence. mode: declared (default) tries the annotated type\'s extends ' +
    'and implements ancestors and any other named type in the project it satisfies, widest ' +
    'first; mode: structural also tries a type literal synthesized from exactly the members ' +
    'the code reads. An import for the chosen name is added when the file lacks one. Refuses a ' +
    'declaration with no annotation (inference already widened it), one already as wide as ' +
    'anything available, and — because the guard is blind there — a decorated declaration in a ' +
    'project with emitDecoratorMetadata, where the annotation is emitted as a runtime value. ' +
    'candidates is the search space widest first, rejected carries the compiler diagnostic that ' +
    'ruled each failure out, and to is undefined when nothing widened. At most maxCandidates ' +
    '(default 8) whole-project typechecks are run. Dry-run by default.',
  inputSchema: {
    type: 'object',
    properties: {
      ...SYMBOL_TARGET_PROPERTIES,
      symbol: {
        type: 'string',
        description: 'Parameter, variable, or property name to target',
      },
      mode: {
        type: 'string',
        enum: ['declared', 'structural'],
        description: 'Named ancestors and satisfied interfaces (default), or also a synthesized type literal',
      },
      maxCandidates: {
        type: 'integer',
        minimum: 1,
        maximum: MAX_MAX_CANDIDATES,
        description: `Candidates to typecheck, each a whole-project pass (default ${String(DEFAULT_MAX_CANDIDATES)})`,
      },
      apply: { type: 'boolean', description: 'Write the edit to disk (default false)' },
    },
    additionalProperties: false,
  },
  outputSchema: refactorOutputSchema(
    {
      from: { type: 'string' },
      to: { type: 'string' },
      candidates: { type: 'array', items: { type: 'string' } },
      rejected: {
        type: 'array',
        items: {
          type: 'object',
          properties: { type: { type: 'string' }, reason: { type: 'string' } },
          required: ['type', 'reason'],
        },
      },
    },
    ['from', 'candidates', 'rejected'],
  ),

  async run(session, input) {
    const declaration = resolveAnnotated(session, input);
    const sourceFile = declaration.getSourceFile();
    const name = declaration.name.getText(sourceFile);

    if (sourceFile.isDeclarationFile) {
      throw new Error(`"${name}" is declared in a .d.ts file, which this tool does not rewrite`);
    }
    const annotation = declaration.type;
    if (!annotation) {
      throw new Error(
        `"${name}" at ${locate(declaration)} has no type annotation, so there is nothing to ` +
          'widen — inference already gave it the widest type its initializer supports.',
      );
    }
    if (ts.isParameter(declaration) && declaration.dotDotDotToken) {
      throw new Error(`"${name}" is a rest parameter, whose annotation types the whole list`);
    }

    // The one place a type annotation is not erased: with
    // emitDecoratorMetadata the compiler emits design:type as a runtime
    // reference to the annotated constructor, so widening the
    // annotation changes what the program does. The guard typechecks;
    // it never looks at emit, so this has to be refused up front.
    if (session.parsedConfig().options.emitDecoratorMetadata === true && hasDecorators(declaration)) {
      throw new Error(
        `"${name}" at ${locate(declaration)} is decorated and this project sets ` +
          'emitDecoratorMetadata, which emits the annotation as a runtime design:type value. ' +
          'Widening it would change what the emitted code does, and a typecheck cannot see that.',
      );
    }

    const checker = session.checker();
    const declared = checker.getTypeFromTypeNode(annotation);
    const from = annotation.getText(sourceFile);
    if (declared.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) {
      throw new Error(`"${name}" is annotated \`${from}\`, and nothing is wider than that`);
    }

    const members = usedMembers(session, declaration);
    const mode: WidenMode = input.mode ?? 'declared';

    // Named candidates: ancestors first, then anything else in the
    // project the annotated type satisfies. Order here only seeds the
    // set; widestFirst decides what is actually tried first.
    const scope = scopeIndex(checker, annotation);
    const seen = new Set<ts.Type>([declared]);
    const named: NamedCandidate[] = [];
    const consider = (type: ts.Type): void => {
      if (seen.has(type)) return;
      seen.add(type);
      // `any` would silence errors rather than widen: the guard reports
      // diagnostics an edit *introduces*, so an annotation that erases
      // existing ones passes it trivially.
      if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return;
      const written = writableName(checker, type);
      if (!written) return;
      if (!checker.isTypeAssignableTo(declared, type)) return;
      if (nameAvailability(checker, scope, written.symbol) === 'taken') return;
      // Cheap necessary condition — see usedMembers.
      for (const member of members) {
        if (!checker.getPropertyOfType(type, member)) return;
      }
      named.push({ ...written, type });
    };

    for (const ancestor of ancestorsOf(checker, declared)) consider(ancestor);
    for (const declarationNode of namedTypesInProject(session)) {
      consider(checker.getTypeAtLocation(declarationNode));
    }

    const candidates: Candidate[] = widestFirst(checker, named);
    if (mode === 'structural') {
      // Widest of all: a type with only the members the code reads.
      // Nothing named can be wider, since a named type that typechecks
      // must carry those members too.
      const synthesized =
        members.size === 0
          ? 'unknown'
          : (() => {
              const written = synthesizeMembers(checker, declared, annotation, members);
              return written ? `{ ${written.join(' ')} }` : undefined;
            })();
      if (synthesized !== undefined && synthesized !== from) {
        candidates.unshift({ text: synthesized });
      }
    }

    if (candidates.length === 0) {
      throw new Error(
        `\`${from}\` is already the widest annotation available for "${name}" at ` +
          `${locate(declaration)}${
            members.size === 0
              ? ''
              : `: nothing it inherits or satisfies carries ${[...members].sort().map((m) => `"${m}"`).join(', ')}`
          }. Try mode: "structural" for a type built from the members actually used.`,
      );
    }

    const bound = Math.min(input.maxCandidates ?? DEFAULT_MAX_CANDIDATES, MAX_MAX_CANDIDATES);
    const warnings: string[] = [];
    if (candidates.length > bound) {
      warnings.push(
        `${String(candidates.length)} candidates were generated and the widest ${String(bound)} ` +
          'were typechecked; each candidate costs a whole-project pass. Raise maxCandidates to ' +
          'search further.',
      );
    }
    const tried = candidates.slice(0, bound);

    const replaced = { start: annotation.getStart(sourceFile), end: annotation.getEnd() };
    const originalText = sourceFile.getFullText();
    const file = path.resolve(sourceFile.fileName);

    const buildEdit = (candidate: Candidate): WorkspaceEdit | undefined => {
      const annotationEdit = toWorkspaceEdit(session, [
        {
          fileName: sourceFile.fileName,
          textChanges: [
            {
              span: { start: replaced.start, length: replaced.end - replaced.start },
              newText: candidate.text,
            },
          ],
        },
      ]);
      const availability = candidate.symbol
        ? nameAvailability(checker, scope, candidate.symbol)
        : 'in-scope';
      if (availability === 'in-scope') return annotationEdit;

      const patched =
        originalText.slice(0, replaced.start) + candidate.text + originalText.slice(replaced.end);
      const fix = importFixFor(session, file, patched, {
        ...replaced,
        newLength: candidate.text.length,
      });
      if (!fix) return undefined;
      return mergeWorkspaceEdits(
        annotationEdit,
        toWorkspaceEdit(session, [{ fileName: sourceFile.fileName, textChanges: fix }]),
      );
    };

    const rejected: RejectedCandidate[] = [];
    let chosen: { candidate: Candidate; edit: WorkspaceEdit } | undefined;
    for (const candidate of tried) {
      const edit = buildEdit(candidate);
      if (!edit) {
        rejected.push({
          type: candidate.text,
          reason: `${candidate.text} is not in scope in ${path.relative(session.rootPath, file)} and no import for it could be generated`,
        });
        continue;
      }
      const introduced = await diagnosticsIntroducedBy(session, edit);
      if (introduced.length === 0) {
        chosen = { candidate, edit };
        break;
      }
      rejected.push({ type: candidate.text, reason: introduced[0]!.text });
    }

    const candidateNames = tried.map((candidate) => candidate.text);
    if (!chosen) {
      return {
        applied: false,
        edit: { changes: {} },
        filesChanged: [],
        newDiagnostics: [],
        warnings,
        from,
        to: undefined,
        candidates: candidateNames,
        rejected,
      };
    }

    if (isExported(declaration)) {
      warnings.push(
        `"${name}" is exported, so its annotation is part of this module's public surface. The ` +
          'guard typechecks this project only: a consumer outside it — another package, a ' +
          'declaration-emit consumer — sees the annotation change and is not covered here.',
      );
    }

    const edit = chosen.edit;
    const filesChanged = filesTouched(edit);
    const newDiagnostics: string[] = [];
    const output = {
      edit,
      filesChanged,
      newDiagnostics,
      warnings,
      from,
      to: chosen.candidate.text,
      candidates: candidateNames,
      rejected,
    };

    if (input.apply !== true) return { applied: false, ...output };
    const written = await applyWorkspaceEdit(edit);
    session.invalidate(written);
    return { applied: true, ...output };
  },
};

import path from 'node:path';
import ts from 'typescript';
import { applyWorkspaceEdit } from '../../../core/edits/index.js';
import type { TextEdit, Tool, WorkspaceEdit } from '../../../core/tool/index.js';
import { tokenKey } from '../../ast/structural.js';
import { declarationAt, resolveTarget, SYMBOL_TARGET_PROPERTIES } from '../../ast/targets.js';
import type { TsProjectSession } from '../../project/index.js';
import { diagnosticsIntroducedBy } from '../guard.js';
import { filesTouched, refactorOutputSchema, type RefactorOutput } from '../output.js';
import { classifyReferences, type ClassifiedReference } from '../references.js';
import { unalias } from '../substitution.js';

/**
 * Replaces every reference to a `type X = …` alias with its right-hand
 * side and deletes the declaration — ReSharper's Inline type alias.
 *
 * The failure this exists to prevent is the type-level twin of the one
 * `inline-function` prevents, and it is just as invisible: `type Id =
 * string | number` used as `Id[]` becomes `string | number[]` if the
 * substitution is textual. That compiles. It is `string | number[]`,
 * which is not what anyone wrote, and no diagnostic will ever mention
 * it — so the guard cannot be the thing that catches it.
 *
 * Parentheses therefore come from the compiler rather than from a rule
 * invented here. Contrary to what the type-node factories look like
 * from the outside, TypeScript *does* ship a parenthesizer for types:
 * `createArrayTypeNode` runs `parenthesizeNonArrayTypeOfPostfixType`,
 * `createUnionTypeNode` runs `parenthesizeConstituentTypesOfUnionType`,
 * and so on down to conditional check and extends slots. Those rules
 * run on parsed nodes as happily as on synthesized ones, so this asks
 * them the question directly: rebuild the use site's parent with the
 * right-hand side in the slot, and see whether the factory wrapped it.
 *
 * Then it checks the answer. Every substitution is spliced into a copy
 * of the enclosing type, re-parsed, and the node landing in the slot is
 * compared token-for-token against the right-hand side. A precedence
 * mistake — the factory's, or this tool's, in a position the factory
 * has no rule for — stops being a silent rewrite and becomes a refusal.
 */

export interface InlineTypeAliasInput {
  symbol?: string;
  file?: string;
  line?: number;
  character?: number;
  apply?: boolean;
}

export interface TypeUseSite {
  file: string;
  line: number;
  character: number;
}

export interface InlineTypeAliasOutput extends RefactorOutput {
  /** Every reference the edit replaces with the right-hand side. */
  useSites: TypeUseSite[];
  /** The right-hand side that was substituted, as written. */
  definition: string;
}

/**
 * The outermost identifier of each name the type depends on — `Sensor`
 * in `{ source: Sensor }`, `ns` in `ns.Frame`, `Record` and `Id` in
 * `Record<string, Id>`.
 *
 * Only the roots of type references and `typeof` queries count. A
 * property name, a parameter name, a string-literal type and a keyword
 * type are not references to anything a scope could fail to provide, so
 * they never reach this list; a name introduced *inside* the right-hand
 * side (`<T>(x: T) => T`, `infer U`, `{ [K in Keys]: … }`) is bound
 * there and travels with it, so `bound` excludes it.
 */
function dependencyRoots(type: ts.TypeNode): ts.Identifier[] {
  const roots: ts.Identifier[] = [];
  const entityRoot = (name: ts.EntityName): ts.Identifier =>
    ts.isIdentifier(name) ? name : entityRoot(name.left);
  const visit = (node: ts.Node): void => {
    if (ts.isTypeReferenceNode(node)) {
      roots.push(entityRoot(node.typeName));
      node.typeArguments?.forEach(visit);
      return;
    }
    if (ts.isTypeQueryNode(node)) {
      roots.push(entityRoot(node.exprName));
      node.typeArguments?.forEach(visit);
      return;
    }
    if (ts.isImportTypeNode(node)) {
      // `import('./m.js').X` resolves through the module, not the scope.
      node.typeArguments?.forEach(visit);
      return;
    }
    node.forEachChild(visit);
  };
  visit(type);

  const bound = new Set<string>();
  const collectBound = (node: ts.Node): void => {
    if (ts.isTypeParameterDeclaration(node) && ts.isIdentifier(node.name)) bound.add(node.name.text);
    node.forEachChild(collectBound);
  };
  collectBound(type);
  return roots.filter((root) => !bound.has(root.text));
}

export interface ScopeConflict {
  name: string;
  reason: 'missing' | 'different';
}

/**
 * Names in the right-hand side that would mean something else — or
 * nothing — where the alias is used.
 *
 * `SymbolFlags.All`, not `Type`: an imported binding's own flags are
 * `Alias`, so a narrower meaning omits every `import type { … }` and
 * reports a file that can see the name perfectly well as missing it.
 * Measured on this fixture, `SymbolFlags.Type` finds 1761 names at a
 * site and `Packet` is not among them; `All` finds 2140 and it is.
 */
function scopeConflicts(
  checker: ts.TypeChecker,
  roots: readonly ts.Identifier[],
  site: ts.Node,
): ScopeConflict[] {
  const atSite = new Map<string, ts.Symbol>();
  for (const symbol of checker.getSymbolsInScope(site, ts.SymbolFlags.All)) {
    if (!atSite.has(symbol.name)) atSite.set(symbol.name, unalias(checker, symbol));
  }

  const conflicts: ScopeConflict[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    if (seen.has(root.text)) continue;
    seen.add(root.text);
    const declared = checker.getSymbolAtLocation(root);
    if (!declared) continue;
    const there = atSite.get(root.text);
    if (!there) conflicts.push({ name: root.text, reason: 'missing' });
    else if (there !== unalias(checker, declared)) {
      conflicts.push({ name: root.text, reason: 'different' });
    }
  }
  return conflicts;
}

/** What the target turned out to be, for the refusal message. */
function describeKind(declaration: ts.NamedDeclaration): string {
  if (ts.isInterfaceDeclaration(declaration)) return 'an interface';
  if (ts.isClassDeclaration(declaration)) return 'a class';
  if (ts.isEnumDeclaration(declaration)) return 'an enum';
  if (ts.isVariableDeclaration(declaration)) return 'a variable';
  if (ts.isFunctionDeclaration(declaration)) return 'a function';
  if (ts.isModuleDeclaration(declaration)) return 'a namespace';
  return `a ${ts.SyntaxKind[declaration.kind]}`;
}

/** Where a node sits in a `declare` context, described, or undefined. */
function ambientContext(node: ts.Node): string | undefined {
  if (node.getSourceFile().isDeclarationFile) return 'a declaration file';
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (ts.isModuleDeclaration(current)) {
      if (current.flags & ts.NodeFlags.GlobalAugmentation) return 'a `declare global` block';
      if (ts.isStringLiteral(current.name)) return 'a `declare module` block';
    }
    if (
      ts.canHaveModifiers(current) &&
      ts.getModifiers(current)?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword)
    ) {
      return 'a `declare` statement';
    }
  }
  return undefined;
}

/**
 * Whether the right-hand side needs wrapping where the alias sat, asked
 * of the compiler's own parenthesizer.
 *
 * Each branch rebuilds the parent node with `rhs` in the slot the alias
 * occupied; the factory runs its parenthesizer rule at construction and
 * inserts a `ParenthesizedType` when the position demands one. The
 * positions with no branch here — a type argument, a tuple element, a
 * member's type, a template-literal span, a function type's return —
 * are delimited by a bracket, a brace, a comma or a keyword, and the
 * factory has no rule for them because none is needed.
 */
function parenthesizedByFactory(rhs: ts.TypeNode, site: ts.TypeNode): boolean {
  const parent = site.parent as ts.Node | undefined;
  if (!parent) return false;
  const factory = ts.factory;
  const wrapped = (node: ts.Node): boolean => ts.isParenthesizedTypeNode(node);

  if (ts.isArrayTypeNode(parent)) return wrapped(factory.createArrayTypeNode(rhs).elementType);
  if (ts.isIndexedAccessTypeNode(parent) && parent.objectType === site) {
    return wrapped(factory.createIndexedAccessTypeNode(rhs, parent.indexType).objectType);
  }
  if (ts.isTypeOperatorNode(parent)) {
    return wrapped(factory.createTypeOperatorNode(parent.operator, rhs).type);
  }
  if (ts.isUnionTypeNode(parent)) return wrapped(factory.createUnionTypeNode([rhs]).types[0]!);
  if (ts.isIntersectionTypeNode(parent)) {
    return wrapped(factory.createIntersectionTypeNode([rhs]).types[0]!);
  }
  if (ts.isOptionalTypeNode(parent)) return wrapped(factory.createOptionalTypeNode(rhs).type);
  if (ts.isConditionalTypeNode(parent)) {
    const rebuilt = factory.createConditionalTypeNode(
      parent.checkType === site ? rhs : parent.checkType,
      parent.extendsType === site ? rhs : parent.extendsType,
      parent.trueType,
      parent.falseType,
    );
    if (parent.checkType === site) return wrapped(rebuilt.checkType);
    if (parent.extendsType === site) return wrapped(rebuilt.extendsType);
    return false;
  }
  return false;
}

/**
 * The largest type node the use site is part of — what the re-parse
 * check has to reconstruct. `NamedTupleMember` is named separately
 * because `[a: Id]` would otherwise stop the climb at a fragment that
 * does not stand alone as a type.
 */
function outermostType(node: ts.TypeNode): ts.TypeNode {
  let current: ts.TypeNode = node;
  while (
    current.parent !== undefined &&
    (ts.isTypeNode(current.parent) || ts.isNamedTupleMember(current.parent))
  ) {
    current = current.parent;
  }
  return current;
}

/**
 * Re-parse the enclosing type with the substitution in it, and confirm
 * the right-hand side still parses as the same tree.
 *
 * This is the check that makes the parenthesization claim verifiable
 * rather than argued. `Id[]` substituted without parentheses re-parses
 * as `string | (number[])`, whose token stream is not the right-hand
 * side's, and the substitution is refused instead of written.
 */
function survivesReparse(
  site: ts.TypeNode,
  replacement: string,
  sourceFile: ts.SourceFile,
  rhsKey: string,
): boolean {
  const container = outermostType(site);
  const base = container.getStart(sourceFile);
  const text = container.getText(sourceFile);
  const spliced =
    text.slice(0, site.getStart(sourceFile) - base) + replacement + text.slice(site.getEnd() - base);

  const prefix = 'type __inline_probe = ';
  const probe = ts.createSourceFile(
    '__inline-probe.ts',
    `${prefix}${spliced};`,
    ts.ScriptTarget.Latest,
    true,
  );
  const statement = probe.statements[0];
  if (!statement || !ts.isTypeAliasDeclaration(statement)) return false;
  // `parseDiagnostics` is not in the public surface, but a recovered
  // parse can still produce nodes at the right offsets, so a structural
  // comparison alone would call a syntax error a match.
  const parsed = probe as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] };
  if (parsed.parseDiagnostics !== undefined && parsed.parseDiagnostics.length > 0) return false;

  const start = prefix + text.slice(0, site.getStart(sourceFile) - base);
  const from = start.length;
  const to = from + replacement.length;
  let landed: ts.Node | undefined;
  const visit = (node: ts.Node): void => {
    if (node.getStart(probe) === from && node.getEnd() === to) landed ??= node;
    node.forEachChild(visit);
  };
  visit(statement.type);
  if (statement.type.getStart(probe) === from && statement.type.getEnd() === to) {
    landed ??= statement.type;
  }
  if (!landed) return false;
  const inner = ts.isParenthesizedTypeNode(landed) ? landed.type : landed;
  return tokenKey(inner, probe) === rhsKey;
}

interface Span {
  start: number;
  end: number;
}

/** Removing one name from a `{ a, b }` list takes its separator too. */
function elementSpan(
  element: ts.Node,
  elements: readonly ts.Node[],
  sourceFile: ts.SourceFile,
): Span {
  const index = elements.indexOf(element);
  const previous = index > 0 ? elements[index - 1] : undefined;
  if (previous) return { start: previous.getEnd(), end: element.getEnd() };
  const next = elements[1];
  return {
    start: element.getStart(sourceFile),
    end: next ? next.getStart(sourceFile) : element.getEnd(),
  };
}

/**
 * A node's own lines, plus a blank line it would otherwise leave
 * behind — unless it shares a line with other code, in which case the
 * line is not the unit to remove and only the node goes. `export type
 * Id = string; export const K = 1;` is unusual, and deleting `K` while
 * inlining `Id` would be a lot worse than the stray space left instead.
 */
function lineSpan(node: ts.Node, sourceFile: ts.SourceFile): Span {
  const text = sourceFile.getFullText();
  const nodeStart = node.getStart(sourceFile, /* includeJsDocComment */ true);
  const nodeEnd = node.getEnd();
  let start = nodeStart;
  while (start > 0 && text[start - 1] !== '\n') start--;
  let end = nodeEnd;
  while (end < text.length && text[end] !== '\n') end++;
  if (text.slice(start, nodeStart).trim() !== '' || text.slice(nodeEnd, end).trim() !== '') {
    return { start: nodeStart, end: nodeEnd };
  }
  if (end < text.length) end++;
  if (text.slice(end, end + 1) === '\n') end++;
  return { start, end };
}

/**
 * The span that unbinds the alias from one file.
 *
 * Once the declaration is gone, `import type { Id }` and
 * `export type { Id } from './types.js'` both name something that does
 * not exist — TS2305, a broken build rather than untidiness. The
 * re-export in particular is the one a project-wide edit forgets:
 * nothing in the barrel file changed, so nothing draws attention to it.
 */
function bindingSpan(node: ts.Node, sourceFile: ts.SourceFile): Span | undefined {
  const specifier = node.parent as ts.Node | undefined;
  if (specifier && ts.isImportSpecifier(specifier)) {
    const named = specifier.parent;
    const clause = named.parent;
    if (named.elements.length > 1) return elementSpan(specifier, named.elements, sourceFile);
    // `import Default, { Id } from` keeps the default and loses the group.
    if (clause.name) return { start: clause.name.getEnd(), end: named.getEnd() };
    return lineSpan(clause.parent, sourceFile);
  }
  if (specifier && ts.isExportSpecifier(specifier)) {
    const named = specifier.parent;
    if (named.elements.length > 1) return elementSpan(specifier, named.elements, sourceFile);
    return lineSpan(named.parent, sourceFile);
  }
  return undefined;
}

function toEdit(span: Span, sourceFile: ts.SourceFile, newText: string): TextEdit {
  return {
    range: {
      start: sourceFile.getLineAndCharacterOfPosition(span.start),
      end: sourceFile.getLineAndCharacterOfPosition(span.end),
    },
    newText,
  };
}

/**
 * What a use site replaces: the whole type reference, or the name in a
 * heritage clause.
 *
 * The reference a search reports is the identifier, which is not the
 * span to overwrite. `types.Id` is an identifier inside a
 * `QualifiedName` inside a `TypeReference`; replacing the identifier
 * alone leaves `types.` in front of the right-hand side.
 */
function replacedNode(
  reference: ClassifiedReference,
): { kind: 'type'; node: ts.TypeNode } | { kind: 'heritage'; node: ts.Node } | undefined {
  let current: ts.Node = reference.node;
  while (current.parent !== undefined && ts.isQualifiedName(current.parent)) current = current.parent;
  const parent = current.parent as ts.Node | undefined;
  if (!parent) return undefined;
  if (ts.isTypeReferenceNode(parent) && parent.typeName === current) {
    return { kind: 'type', node: parent };
  }
  if (ts.isExpressionWithTypeArguments(parent) && parent.expression === current) {
    return { kind: 'heritage', node: current };
  }
  return undefined;
}

export const inlineTypeAlias: Tool<
  InlineTypeAliasInput,
  InlineTypeAliasOutput,
  TsProjectSession
> = {
  name: 'ts/refactors/inline-type-alias',
  description:
    'Replaces every reference to a `type X = …` alias with its right-hand side and deletes the ' +
    "declaration, project-wide — ReSharper's Inline type alias. Targets the alias by name " +
    "(symbol) or exact position. Parentheses come from the compiler's own type parenthesizer " +
    'and every substitution is re-parsed and compared against the right-hand side before it is ' +
    'offered, so `type Id = string | number` used as `Id[]` becomes `(string | number)[]` and ' +
    'never the silently different `string | number[]`. Import specifiers and barrel re-exports ' +
    'naming the alias are removed with it. Refuses a generic alias (substituting type arguments ' +
    'positionally is a different and much harder refactoring), an alias whose right-hand side ' +
    'names something a using file cannot see or that means something else there, a use inside a ' +
    '`declare` block or a declaration file, a self-referential alias, and a use in an ' +
    'extends/implements clause where the right-hand side is not a type reference. Dry-run by ' +
    'default; apply: true writes to disk unless the typecheck reports newDiagnostics.',
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
      useSites: {
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
      definition: { type: 'string' },
    },
    ['useSites', 'definition'],
  ),

  async run(session, input) {
    const target = resolveTarget(session, input);
    const declaration = declarationAt(target);
    const name = declaration.name?.getText(target.sourceFile) ?? '(unnamed)';
    if (!ts.isTypeAliasDeclaration(declaration)) {
      throw new Error(
        `"${name}" is ${describeKind(declaration)}, not a type alias. Only \`type X = …\` has a ` +
          'right-hand side to substitute; an interface, class or enum is referred to, extended ' +
          'and merged by name, so removing the name is a different operation.',
      );
    }

    const declarationFile = declaration.getSourceFile();
    const ambient = ambientContext(declaration);
    if (ambient) {
      throw new Error(
        `"${name}" is declared in ${ambient}. An ambient declaration is a contract other code ` +
          'compiles against rather than a definition this project owns, and a declaration file ' +
          'is usually generated output that would come back on the next build.',
      );
    }
    if (declaration.typeParameters && declaration.typeParameters.length > 0) {
      const parameters = declaration.typeParameters
        .map((parameter) => parameter.name.getText(declarationFile))
        .join(', ');
      throw new Error(
        `"${name}" is generic (<${parameters}>). Inlining it means substituting type arguments ` +
          'positionally at every use, including defaults, constraints and partial inference — a ' +
          'different and much harder refactoring than this one, and not one this tool attempts.',
      );
    }

    const rhs = declaration.type;
    const definition = rhs.getText(declarationFile);
    const rhsKey = tokenKey(rhs, declarationFile);
    const roots = dependencyRoots(rhs);
    const checker = session.checker();

    const references = classifyReferences(session, target.file, target.offset);
    const uses = references.filter((reference) => reference.kind === 'type-position');
    const bindings = references.filter(
      (reference) => reference.kind === 'import-binding' || reference.kind === 'export-specifier',
    );
    const unexpected = references.filter(
      (reference) =>
        reference.kind !== 'type-position' &&
        reference.kind !== 'import-binding' &&
        reference.kind !== 'export-specifier' &&
        reference.kind !== 'declaration',
    );
    if (unexpected.length > 0) {
      const first = unexpected[0]!;
      throw new Error(
        `"${name}" is referenced as a ${first.kind} at ${path.relative(session.rootPath, first.file)}:` +
          `${String(first.line + 1)}, which is not a type position this tool knows how to rewrite`,
      );
    }

    const aliasSpan = {
      start: declaration.getStart(declarationFile),
      end: declaration.getEnd(),
    };
    for (const use of uses) {
      if (
        use.file === path.resolve(declarationFile.fileName) &&
        use.offset >= aliasSpan.start &&
        use.offset < aliasSpan.end
      ) {
        throw new Error(
          `"${name}" refers to itself, so substituting its right-hand side never terminates`,
        );
      }
    }
    if (uses.length === 0) {
      throw new Error(
        `Nothing refers to "${name}", so there is nothing to inline into. ` +
          'Use ts/refactors/safe-delete to remove an alias that is no longer used.',
      );
    }

    const changes: Record<string, TextEdit[]> = {};
    const warnings: string[] = [];
    const useSites: TypeUseSite[] = [];
    const add = (file: string, edit: TextEdit): void => {
      changes[file] = [...(changes[file] ?? []), edit];
    };

    for (const use of uses) {
      const sourceFile = use.node.getSourceFile();
      const where = `${path.relative(session.rootPath, use.file)}:${String(use.line + 1)}`;
      const inAmbient = ambientContext(use.node);
      if (inAmbient) {
        throw new Error(
          `"${name}" is used inside ${inAmbient} at ${where}. Substituting there rewrites a ` +
            'declaration other code compiles against, and an ambient block cannot gain the ' +
            'imports a right-hand side may need.',
        );
      }

      const site = replacedNode(use);
      if (!site) {
        throw new Error(
          `The reference to "${name}" at ${where} is not a plain type reference — an ` +
            '`import()` type or a qualified name this tool cannot address — so it has no span ' +
            'to replace',
        );
      }

      const conflicts = scopeConflicts(checker, roots, use.node);
      if (conflicts.length > 0) {
        const missing = conflicts.filter((conflict) => conflict.reason === 'missing');
        const different = conflicts.filter((conflict) => conflict.reason === 'different');
        const quoted = (list: ScopeConflict[]) =>
          list.map((conflict) => `"${conflict.name}"`).join(', ');
        throw new Error(
          `The right-hand side of "${name}" cannot be written at ${where}: ` +
            [
              missing.length > 0
                ? `${quoted(missing)} ${missing.length === 1 ? 'is' : 'are'} not in scope there`
                : '',
              different.length > 0
                ? `${quoted(different)} ${different.length === 1 ? 'means' : 'mean'} something different there`
                : '',
            ]
              .filter(Boolean)
              .join('; '),
        );
      }

      if (site.kind === 'heritage') {
        if (!ts.isTypeReferenceNode(rhs)) {
          throw new Error(
            `"${name}" is used in an extends/implements clause at ${where}, which holds a name ` +
              `rather than a type — and its right-hand side (${definition}) is not one. ` +
              'Extract the right-hand side to an interface first, or leave this alias alone.',
          );
        }
        add(path.resolve(use.file), {
          range: {
            start: sourceFile.getLineAndCharacterOfPosition(site.node.getStart(sourceFile)),
            end: sourceFile.getLineAndCharacterOfPosition(site.node.getEnd()),
          },
          newText: definition,
        });
        useSites.push({ file: path.resolve(use.file), line: use.line, character: use.character });
        continue;
      }

      const replacement = parenthesizedByFactory(rhs, site.node)
        ? `(${definition})`
        : definition;
      if (!survivesReparse(site.node, replacement, sourceFile, rhsKey)) {
        throw new Error(
          `Substituting "${name}" at ${where} does not re-parse as ${definition}. ` +
            'The position needs parentheses the compiler\'s parenthesizer does not add, so the ' +
            'result would compile and mean something else.',
        );
      }
      add(path.resolve(use.file), {
        range: {
          start: sourceFile.getLineAndCharacterOfPosition(site.node.getStart(sourceFile)),
          end: sourceFile.getLineAndCharacterOfPosition(site.node.getEnd()),
        },
        newText: replacement,
      });
      useSites.push({ file: path.resolve(use.file), line: use.line, character: use.character });
    }

    for (const binding of bindings) {
      const sourceFile = binding.node.getSourceFile();
      const span = bindingSpan(binding.node, sourceFile);
      if (!span) continue;
      add(path.resolve(binding.file), toEdit(span, sourceFile, ''));
      if (binding.kind === 'export-specifier') {
        warnings.push(
          `${path.relative(session.rootPath, binding.file)} re-exported "${name}"; inlining it ` +
            "removes the name from that module's public surface, which consumers outside this " +
            'project would notice.',
        );
      }
    }

    if (ts.getJSDocCommentsAndTags(declaration).length > 0) {
      warnings.push(
        `The documentation on "${name}" is deleted with it, and does not travel to the ` +
          `${String(useSites.length)} place${useSites.length === 1 ? '' : 's'} the right-hand side now appears.`,
      );
    }

    add(
      path.resolve(declarationFile.fileName),
      toEdit(lineSpan(declaration, declarationFile), declarationFile, ''),
    );

    const edit: WorkspaceEdit = { changes };
    const filesChanged = filesTouched(edit);
    const newDiagnostics = (await diagnosticsIntroducedBy(session, edit)).map((d) => d.text);
    const output = { edit, filesChanged, newDiagnostics, warnings, useSites, definition };

    if (input.apply !== true || newDiagnostics.length > 0) {
      return { applied: false, ...output };
    }
    const written = await applyWorkspaceEdit(edit);
    session.invalidate(written);
    return { applied: true, ...output };
  },
};

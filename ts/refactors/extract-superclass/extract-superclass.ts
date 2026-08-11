import path from 'node:path';
import ts from 'typescript';
import { applyWorkspaceEdit } from '../../../core/edits/index.js';
import type { TextEdit, Tool, WorkspaceEdit } from '../../../core/tool/index.js';
import { memberHierarchy } from '../../ast/hierarchy.js';
import { declarationAt, resolveTarget, SYMBOL_TARGET_PROPERTIES } from '../../ast/targets.js';
import type { TsProjectSession } from '../../project/index.js';
import { diagnosticsIntroducedBy } from '../guard.js';
import {
  relativeSpecifier,
  resolvedModuleOf,
  scopeAt,
  wholeLineSpanOf,
  type Span,
} from '../imports.js';
import { reindent, removalSpans } from '../layout.js';
import { filesTouched, refactorOutputSchema, type RefactorOutput } from '../output.js';
import { classifyReferences, isReference, isWrite, referencesIn } from '../references.js';
import { formatSettings, userPreferences } from '../refactor-action.js';
import { sameBinding, unalias } from '../substitution.js';

/**
 * Pulls chosen members out of a class into a newly created base class
 * and makes the original extend it — ReSharper's Extract Superclass.
 *
 * **This is the one member move with no reference rewrite at all.**
 * Inheritance preserves every call site by construction: `a.m()` still
 * resolves after `m` moves up, because `a` is still an `A` and an `A`
 * still has an `m`. Nothing outside the class's own file is touched
 * unless the base lands in another module — and then only to write the
 * one import the `extends` clause needs. Contrast `extract-class`, which
 * relocates members behind a private field and therefore has to rewrite
 * `this.m()` into `this.helper.m()` and every external `a.m()` with it.
 * That is why this is the cheapest of the five member moves, and why its
 * whole difficulty is elsewhere: in deciding which members may go.
 *
 * What decides it is visibility across the new boundary, in both
 * directions:
 *
 * - **Downward.** A member that moves up may only read what the base can
 *   see. Anything it reaches through `this` that stays behind is
 *   invisible from the base whatever its modifier says, because the base
 *   does not declare it — so the tool names the members that would have
 *   to travel with it rather than letting the compiler report a bare
 *   `TS2339` on generated code.
 * - **Upward.** A member that stays may only read what the base exposes.
 *   `private` on a moved member means private *to the base*, so the
 *   subclass loses access to it; `protected` does not. Moved `private`
 *   members that anything left behind still reads are promoted to
 *   `protected`, and the promotion is reported.
 *
 * The refusals are the product. First among them: a class that already
 * extends something has nowhere to put a second base, because TypeScript
 * is single-inheritance. There is no edit to offer there, only a
 * different refactoring.
 */

export interface ExtractSuperclassInput {
  /** Class to extract from, by name. */
  symbol?: string;
  file?: string;
  line?: number;
  character?: number;
  /** Name of the base class to generate. */
  name: string;
  /** Members to pull up, by name. */
  members: string[];
  /** Module for the base class, existing or created. Default: the class's own file. */
  targetFile?: string;
  apply?: boolean;
}

export interface ExtractSuperclassOutput extends RefactorOutput {
  /** Member names the base class carries, in declaration order. */
  members: string[];
}

/** A class member a base class can hold. */
type PullableMember =
  | ts.MethodDeclaration
  | ts.PropertyDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration;

/** One member of the class, with every declaration under its name. */
interface Selected {
  name: string;
  /** A `get`/`set` pair or an overload set is one member, several nodes. */
  declarations: PullableMember[];
}

/** Where an import has to come from, as the importing file must write it. */
type ImportOrigin = { kind: 'file'; file: string } | { kind: 'package'; text: string };

interface ImportRequest {
  name: string;
  origin: ImportOrigin;
  propertyName?: string;
  form: 'named' | 'default' | 'namespace';
  typeOnly: boolean;
}

function isPullableKind(member: ts.ClassElement): member is PullableMember {
  return (
    ts.isMethodDeclaration(member) ||
    ts.isPropertyDeclaration(member) ||
    ts.isGetAccessorDeclaration(member) ||
    ts.isSetAccessorDeclaration(member)
  );
}

function locationOf(node: ts.Node): string {
  const sourceFile = node.getSourceFile();
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return `${path.resolve(sourceFile.fileName)}:${line + 1}:${character + 1}`;
}




/** Column a node starts at, which is the indent its text assumes. */
function columnOf(node: ts.Node, sourceFile: ts.SourceFile): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile, true)).character;
}

/** Whether a node contains a template literal spanning several lines. */
function hasMultilineTemplate(node: ts.Node, sourceFile: ts.SourceFile): boolean {
  let found = false;
  const visit = (child: ts.Node): void => {
    if (found) return;
    if (
      (ts.isTemplateExpression(child) || ts.isNoSubstitutionTemplateLiteral(child)) &&
      child.getText(sourceFile).includes('\n')
    ) {
      found = true;
      return;
    }
    child.forEachChild(visit);
  };
  visit(node);
  return found;
}

/** Statement text for one import request, as the project writes imports. */
function importStatement(
  session: TsProjectSession,
  fromFile: string,
  request: ImportRequest,
): string {
  const preferences = userPreferences(session);
  const quote = preferences.quotePreference === 'double' ? '"' : "'";
  const specifier =
    request.origin.kind === 'package'
      ? request.origin.text
      : relativeSpecifier(
          fromFile,
          request.origin.file,
          preferences.importModuleSpecifierEnding === 'js',
        );
  const alias =
    request.propertyName && request.propertyName !== request.name
      ? `${request.propertyName} as ${request.name}`
      : request.name;
  const clause =
    request.form === 'namespace'
      ? `* as ${request.name}`
      : request.form === 'default'
        ? request.name
        : `{ ${alias} }`;
  return `import ${request.typeOnly ? 'type ' : ''}${clause} from ${quote}${specifier}${quote};`;
}

/**
 * What the pruning pass took out of a file, so the pass that adds
 * imports can avoid anchoring to it. An insertion anchored to the end of
 * a statement another edit deletes sits inside that deletion, and
 * `applyTextEdits` rejects the pair as overlapping.
 */
interface Pruned {
  edits: TextEdit[];
  statements: Set<ts.ImportDeclaration>;
  specifiers: Set<ts.ImportSpecifier>;
}

const NOTHING_PRUNED: Pruned = {
  edits: [],
  statements: new Set<ts.ImportDeclaration>(),
  specifiers: new Set<ts.ImportSpecifier>(),
};

/**
 * Import specifiers in `sourceFile` that nothing refers to once the
 * nodes in `dead` have left.
 *
 * Not tidiness: under `noUnusedLocals` an orphaned import is TS6133,
 * which the guard reports as a diagnostic the edit introduced and
 * refuses the whole refactoring over.
 */
function unusedImportEdits(
  session: TsProjectSession,
  sourceFile: ts.SourceFile,
  dead: ReadonlySet<ts.Node>,
): Pruned {
  const checker = session.checker();
  const live = new Set<ts.Symbol>();
  // `export { A }` with no module specifier refers to the local binding
  // through a symbol of its own, so it is matched by name instead.
  const reExported = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isExportDeclaration(node) && node.moduleSpecifier === undefined) {
      const clause = node.exportClause;
      if (clause && ts.isNamedExports(clause)) {
        for (const element of clause.elements) {
          reExported.add((element.propertyName ?? element.name).text);
        }
      }
      return;
    }
    if (ts.isIdentifier(node) && isReference(node) && !dead.has(node)) {
      const symbol = checker.getSymbolAtLocation(node);
      if (symbol) live.add(symbol);
    }
    node.forEachChild(visit);
  };
  visit(sourceFile);

  const at = (offset: number) => sourceFile.getLineAndCharacterOfPosition(offset);
  const edits: TextEdit[] = [];
  const statements = new Set<ts.ImportDeclaration>();
  const specifiers = new Set<ts.ImportSpecifier>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    const orphans = bindings.elements.filter((element) => {
      const symbol = checker.getSymbolAtLocation(element.name);
      return symbol !== undefined && !live.has(symbol) && !reExported.has(element.name.text);
    });
    if (orphans.length === 0) continue;
    for (const orphan of orphans) specifiers.add(orphan);

    const survivors = bindings.elements.filter((element) => !orphans.includes(element));
    if (survivors.length > 0) {
      // One replacement of the whole clause rather than one deletion per
      // name: two deletions in the same list overlap at the comma
      // between them.
      edits.push({
        range: { start: at(bindings.getStart(sourceFile)), end: at(bindings.getEnd()) },
        newText: `{ ${survivors.map((element) => element.getText(sourceFile)).join(', ')} }`,
      });
      continue;
    }
    const defaultName = statement.importClause?.name;
    if (defaultName) {
      edits.push({
        range: { start: at(defaultName.getEnd()), end: at(bindings.getEnd()) },
        newText: '',
      });
      continue;
    }
    const span = wholeLineSpanOf(statement, sourceFile);
    edits.push({ range: { start: at(span.start), end: at(span.end) }, newText: '' });
    statements.add(statement);
  }
  return { edits, statements, specifiers };
}

/**
 * Edits that bind `requests` in `file`. A name is folded into an
 * existing named import from the same module where there is one, so a
 * file never grows two import statements for one module.
 */
function importEdits(
  session: TsProjectSession,
  file: string,
  requests: readonly ImportRequest[],
  pruned: Pruned,
): TextEdit[] {
  const sourceFile = session.program().getSourceFile(file);
  const edits: TextEdit[] = [];
  const fresh: ImportRequest[] = [];

  if (!sourceFile) {
    const zero = { line: 0, character: 0 };
    const text = requests.map((request) => importStatement(session, file, request)).join('\n');
    return text === '' ? [] : [{ range: { start: zero, end: zero }, newText: `${text}\n\n` }];
  }

  const at = (offset: number) => sourceFile.getLineAndCharacterOfPosition(offset);
  const imports = sourceFile.statements
    .filter(ts.isImportDeclaration)
    .filter((declaration) => !pruned.statements.has(declaration));
  for (const request of requests) {
    const target = request.origin.kind === 'file' ? request.origin.file : undefined;
    let anchor: ts.ImportSpecifier | undefined;
    if (request.form === 'named' && target !== undefined) {
      for (const declaration of imports) {
        const bindings = declaration.importClause?.namedBindings;
        if (
          bindings === undefined ||
          !ts.isNamedImports(bindings) ||
          declaration.importClause?.isTypeOnly !== request.typeOnly ||
          resolvedModuleOf(declaration, session.program().getCompilerOptions()) !== target
        ) {
          continue;
        }
        const surviving = bindings.elements.filter((element) => !pruned.specifiers.has(element));
        if (surviving.length > 0) anchor = surviving[surviving.length - 1];
        break;
      }
    }
    if (!anchor) {
      fresh.push(request);
      continue;
    }
    const alias =
      request.propertyName && request.propertyName !== request.name
        ? `${request.propertyName} as ${request.name}`
        : request.name;
    edits.push({
      range: { start: at(anchor.getEnd()), end: at(anchor.getEnd()) },
      newText: `, ${alias}`,
    });
  }

  if (fresh.length > 0) {
    const text = fresh.map((request) => importStatement(session, file, request)).join('\n');
    const lastImport = imports[imports.length - 1];
    const displaced = [...pruned.statements].sort((a, b) => a.pos - b.pos)[0];
    if (lastImport) {
      const end = lastImport.getEnd();
      edits.push({ range: { start: at(end), end: at(end) }, newText: `\n${text}` });
    } else if (displaced) {
      const start = wholeLineSpanOf(displaced, sourceFile).start;
      edits.push({ range: { start: at(start), end: at(start) }, newText: `${text}\n` });
    } else {
      const first = sourceFile.statements[0];
      const start = first ? first.getStart(sourceFile, true) : 0;
      edits.push({ range: { start: at(start), end: at(start) }, newText: `${text}\n\n` });
    }
  }
  return edits;
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export const extractSuperclass: Tool<
  ExtractSuperclassInput,
  ExtractSuperclassOutput,
  TsProjectSession
> = {
  name: 'ts/refactors/extract-superclass',
  description:
    'Pulls chosen members out of a class into a newly created base class and makes the original ' +
    "extend it — ReSharper's Extract Superclass. This is the one member move with no reference " +
    'rewrite at all: inheritance preserves every call site, so `a.m()` still resolves after `m` ' +
    'moves up and no other file changes unless the base lands in another module. Target the ' +
    'class by name (symbol) or exact position; name is the base class, members are the members ' +
    'to pull up, targetFile puts the base in another module (existing or created) with the ' +
    'imports its code needs. A moved member that reads something through `this` which stays ' +
    'behind is refused naming every member that would have to travel with it; a moved `private` ' +
    'member that anything left behind still reads is promoted to `protected` and the promotion ' +
    'is reported. Adds `super()` to the class constructor, which a derived class must call. ' +
    'Refuses: a class that already extends something (TypeScript is single-inheritance, so ' +
    'there is no room for a new base), a `#private` member (a base class cannot see it), a ' +
    'static member, the constructor, a constructor parameter property, a member another class ' +
    'in the hierarchy also declares, a member whose value comes from the constructor, and a ' +
    'moved member that reads the class it is leaving. Dry-run by default; apply: true writes to ' +
    'disk unless the typecheck reports newDiagnostics.',
  inputSchema: {
    type: 'object',
    properties: {
      ...SYMBOL_TARGET_PROPERTIES,
      symbol: { type: 'string', description: 'Class to extract the base class from' },
      name: { type: 'string', description: 'Name of the base class to generate' },
      members: {
        type: 'array',
        items: { type: 'string' },
        description: 'Members to pull up, by name',
      },
      targetFile: {
        type: 'string',
        description:
          'Module for the base class, existing or created, relative to the project root ' +
          "(default: the class's own file)",
      },
      apply: { type: 'boolean', description: 'Write the edit to disk (default false)' },
    },
    required: ['name', 'members'],
    additionalProperties: false,
  },
  outputSchema: refactorOutputSchema({ members: { type: 'array', items: { type: 'string' } } }, [
    'members',
  ]),

  async run(session, input) {
    const checker = session.checker();
    const warnings: string[] = [];

    if (!IDENTIFIER.test(input.name)) {
      throw new Error(`"${input.name}" is not a legal class name`);
    }
    if (!Array.isArray(input.members) || input.members.length === 0) {
      throw new Error('members is required: name the members to pull into the base class');
    }

    const target = resolveTarget(session, input);
    const declaration = declarationAt(target);
    if (!ts.isClassDeclaration(declaration)) {
      throw new Error(
        `Extract Superclass targets a class; the declaration here is a ` +
          `${ts.SyntaxKind[declaration.kind]}`,
      );
    }
    const classDeclaration = declaration;
    const classNameNode = classDeclaration.name;
    if (!classNameNode) throw new Error('An anonymous class has no name to extract from');
    const className = classNameNode.text;
    if (className === input.name) {
      throw new Error(`The base class cannot be called "${input.name}" too — that is the class`);
    }
    const classSource = classDeclaration.getSourceFile();
    if (classSource.isDeclarationFile) {
      throw new Error(`${className} is declared in a .d.ts file, which this tool does not rewrite`);
    }
    const classFile = path.resolve(classSource.fileName);

    // The refusal that matters most, and the one with no workaround:
    // TypeScript is single-inheritance, so a class that already extends
    // something has no second `extends` slot for a generated base.
    const extendsClause = (classDeclaration.heritageClauses ?? []).find(
      (clause) => clause.token === ts.SyntaxKind.ExtendsKeyword,
    );
    if (extendsClause) {
      const base = extendsClause.types.map((type) => type.getText(classSource)).join(', ');
      throw new Error(
        `${className} already extends ${base}, and TypeScript is single-inheritance: a class has ` +
          'exactly one base, so there is no room for a new one. Pull the members into ' +
          `${base} instead (ts/refactors/pull-members-up), or extract them into a collaborator ` +
          '(ts/refactors/extract-class).',
      );
    }
    const implementsClause = (classDeclaration.heritageClauses ?? []).find(
      (clause) => clause.token === ts.SyntaxKind.ImplementsKeyword,
    );

    // Selection. Every declaration under one name travels together: a
    // `get`/`set` pair is one member spelled twice, and an overload set
    // is one member whose type is the list.
    const byName = new Map<string, Selected>();
    const constructorDeclarations: ts.ConstructorDeclaration[] = [];
    const parameterProperties = new Map<string, ts.ParameterDeclaration>();
    const unpullable = new Map<string, string>();
    for (const member of classDeclaration.members) {
      if (ts.isConstructorDeclaration(member)) {
        constructorDeclarations.push(member);
        for (const parameter of member.parameters) {
          if (ts.isParameterPropertyDeclaration(parameter, member) && ts.isIdentifier(parameter.name)) {
            parameterProperties.set(parameter.name.text, parameter);
          }
        }
        continue;
      }
      if (!isPullableKind(member)) continue;
      if (ts.isComputedPropertyName(member.name)) {
        unpullable.set(member.name.getText(classSource), 'has a computed name');
        continue;
      }
      const name = member.name.getText(classSource);
      const existing = byName.get(name);
      if (existing) existing.declarations.push(member);
      else byName.set(name, { name, declarations: [member] });
    }

    const selected: Selected[] = [];
    const seen = new Set<string>();
    for (const wanted of input.members) {
      if (seen.has(wanted)) continue;
      seen.add(wanted);
      // `#tag` is matched with or without its hash, so the refusal
      // below is about privacy rather than about spelling.
      const found =
        byName.get(wanted) ??
        byName.get(`#${wanted}`) ??
        (wanted.startsWith('#') ? byName.get(wanted.slice(1)) : undefined);
      if (found) {
        selected.push(found);
        continue;
      }
      if (wanted === 'constructor' && constructorDeclarations.length > 0) {
        throw new Error(
          `${className}'s constructor cannot be pulled up. A derived class's constructor must ` +
            'call the base constructor before it touches `this`, so moving one changes the ' +
            'initialization order of every field the class keeps — and the base would then need ' +
            "the subclass's constructor parameters. Pull the fields up instead.",
        );
      }
      const parameterProperty = parameterProperties.get(wanted);
      if (parameterProperty) {
        throw new Error(
          `"${wanted}" is a constructor parameter property on ${className}, so its declaration ` +
            "lives in the constructor's parameter list rather than in the class body. Moving it " +
            'would mean moving the constructor. Convert it to a plain field first ' +
            '(ts/refactors/change-signature), then pull the field up.',
        );
      }
      const reason = unpullable.get(wanted);
      throw new Error(
        reason
          ? `${className}.${wanted} ${reason}, so a base class cannot re-declare it`
          : `${className} declares no member named "${wanted}". Available: ` +
            `${[...byName.keys()].join(', ')}. An inherited member is not offered: its ` +
            'declaration lives elsewhere.',
      );
    }
    // Declaration order, not the order they were named: the base should
    // read like the code it came out of.
    selected.sort((a, b) => a.declarations[0]!.pos - b.declarations[0]!.pos);

    // Per-member refusals, decided before any edit exists.
    for (const member of selected) {
      for (const node of member.declarations) {
        const where = `${className}.${member.name}`;
        const flags = ts.getCombinedModifierFlags(node);
        if (ts.isPrivateIdentifier(node.name)) {
          throw new Error(
            `${where} is a #private member. A #name is scoped to the class body that declares it ` +
              'and is invisible everywhere else, including in a subclass — so a base class could ' +
              'not hold it and the subclass could not read it. Rename it to a `private` member ' +
              'first (ts/refactors/rename), which is compile-time privacy and does inherit.',
          );
        }
        if (flags & ts.ModifierFlags.Static) {
          throw new Error(
            `${where} is static. A static is reached through the class name, so pulling it up ` +
              `means rewriting every \`${className}.${member.name}\` — the reference rewrite this ` +
              'refactoring exists to avoid. Move it with ts/refactors/move-member instead.',
          );
        }
        if (flags & ts.ModifierFlags.Abstract) {
          throw new Error(
            `${where} is abstract, so it has no implementation to pull up and the generated base ` +
              'would itself have to be abstract. Declare the base by hand for that shape.',
          );
        }
        if ((ts.getDecorators(node) ?? []).length > 0) {
          throw new Error(
            `${where} is decorated. A decorator is applied to the prototype of the class that ` +
              'declares the member, so moving the member moves where the decorator runs — a ' +
              'behaviour change nothing in the type system records.',
          );
        }
        if (ts.isMethodDeclaration(node) && !node.body && member.declarations.length === 1) {
          throw new Error(`${where} has no body, so there is nothing to pull up`);
        }

        // Another class in the hierarchy declaring the same member means
        // this class does not solely own it, and pulling one declaration
        // up while the other stays re-parents an override onto a
        // declaration this tool has not checked it against.
        const hierarchy = memberHierarchy(session, node);
        if (hierarchy.unresolved.length > 0) {
          throw new Error(
            `${className}'s hierarchy cannot be resolved (${hierarchy.unresolved.join(', ')}), so ` +
              `another declaration of ${member.name} in it could be invisible here`,
          );
        }
        const sharing = [...hierarchy.supertypes, ...hierarchy.subtypes];
        const classSharing = sharing.filter((other) => ts.isClassLike(other.node.parent));
        if (classSharing.length > 0) {
          throw new Error(
            `${where} is also declared by ${classSharing
              .map((other) => `${other.container} (${other.file}:${other.line + 1})`)
              .join(', ')}. The hierarchy already shares this member, so pulling one declaration ` +
              'of it up re-parents the others onto a base this tool has not checked them ' +
              'against.',
          );
        }
        const interfaceSharing = sharing.filter((other) => !ts.isClassLike(other.node.parent));
        if (interfaceSharing.length > 0) {
          warnings.push(
            `${where} also satisfies ${interfaceSharing
              .map((other) => other.container)
              .join(', ')}, which ${className} implements. The obligation is met through ` +
              'inheritance after the move, and the typecheck confirms it.',
          );
        }
      }
    }

    const movedNodes = selected.flatMap((member) => member.declarations);
    const movedSet = new Set<ts.ClassElement>(movedNodes);
    const movedNames = new Set(selected.map((member) => member.name));
    const spanOf = (node: ts.Node): Span => ({
      start: node.getStart(classSource, true),
      end: node.getEnd(),
    });
    const movedSpans = movedNodes.map(spanOf);
    const inMoved = (node: ts.Node): boolean =>
      node.getSourceFile() === classSource &&
      movedSpans.some((span) => node.getStart() >= span.start && node.getEnd() <= span.end);

    // Downward visibility: what a moved member reaches through `this`
    // that the base will not declare. Resolved through the checker so a
    // parameter property and a `get`/`set` pair are seen as the members
    // they are.
    const stranded = new Map<string, ts.Node>();
    const dynamicThis: string[] = [];
    const findStranded = (node: ts.Node): void => {
      const name =
        ts.isPropertyAccessExpression(node) && node.expression.kind === ts.SyntaxKind.ThisKeyword
          ? node.name
          : ts.isElementAccessExpression(node) &&
              node.expression.kind === ts.SyntaxKind.ThisKeyword &&
              ts.isStringLiteralLike(node.argumentExpression)
            ? node.argumentExpression
            : undefined;
      if (
        ts.isElementAccessExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ThisKeyword &&
        !ts.isStringLiteralLike(node.argumentExpression)
      ) {
        dynamicThis.push(locationOf(node));
      }
      if (name) {
        const symbol = checker.getSymbolAtLocation(name);
        const owned = (symbol?.declarations ?? []).filter(
          (home) => home.parent === classDeclaration || (ts.isParameter(home) && home.parent.parent === classDeclaration),
        );
        if (
          owned.length > 0 &&
          !owned.some((home) => ts.isClassElement(home) && movedSet.has(home))
        ) {
          stranded.set(symbol!.name, node);
        }
      }
      node.forEachChild(findStranded);
    };
    for (const node of movedNodes) findStranded(node);
    if (stranded.size > 0) {
      const names = [...stranded.keys()];
      throw new Error(
        `${[...movedNames].join(', ')} read${movedNames.size === 1 ? 's' : ''} ` +
          `${names.map((name) => `this.${name}`).join(', ')}, which would stay on ${className}. ` +
          'A base class does not declare its subclass\'s members, so it cannot see them whatever ' +
          `their modifier says. Add ${names.map((name) => `"${name}"`).join(', ')} to members so ` +
          'they travel too, or leave the member where it is.',
      );
    }

    // A moved member that names the class it is leaving would make the
    // base depend on its own subclass.
    const classSymbol = checker.getSymbolAtLocation(classNameNode);
    for (const node of movedNodes) {
      for (const reference of referencesIn(node)) {
        const symbol = checker.getSymbolAtLocation(reference);
        if (!symbol || classSymbol === undefined || !sameBinding(checker, symbol, classSymbol)) {
          continue;
        }
        const parent = reference.parent as ts.Node | undefined;
        const statically =
          parent && ts.isPropertyAccessExpression(parent) && parent.expression === reference
            ? parent.name.text
            : undefined;
        throw new Error(
          statically
            ? `${className}.${statically} is read at ${locationOf(reference)}, inside a member ` +
              `being pulled up. Statics stay on ${className}, and a base class reaching one would ` +
              'depend on its own subclass. Move the static first (ts/refactors/move-member).'
            : `${locationOf(reference)} names ${className} inside a member being pulled up, which ` +
              'would make the base class depend on its own subclass.',
        );
      }
    }

    // Upward visibility, plus the two writes a move breaks.
    const promoted: string[] = [];
    for (const member of selected) {
      const primary = member.declarations[0]!;
      const references = classifyReferences(
        session,
        classFile,
        primary.name.getStart(classSource),
      ).filter((reference) => reference.kind !== 'declaration' && !inMoved(reference.node));

      const isPrivate = member.declarations.some(
        (node) => ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Private,
      );
      if (isPrivate && references.length > 0) promoted.push(member.name);

      // A property whose value arrives from the constructor cannot move:
      // the constructor stays on the subclass, and a base `readonly`
      // field is not assignable from there at all (TS2540), while a base
      // field with no initializer is left uninitialized (TS2564).
      for (const node of member.declarations) {
        if (!ts.isPropertyDeclaration(node) || node.initializer) continue;
        const flags = ts.getCombinedModifierFlags(node);
        const settled =
          node.questionToken !== undefined || node.exclamationToken !== undefined;
        const writes = references.filter(isWrite);
        if (writes.length === 0) continue;
        if (flags & ts.ModifierFlags.Readonly) {
          throw new Error(
            `${className}.${member.name} is readonly and assigned at ` +
              `${writes[0]!.file}:${writes[0]!.line + 1}. A readonly property may only be ` +
              'assigned inside the class that declares it, so once it moves to ' +
              `${input.name} the assignment in ${className} is illegal. Give it an initializer, ` +
              'or leave it behind.',
          );
        }
        if (!settled) {
          throw new Error(
            `${className}.${member.name} has no initializer and is assigned at ` +
              `${writes[0]!.file}:${writes[0]!.line + 1}, which stays behind. ${input.name} would ` +
              'declare a property nothing in it ever sets. Give it an initializer, mark it ' +
              'optional, or leave it behind.',
          );
        }
      }
    }
    if (promoted.length > 0) {
      warnings.push(
        `${promoted.map((name) => `${input.name}.${name}`).join(', ')} ` +
          `${promoted.length === 1 ? 'was' : 'were'} promoted from private to protected: ` +
          `\`private\` on a base member means private to ${input.name}, so ${className} would ` +
          'lose the access it has today.',
      );
    }
    const promotedSet = new Set(promoted);

    if (dynamicThis.length > 0) {
      warnings.push(
        `A member being pulled up reads \`this[…]\` with a computed key at ` +
          `${dynamicThis.join(', ')}; which member that names is invisible to both this tool and ` +
          'the typecheck.',
      );
    }

    // Destination.
    const destinationFile =
      input.targetFile === undefined ? classFile : path.resolve(session.rootPath, input.targetFile);
    if (ts.sys.directoryExists(destinationFile)) {
      throw new Error(`Destination ${destinationFile} is a directory, not a file`);
    }
    const destinationSource = session.program().getSourceFile(destinationFile);
    const createsDestination = destinationSource === undefined;
    const scopeAnchor =
      destinationFile === classFile
        ? classDeclaration
        : destinationSource
          ? (destinationSource.statements[destinationSource.statements.length - 1] ??
            destinationSource)
          : undefined;
    if (scopeAnchor && scopeAt(checker, scopeAnchor).has(input.name)) {
      throw new Error(
        `"${input.name}" already means something else in ${destinationFile}, so the base class ` +
          'cannot take that name there',
      );
    }
    if (destinationFile !== classFile && scopeAt(checker, classDeclaration).has(input.name)) {
      throw new Error(
        `"${input.name}" already means something else in ${classFile}, so the extends clause ` +
          'could not name the base class',
      );
    }

    // Type parameters travel only when the moved code uses them, so a
    // class that is generic for reasons unrelated to these members does
    // not get a pointlessly generic base.
    const ownTypeParameters = new Map<ts.Declaration, ts.TypeParameterDeclaration>(
      (classDeclaration.typeParameters ?? []).map((parameter) => [parameter, parameter]),
    );
    let usesTypeParameters = false;
    for (const node of movedNodes) {
      for (const reference of referencesIn(node)) {
        const symbol = checker.getSymbolAtLocation(reference);
        if ((symbol?.declarations ?? []).some((home) => ownTypeParameters.has(home))) {
          usesTypeParameters = true;
        }
      }
    }
    const carriedTypeParameters = usesTypeParameters ? (classDeclaration.typeParameters ?? []) : [];
    const typeParameterText =
      carriedTypeParameters.length > 0
        ? `<${carriedTypeParameters.map((parameter) => parameter.getText(classSource)).join(', ')}>`
        : '';
    const typeArgumentText =
      carriedTypeParameters.length > 0
        ? `<${carriedTypeParameters.map((parameter) => parameter.name.text).join(', ')}>`
        : '';

    // Imports the base class needs so its code still means what it
    // meant. Every free name is re-resolved against the destination's
    // scope: one already bound there to the same symbol needs nothing,
    // one bound to a different symbol is a refusal — the failure a
    // typecheck cannot see, because the code compiles and computes
    // something else.
    const requests: ImportRequest[] = [];
    const request = (entry: ImportRequest): void => {
      if (!requests.some((other) => other.name === entry.name)) requests.push(entry);
    };
    const destinationScope = scopeAnchor
      ? scopeAt(checker, scopeAnchor)
      : new Map<string, ts.Symbol>();
    const scanned = [...movedNodes, ...carriedTypeParameters];
    for (const root of scanned) {
      for (const node of referencesIn(root)) {
        const symbol = checker.getSymbolAtLocation(node);
        if (!symbol) continue;
        const declarations = symbol.declarations ?? [];
        if (declarations.length > 0 && declarations.every((home) => inMoved(home))) continue;
        if (declarations.some((home) => ownTypeParameters.has(home))) continue;
        const resolved = unalias(checker, symbol);
        if (
          !(resolved.declarations ?? []).some((home) => ts.isExternalModule(home.getSourceFile()))
        ) {
          continue;
        }
        if (destinationFile === classFile) continue;

        const there = destinationScope.get(node.text);
        if (there !== undefined) {
          // Never `!==`. The name the moved code imports and the name
          // the destination declares are two symbols over one
          // declaration whenever the destination is that declaration's
          // own file — measured on this fixture, where moving into the
          // module that exports CRATE_LIMIT refused itself.
          if (!sameBinding(checker, there, resolved)) {
            throw new Error(
              `"${node.text}" means something different in ${destinationFile}, so ${className}'s ` +
                'members would silently change meaning if they moved there',
            );
          }
          continue;
        }
        if (
          declarations.some(
            (home) => path.resolve(home.getSourceFile().fileName) === destinationFile,
          )
        ) {
          continue;
        }

        const typeOnly = (resolved.flags & ts.SymbolFlags.Value) === 0;
        const binding = declarations[0];
        const originOf = (statement: ts.ImportDeclaration): ImportOrigin => {
          const origin = resolvedModuleOf(statement, session.program().getCompilerOptions());
          return origin === undefined
            ? { kind: 'package', text: (statement.moduleSpecifier as ts.StringLiteral).text }
            : { kind: 'file', file: origin };
        };
        if (
          binding &&
          ts.isImportSpecifier(binding) &&
          ts.isImportDeclaration(binding.parent.parent.parent)
        ) {
          const statement = binding.parent.parent.parent;
          request({
            name: node.text,
            origin: originOf(statement),
            ...(binding.propertyName ? { propertyName: binding.propertyName.text } : {}),
            form: 'named',
            typeOnly: typeOnly || binding.isTypeOnly || statement.importClause!.isTypeOnly,
          });
          continue;
        }
        if (binding && (ts.isNamespaceImport(binding) || ts.isImportClause(binding))) {
          const statement = ts.isNamespaceImport(binding) ? binding.parent.parent : binding.parent;
          if (ts.isImportDeclaration(statement)) {
            request({
              name: node.text,
              origin: originOf(statement),
              form: ts.isNamespaceImport(binding) ? 'namespace' : 'default',
              typeOnly,
            });
            continue;
          }
        }

        const home = binding?.getSourceFile();
        if (!home) continue;
        const moduleSymbol = checker.getSymbolAtLocation(home);
        const exported =
          moduleSymbol !== undefined &&
          checker.getExportsOfModule(moduleSymbol).some((candidate) => candidate.name === node.text);
        if (!exported) {
          throw new Error(
            `${input.name} would read "${node.text}", which ` +
              `${path.resolve(home.fileName)} does not export, so ${destinationFile} cannot name ` +
              `it. Extract into ${className}'s own file, or export "${node.text}".`,
          );
        }
        request({
          name: node.text,
          origin: { kind: 'file', file: path.resolve(home.fileName) },
          form: 'named',
          typeOnly,
        });
      }
    }

    // The base class text. `private` is rewritten to `protected` where
    // the subclass still reads the member — the one modifier edit this
    // refactoring makes, and the reason it is not a pure relocation.
    const bodyParts: string[] = [];
    for (const member of selected) {
      for (const node of member.declarations) {
        const span = spanOf(node);
        let text = classSource.text.slice(span.start, span.end);
        if (promotedSet.has(member.name)) {
          const modifier = (ts.getModifiers(node) ?? []).find(
            (candidate) => candidate.kind === ts.SyntaxKind.PrivateKeyword,
          );
          if (modifier) {
            const at = modifier.getStart(classSource) - span.start;
            text = `${text.slice(0, at)}protected${text.slice(at + 'private'.length)}`;
          }
        }
        if (hasMultilineTemplate(node, classSource)) {
          warnings.push(
            `${className}.${member.name} contains a multi-line template literal, whose ` +
              'indentation is string content rather than layout, so the moved code keeps its ' +
              'original indentation.',
          );
          bodyParts.push(text);
          continue;
        }
        bodyParts.push(reindent(text, columnOf(node, classSource), '  '));
      }
    }
    const exported =
      destinationFile !== classFile ||
      (ts.getCombinedModifierFlags(classDeclaration) & ts.ModifierFlags.Export) !== 0;
    const baseText =
      `${exported ? 'export ' : ''}class ${input.name}${typeParameterText} {\n` +
      `${bodyParts.join('\n\n')}\n}`;

    // Edits.
    const changes: Record<string, TextEdit[]> = {};
    const add = (file: string, edit: TextEdit): void => {
      changes[file] = [...(changes[file] ?? []), edit];
    };
    const rangeIn = (source: ts.SourceFile, start: number, end: number) => ({
      start: source.getLineAndCharacterOfPosition(start),
      end: source.getLineAndCharacterOfPosition(end),
    });

    for (const span of removalSpans(classSource, movedNodes)) {
      add(classFile, { range: rangeIn(classSource, span.start, span.end), newText: '' });
    }

    const baseReference = `${input.name}${typeArgumentText}`;
    if (implementsClause) {
      const at = implementsClause.getStart(classSource);
      add(classFile, {
        range: rangeIn(classSource, at, at),
        newText: `extends ${baseReference} `,
      });
    } else {
      // Anchor on the body's `{`, not on the type parameter list:
      // `typeParameters.end` is the end of the last parameter, so on
      // `class Crate<T>` it addresses the gap before `>`.
      const brace = classDeclaration
        .getChildren(classSource)
        .find((child) => child.kind === ts.SyntaxKind.OpenBraceToken);
      const at = brace?.getStart(classSource) ?? classDeclaration.getEnd();
      const spaced = /\s/.test(classSource.text[at - 1] ?? '');
      add(classFile, {
        range: rangeIn(classSource, at, at),
        newText: `${spaced ? '' : ' '}extends ${baseReference} `,
      });
    }

    // A derived class's constructor must call the base constructor
    // before it touches `this`, so a class that declares one needs
    // `super()` inserted — TS2377 otherwise, and no edit at all if the
    // class relies on the implicit constructor.
    const constructorBody = constructorDeclarations.find((node) => node.body)?.body;
    if (constructorBody) {
      const indentSize = formatSettings(session).indentSize ?? 2;
      const indent = ' '.repeat(
        classSource.getLineAndCharacterOfPosition(
          constructorBody.parent.getStart(classSource, false),
        ).character + indentSize,
      );
      const at = constructorBody.getStart(classSource) + 1;
      const closing = ' '.repeat(
        classSource.getLineAndCharacterOfPosition(
          constructorBody.parent.getStart(classSource, false),
        ).character,
      );
      add(classFile, {
        range: rangeIn(classSource, at, at),
        newText:
          constructorBody.statements.length === 0
            ? `\n${indent}super();\n${closing}`
            : `\n${indent}super();`,
      });
      warnings.push(
        `\`super()\` was added to ${className}'s constructor: a derived class must call its base ` +
          'constructor before it touches `this`.',
      );
    }

    const fileOps: WorkspaceEdit['fileOps'] = [];
    if (destinationFile === classFile) {
      let at = classDeclaration.getStart(classSource, true);
      while (at > 0 && classSource.text[at - 1] !== '\n') at--;
      add(classFile, { range: rangeIn(classSource, at, at), newText: `${baseText}\n\n` });
    } else if (createsDestination) {
      fileOps.push({ kind: 'create', file: destinationFile });
      const header = requests
        .map((entry) => importStatement(session, destinationFile, entry))
        .join('\n');
      const zero = { line: 0, character: 0 };
      add(destinationFile, {
        range: { start: zero, end: zero },
        newText: `${header === '' ? '' : `${header}\n\n`}${baseText}\n`,
      });
    } else {
      const end = destinationSource.getEnd();
      add(destinationFile, {
        range: rangeIn(destinationSource, end, end),
        newText: `\n${baseText}\n`,
      });
      for (const edit of importEdits(session, destinationFile, requests, NOTHING_PRUNED)) {
        add(destinationFile, edit);
      }
    }

    // Imports in the class's own file: one for the base class, minus the
    // ones only the departing members were using.
    if (destinationFile !== classFile) {
      const dead = new Set<ts.Node>();
      for (const node of movedNodes) for (const reference of referencesIn(node)) dead.add(reference);
      const pruned = unusedImportEdits(session, classSource, dead);
      for (const edit of importEdits(
        session,
        classFile,
        [
          {
            name: input.name,
            origin: { kind: 'file', file: destinationFile },
            form: 'named',
            typeOnly: false,
          },
        ],
        pruned,
      )) {
        add(classFile, edit);
      }
      for (const edit of pruned.edits) add(classFile, edit);
    }

    const edit: WorkspaceEdit = fileOps.length > 0 ? { changes, fileOps } : { changes };
    const filesChanged = filesTouched(edit);
    const newDiagnostics = (await diagnosticsIntroducedBy(session, edit)).map((d) => d.text);
    const output = {
      edit,
      filesChanged,
      newDiagnostics,
      warnings,
      members: selected.map((member) => member.name),
    };

    if (input.apply !== true || newDiagnostics.length > 0) return { applied: false, ...output };
    const written = await applyWorkspaceEdit(edit);
    session.invalidate(written);
    return { applied: true, ...output };
  },
};

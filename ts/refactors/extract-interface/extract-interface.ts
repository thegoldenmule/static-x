import path from 'node:path';
import ts from 'typescript';
import { applyWorkspaceEdit } from '../../../core/edits/index.js';
import type { TextEdit, Tool, WorkspaceEdit } from '../../../core/tool/index.js';
import { declarationAt, resolveTarget, SYMBOL_TARGET_PROPERTIES } from '../../ast/targets.js';
import type { TsProjectSession } from '../../project/index.js';
import { diagnosticsIntroducedBy } from '../guard.js';
import { filesTouched, refactorOutputSchema, type RefactorOutput } from '../output.js';
import { classifyReferences, type ClassifiedReference } from '../references.js';
import { userPreferences } from '../refactor-action.js';
import { unalias } from '../substitution.js';

/**
 * Generates an interface from a class's public instance members, adds
 * `implements` to the class, and rewrites declared types at use sites
 * from the concrete class to the new interface — ReSharper's Extract
 * Interface.
 *
 * **In a structurally typed language the first two halves change
 * nothing.** `implements` is a *documented assertion*: it makes the
 * compiler check the class against the interface, and that is all.
 * Consumers already accept anything of the right shape, so a project
 * that gains an interface and an `implements` clause compiles exactly as
 * it did, with exactly the same coupling — every signature still names
 * the class. What decouples a caller is the third half, rewriting `: C`
 * to `: I`, and that is the operation worth a tool: it is a project-wide
 * edit whose precondition ("this code only uses interface members") is
 * knowledge no single file contains.
 *
 * Signatures are copied from the member declarations rather than
 * rendered from their types. `typeToString` emits
 * `import("/abs/path").T` for any name not in scope at the node it is
 * given — a machine-specific absolute path, never something to write
 * into a source file — so it is used only where a declaration wrote no
 * annotation at all, and its output is checked for that fallback before
 * it is used.
 *
 * The guard settles what the rewrite means. A use site that reads a
 * member the interface does not carry is `TS2339` with the edit applied,
 * so it cannot ship. Two cases get a refusal of their own anyway,
 * because the compiler's message would not say what to do about it: a
 * binding annotated with the class whose code reads an excluded member,
 * and `typeof C`, which names the class object that `new` needs and for
 * which no interface can substitute.
 */

export interface ExtractInterfaceInput {
  /** Class to extract from, by name. */
  symbol?: string;
  file?: string;
  line?: number;
  character?: number;
  /** Name of the interface to generate. */
  name: string;
  /** Members to carry. Default: every public instance member. */
  members?: string[];
  /** Module for the interface, existing or created. Default: the class's own file. */
  targetFile?: string;
  /** Rewrite `: C` annotations to `: I` project-wide. Default true. */
  updateUseSites?: boolean;
  apply?: boolean;
}

export interface InterfaceUseSite {
  file: string;
  line: number;
  character: number;
}

export interface ExtractInterfaceOutput extends RefactorOutput {
  /** Member names the interface carries, in declaration order. */
  members: string[];
  /** Annotations rewritten from the class to the interface, pre-edit. */
  useSites: InterfaceUseSite[];
}

/** A class member the interface can carry, with its overload set. */
interface CarriedMember {
  name: string;
  declarations: ts.ClassElement[];
}

/** Where an import has to come from, as the importing file must write it. */
type ImportOrigin = { kind: 'file'; file: string } | { kind: 'package'; text: string };

interface ImportAddition {
  name: string;
  origin: ImportOrigin;
  propertyName?: string;
  typeOnly: boolean;
}

interface Rewrite {
  file: string;
  start: number;
  end: number;
  newText: string;
}

const SOURCE_TO_IMPORT_EXTENSION: Record<string, string> = { '.mts': '.mjs', '.cts': '.cjs' };

/** A relative module specifier for `toFile`, as written from `fromFile`. */
function relativeSpecifier(fromFile: string, toFile: string, withExtension: boolean): string {
  const relative = path.relative(path.dirname(fromFile), toFile).split(path.sep).join('/');
  const dotted = relative.startsWith('.') ? relative : `./${relative}`;
  const extension = path.extname(dotted);
  const stem = dotted.slice(0, dotted.length - extension.length);
  return withExtension ? stem + (SOURCE_TO_IMPORT_EXTENSION[extension] ?? '.js') : stem;
}

/** Statement text for one import, in the style the project writes. */
function importStatement(
  session: TsProjectSession,
  fromFile: string,
  addition: ImportAddition,
): string {
  const preferences = userPreferences(session);
  const quote = preferences.quotePreference === 'double' ? '"' : "'";
  const specifier =
    addition.origin.kind === 'package'
      ? addition.origin.text
      : relativeSpecifier(
          fromFile,
          addition.origin.file,
          preferences.importModuleSpecifierEnding === 'js',
        );
  const alias =
    addition.propertyName && addition.propertyName !== addition.name
      ? `${addition.propertyName} as ${addition.name}`
      : addition.name;
  return `import ${addition.typeOnly ? 'type ' : ''}{ ${alias} } from ${quote}${specifier}${quote};`;
}

/** Module file an import declaration resolves to, if any. */
function resolvedModuleOf(
  session: TsProjectSession,
  declaration: ts.ImportDeclaration,
): string | undefined {
  if (!ts.isStringLiteral(declaration.moduleSpecifier)) return undefined;
  const resolved = ts.resolveModuleName(
    declaration.moduleSpecifier.text,
    declaration.getSourceFile().fileName,
    session.program().getCompilerOptions(),
    ts.sys,
  ).resolvedModule;
  return resolved ? path.resolve(resolved.resolvedFileName) : undefined;
}

/** The whole lines a statement occupies, so deleting it leaves no blank. */
function lineSpanOf(node: ts.Node, sourceFile: ts.SourceFile): { start: number; end: number } {
  const text = sourceFile.getFullText();
  let start = node.getStart(sourceFile, true);
  while (start > 0 && text[start - 1] !== '\n') start--;
  let end = node.getEnd();
  while (end < text.length && text[end] !== '\n') end++;
  if (end < text.length) end++;
  return { start, end };
}

/**
 * Re-indent a block lifted from one nesting depth to another. Only
 * whitespace at the head of a line is touched, so nothing inside a
 * string can move — the caller warns when a member's signature holds a
 * multi-line template literal type, where even that is content.
 */
function reindent(text: string, from: number, to: string): string {
  return text
    .split('\n')
    .map((line, index) => {
      if (index === 0) return to + line;
      const stripped = line.slice(0, from).replace(/^[ \t]*/, '') + line.slice(from);
      return stripped.length === 0 ? '' : to + stripped;
    })
    .join('\n');
}

/** Names visible at a node, first declaration of each winning. */
function scopeAt(checker: ts.TypeChecker, site: ts.Node): Map<string, ts.Symbol> {
  const scope = new Map<string, ts.Symbol>();
  // SymbolFlags.All, not Type: an imported binding's own flags are
  // Alias whatever it aliases, so a narrower filter omits every import
  // and reports a fully-populated module scope as empty.
  for (const symbol of checker.getSymbolsInScope(site, ts.SymbolFlags.All)) {
    if (!scope.has(symbol.name)) scope.set(symbol.name, symbol);
  }
  return scope;
}

/** The JSDoc block immediately above a node, verbatim. */
function jsDocOf(node: ts.Node, sourceFile: ts.SourceFile): string | undefined {
  const ranges = ts.getLeadingCommentRanges(sourceFile.text, node.getFullStart()) ?? [];
  for (let index = ranges.length - 1; index >= 0; index--) {
    const range = ranges[index]!;
    if (sourceFile.text.slice(range.pos, range.pos + 3) === '/**') {
      return sourceFile.text.slice(range.pos, range.end);
    }
  }
  return undefined;
}

/** Modifier flags as the compiler combines them for a declaration. */
function flagsOf(node: ts.Declaration): ts.ModifierFlags {
  return ts.getCombinedModifierFlags(node);
}

type CarryableMember =
  | ts.MethodDeclaration
  | ts.PropertyDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration;

function isCarryableKind(member: ts.ClassElement): member is CarryableMember {
  return (
    ts.isMethodDeclaration(member) ||
    ts.isPropertyDeclaration(member) ||
    ts.isGetAccessorDeclaration(member) ||
    ts.isSetAccessorDeclaration(member)
  );
}

function locationOf(node: ts.Node): string {
  const sourceFile = node.getSourceFile();
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(
    node.getStart(sourceFile),
  );
  return `${path.resolve(sourceFile.fileName)}:${line + 1}:${character + 1}`;
}

/** Whether a reference sits inside an `extends`/`implements` clause. */
function inHeritageClause(node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (ts.isHeritageClause(current)) return true;
    if (ts.isSourceFile(current)) return false;
  }
  return false;
}

/** The `typeof C` query a reference sits in, if any. */
function typeQueryOf(node: ts.Node): ts.TypeQueryNode | undefined {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (ts.isTypeQueryNode(current)) return current;
    if (ts.isSourceFile(current)) return undefined;
  }
  return undefined;
}

/**
 * The declaration a class-typed annotation belongs to, when the
 * annotation *is* the class reference rather than something built out of
 * it. `pet: Dog` yields the parameter; `pets: Dog[]` yields nothing, and
 * that case is left entirely to the guard.
 */
function annotatedBinding(
  node: ts.Node,
):
  | ts.ParameterDeclaration
  | ts.VariableDeclaration
  | ts.PropertyDeclaration
  | ts.PropertySignature
  | undefined {
  const reference = node.parent as ts.Node | undefined;
  if (!reference || !ts.isTypeReferenceNode(reference)) return undefined;
  const owner = reference.parent as ts.Node | undefined;
  if (!owner) return undefined;
  if (
    (ts.isParameter(owner) ||
      ts.isVariableDeclaration(owner) ||
      ts.isPropertyDeclaration(owner) ||
      ts.isPropertySignature(owner)) &&
    owner.type === reference
  ) {
    return owner;
  }
  return undefined;
}

/** Member names the project reads off a binding, with where it reads them. */
function membersReadOff(
  session: TsProjectSession,
  binding: ts.NamedDeclaration,
): { name: string; at: ClassifiedReference }[] {
  if (!binding.name || !ts.isIdentifier(binding.name)) return [];
  const sourceFile = binding.getSourceFile();
  const found: { name: string; at: ClassifiedReference }[] = [];
  for (const reference of classifyReferences(
    session,
    path.resolve(sourceFile.fileName),
    binding.name.getStart(sourceFile),
  )) {
    if (reference.kind === 'declaration') continue;
    const parent = reference.node.parent as ts.Node | undefined;
    if (!parent) continue;
    if (ts.isPropertyAccessExpression(parent) && parent.expression === reference.node) {
      found.push({ name: parent.name.text, at: reference });
      continue;
    }
    if (
      ts.isElementAccessExpression(parent) &&
      parent.expression === reference.node &&
      ts.isStringLiteralLike(parent.argumentExpression)
    ) {
      found.push({ name: parent.argumentExpression.text, at: reference });
      continue;
    }
    // `const { name, occupancy } = kennel` reads through a pattern.
    if (ts.isVariableDeclaration(parent) && parent.initializer === reference.node) {
      const pattern = parent.name;
      if (ts.isObjectBindingPattern(pattern)) {
        for (const element of pattern.elements) {
          const key = element.propertyName ?? element.name;
          if (ts.isIdentifier(key) || ts.isStringLiteral(key)) {
            found.push({ name: key.text, at: reference });
          }
        }
      }
    }
  }
  return found;
}

export const extractInterface: Tool<
  ExtractInterfaceInput,
  ExtractInterfaceOutput,
  TsProjectSession
> = {
  name: 'ts/refactors/extract-interface',
  description:
    "Generates an interface from a class's public instance members, adds implements to the " +
    'class, and rewrites declared types at use sites from the concrete class to the new ' +
    "interface — ReSharper's Extract Interface. In a structurally typed language the first two " +
    'halves change nothing: implements is a documented assertion, not a requirement, and ' +
    'consumers already accept anything of the right shape. The use-site rewrite is what ' +
    'decouples callers from the class, and it is the reason this is a tool: its precondition ' +
    '("this code only uses interface members") is knowledge no single file holds. Default ' +
    'members are public instance members — no private/protected/#name, no static, no ' +
    'constructor — narrowed by members. Signatures are copied from the declarations, falling ' +
    'back to the checker only where none was written. targetFile puts the interface in another ' +
    'module, existing or created, adding the imports it and its consumers need and dropping the ' +
    'import of the class a file no longer names. Refuses a class with no eligible members, a ' +
    'use site that names the class itself (typeof C, which is what new needs), a ' +
    'namespace-qualified reference, and a binding whose code reads a member the interface does ' +
    'not carry. Everything else is settled by the typecheck: newDiagnostics non-empty blocks ' +
    'the apply. Dry-run by default.',
  inputSchema: {
    type: 'object',
    properties: {
      ...SYMBOL_TARGET_PROPERTIES,
      symbol: { type: 'string', description: 'Class to extract the interface from' },
      name: { type: 'string', description: 'Name of the interface to generate' },
      members: {
        type: 'array',
        items: { type: 'string' },
        description: 'Members to carry (default: every public instance member)',
      },
      targetFile: {
        type: 'string',
        description:
          'Module for the interface, existing or created, relative to the project root ' +
          "(default: the class's own file)",
      },
      updateUseSites: {
        type: 'boolean',
        description: 'Rewrite `: C` annotations to `: I` project-wide (default true)',
      },
      apply: { type: 'boolean', description: 'Write the edit to disk (default false)' },
    },
    required: ['name'],
    additionalProperties: false,
  },
  outputSchema: refactorOutputSchema(
    {
      members: { type: 'array', items: { type: 'string' } },
      useSites: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            file: { type: 'string' },
            line: { type: 'integer' },
            character: { type: 'integer' },
          },
          required: ['file', 'line', 'character'],
        },
      },
    },
    ['members', 'useSites'],
  ),

  async run(session, input) {
    const checker = session.checker();
    const warnings: string[] = [];

    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(input.name)) {
      throw new Error(`"${input.name}" is not a legal interface name`);
    }

    const target = resolveTarget(session, input);
    const declaration = declarationAt(target);
    if (!ts.isClassDeclaration(declaration)) {
      throw new Error(
        `Extract Interface targets a class; the declaration here is a ` +
          `${ts.SyntaxKind[declaration.kind]}`,
      );
    }
    const classDeclaration = declaration;
    const classNameNode = classDeclaration.name;
    if (!classNameNode) throw new Error('An anonymous class has no name to extract from');
    const className = classNameNode.text;
    if (className === input.name) {
      throw new Error(`The interface cannot be called "${input.name}" too — that is the class`);
    }
    const classSource = classDeclaration.getSourceFile();
    if (classSource.isDeclarationFile) {
      throw new Error(`${className} is declared in a .d.ts file, which this tool does not rewrite`);
    }
    const classFile = path.resolve(classSource.fileName);

    // Destination.
    const destinationFile =
      input.targetFile === undefined ? classFile : path.resolve(session.rootPath, input.targetFile);
    if (ts.sys.directoryExists(destinationFile)) {
      throw new Error(`Destination ${destinationFile} is a directory, not a file`);
    }
    const destinationSource = session.program().getSourceFile(destinationFile);
    const createsDestination = destinationSource === undefined;

    // Eligible members.
    const skipped: string[] = [];
    const eligible = new Map<string, CarriedMember>();
    for (const member of classDeclaration.members) {
      if (ts.isConstructorDeclaration(member)) continue;
      if (ts.isClassStaticBlockDeclaration(member) || ts.isSemicolonClassElement(member)) continue;
      if (ts.isIndexSignatureDeclaration(member)) {
        skipped.push('an index signature');
        continue;
      }
      if (!isCarryableKind(member)) continue;
      const flags = flagsOf(member);
      if (flags & ts.ModifierFlags.Static) continue;
      if (flags & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) continue;
      if (ts.isPrivateIdentifier(member.name)) continue;
      if (ts.isComputedPropertyName(member.name)) {
        skipped.push(`the computed member ${member.name.getText(classSource)}`);
        continue;
      }
      const name = member.name.getText(classSource);
      const existing = eligible.get(name);
      if (existing) existing.declarations.push(member);
      else eligible.set(name, { name, declarations: [member] });
    }

    if (skipped.length > 0) {
      warnings.push(
        `${className} declares ${[...new Set(skipped)].join(' and ')}, which an interface ` +
          'generated from named members cannot carry.',
      );
    }
    if (eligible.size === 0) {
      throw new Error(
        `${className} has no public instance members, so there is no interface to extract. ` +
          'Static members, the constructor, and anything private, protected, or #-named are ' +
          'excluded by construction — an interface describes instances and carries no ' +
          'implementation, and a #name is unreachable from outside the class body.',
      );
    }

    // An overload set declares its signatures without bodies and its
    // implementation with one. The implementation signature is not part
    // of the type — writing it into the interface would add a call
    // signature no caller may use.
    for (const member of eligible.values()) {
      if (member.declarations.length < 2) continue;
      const signatures = member.declarations.filter(
        (declaration) => ts.isMethodDeclaration(declaration) && declaration.body === undefined,
      );
      if (signatures.length > 0) member.declarations = signatures;
    }

    let carried: CarriedMember[] = [...eligible.values()];
    if (input.members !== undefined) {
      const missing = input.members.filter((name) => !eligible.has(name));
      if (missing.length > 0) {
        throw new Error(
          `${className} declares no public instance member named ${missing
            .map((name) => `"${name}"`)
            .join(', ')}. Available: ${[...eligible.keys()].join(', ')}. An inherited member is ` +
            'not offered: its declaration lives on the base class, so extracting it here would ' +
            'copy a signature this class does not own.',
        );
      }
      const wanted = new Set(input.members);
      carried = carried.filter((member) => wanted.has(member.name));
      if (carried.length === 0) throw new Error('members selected nothing to carry');
    }
    const carriedNames = new Set(carried.map((member) => member.name));

    if ((classDeclaration.heritageClauses ?? []).some((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)) {
      warnings.push(
        `${className} extends a base class, and the interface carries only the members ` +
          `${className} itself declares. Code that reads an inherited member off an annotation ` +
          'this rewrites is refused rather than carried along.',
      );
    }

    // References, and what the rewrite may do with each.
    const updateUseSites = input.updateUseSites !== false;
    const classNameOffset = classNameNode.getStart(classSource);
    const references = classifyReferences(session, classFile, classNameOffset);

    const rewrites: Rewrite[] = [];
    const useSites: InterfaceUseSite[] = [];
    const rewrittenNodes: ts.Node[] = [];
    const constructingFiles = new Set<string>();
    const survivingByFile = new Map<string, number>();
    const importBindings: ts.ImportSpecifier[] = [];

    const survives = (file: string): void => {
      survivingByFile.set(file, (survivingByFile.get(file) ?? 0) + 1);
    };

    for (const reference of references) {
      const node = reference.node;
      const referenceSource = node.getSourceFile();
      if (referenceSource.isDeclarationFile) continue;
      const file = path.resolve(referenceSource.fileName);

      if (reference.kind === 'import-binding') {
        const parent = node.parent as ts.Node | undefined;
        if (parent && ts.isImportSpecifier(parent)) importBindings.push(parent);
        continue;
      }
      if (reference.kind === 'export-specifier') {
        // A barrel keeps naming the class whatever happens to annotations.
        survives(file);
        continue;
      }
      if (reference.kind === 'declaration') continue;

      if (reference.kind === 'new') constructingFiles.add(file);

      const query = typeQueryOf(node);
      if (query !== undefined) {
        if (!updateUseSites) {
          survives(file);
          continue;
        }
        throw new Error(
          `${locationOf(node)} writes \`${query.getText(referenceSource)}\`, which names the ` +
            `class object itself — what \`new\` needs. An interface has no runtime value and no ` +
            `construct signature, so ${input.name} cannot stand in there. Run with ` +
            'updateUseSites: false to generate the interface without rewriting annotations.',
        );
      }

      if (reference.kind !== 'type-position' || !updateUseSites || inHeritageClause(node)) {
        survives(file);
        continue;
      }

      const parent = node.parent as ts.Node | undefined;
      if (parent && ts.isQualifiedName(parent) && parent.right === node) {
        throw new Error(
          `${locationOf(node)} reaches ${className} through a qualified name ` +
            `(${parent.getText(referenceSource)}); this rewrite can only replace a plain type ` +
            'reference. Run with updateUseSites: false.',
        );
      }

      rewrites.push({ file, start: node.getStart(referenceSource), end: node.getEnd(), newText: input.name });
      rewrittenNodes.push(node);
      useSites.push({ file, line: reference.line, character: reference.character });
    }

    // The refusal the compiler would report as a bare TS2339 somewhere
    // else entirely: a binding this rewrite retypes reads a member the
    // interface was not asked to carry.
    if (updateUseSites) {
      for (const node of rewrittenNodes) {
        const binding = annotatedBinding(node);
        if (!binding) continue;
        for (const read of membersReadOff(session, binding)) {
          if (carriedNames.has(read.name)) continue;
          const declared = eligible.has(read.name);
          throw new Error(
            `${read.at.file}:${read.at.line + 1}:${read.at.character + 1} reads ".${read.name}" ` +
              `off a value this rewrite would retype to ${input.name}, which does not carry it. ` +
              (declared
                ? `Add "${read.name}" to members, or run with updateUseSites: false.`
                : `${className} does not declare "${read.name}" as a public instance member — it ` +
                  'is inherited, private, protected, or static. Extract from the class that ' +
                  'declares it, or run with updateUseSites: false.'),
          );
        }
      }
    }

    if (constructingFiles.size > 0 && updateUseSites) {
      warnings.push(
        `${[...constructingFiles]
          .map((file) => path.relative(session.rootPath, file))
          .sort()
          .join(', ')} still construct ${className} directly. \`new\` needs the class, so those ` +
          'files stay coupled to it however many annotations move to the interface.',
      );
    }

    // The interface text. Rewrites that fall inside a copied signature
    // are applied to the copy as well as in place, so the class and the
    // interface never disagree about a member that mentions the class.
    const rewritten = (node: ts.Node): string => {
      const owner = node.getSourceFile();
      const start = node.getStart(owner);
      const end = node.getEnd();
      let text = owner.text.slice(start, end);
      const inside = rewrites
        .filter(
          (rewrite) =>
            rewrite.file === path.resolve(owner.fileName) &&
            rewrite.start >= start &&
            rewrite.end <= end,
        )
        .sort((a, b) => b.start - a.start);
      for (const rewrite of inside) {
        text =
          text.slice(0, rewrite.start - start) + rewrite.newText + text.slice(rewrite.end - start);
      }
      return text;
    };

    const typeText = (type: ts.Type, where: string): string => {
      const text = checker.typeToString(
        type,
        classDeclaration,
        ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope,
      );
      if (text.includes('import(')) {
        throw new Error(
          `${where} has no written type annotation, and the type the checker reports for it ` +
            `(\`${text}\`) contains an absolute \`import("…")\` path — the fallback typeToString ` +
            'uses for a name it cannot resolve at this location. Annotate the declaration and ' +
            'run again.',
        );
      }
      return text;
    };

    /**
     * A binding pattern with its defaults removed.
     *
     * A destructured parameter keeps its pattern in a signature — the
     * names are documentation — but a default *inside* the pattern is
     * a parameter initializer, which a signature cannot hold: TS2371,
     * once per default. The outer `= {}` is handled by `optional`
     * below; these are the ones nested in the pattern, and they turned
     * up on the first real class this met.
     */
    const patternWithoutDefaults = (name: ts.BindingName): string => {
      if (ts.isIdentifier(name)) return rewritten(name);
      const elements = name.elements
        .map((element) => {
          if (ts.isOmittedExpression(element)) return '';
          const dots = element.dotDotDotToken ? '...' : '';
          const property = element.propertyName
            ? `${element.propertyName.getText(classSource)}: `
            : '';
          return `${dots}${property}${patternWithoutDefaults(element.name)}`;
        })
        .join(', ');
      return ts.isObjectBindingPattern(name) ? `{ ${elements} }` : `[${elements}]`;
    };

    const parameterText = (parameter: ts.ParameterDeclaration): string => {
      const rest = parameter.dotDotDotToken ? '...' : '';
      const name = patternWithoutDefaults(parameter.name);
      // A default value is not writable in a signature, so a defaulted
      // parameter becomes an optional one — the same thing every caller
      // sees, since the default is applied inside the body.
      const optional =
        parameter.questionToken !== undefined ||
        (parameter.initializer !== undefined && parameter.dotDotDotToken === undefined)
          ? '?'
          : '';
      const type = parameter.type
        ? rewritten(parameter.type)
        : typeText(
            checker.getTypeAtLocation(parameter),
            `parameter "${parameter.name.getText(classSource)}" at ${locationOf(parameter)}`,
          );
      return `${rest}${name}${optional}: ${type}`;
    };

    const signatureLines = (member: CarryableMember): string[] => {
      const name = rewritten(member.name);
      if (ts.isPropertyDeclaration(member)) {
        const readonly = flagsOf(member) & ts.ModifierFlags.Readonly ? 'readonly ' : '';
        const optional = member.questionToken ? '?' : '';
        const type = member.type
          ? rewritten(member.type)
          : typeText(
              checker.getTypeAtLocation(member),
              `property "${name}" at ${locationOf(member)}`,
            );
        return [`${readonly}${name}${optional}: ${type};`];
      }
      if (ts.isGetAccessorDeclaration(member)) {
        const type = member.type
          ? rewritten(member.type)
          : typeText(
              checker.getTypeAtLocation(member),
              `getter "${name}" at ${locationOf(member)}`,
            );
        return [`get ${name}(): ${type};`];
      }
      if (ts.isSetAccessorDeclaration(member)) {
        const parameter = member.parameters[0];
        return [`set ${name}(${parameter ? parameterText(parameter) : 'value: unknown'});`];
      }
      const typeParameters = member.typeParameters
        ? `<${member.typeParameters.map((parameter) => rewritten(parameter)).join(', ')}>`
        : '';
      const parameters = member.parameters.map(parameterText).join(', ');
      const optional = member.questionToken ? '?' : '';
      const signature = checker.getSignatureFromDeclaration(member);
      if (!member.type && !signature) {
        throw new Error(
          `The checker reports no signature for method "${name}" at ${locationOf(member)}, so ` +
            'its return type cannot be written. Annotate it and run again.',
        );
      }
      const returns = member.type
        ? rewritten(member.type)
        : typeText(signature!.getReturnType(), `method "${name}" at ${locationOf(member)}`);
      return [`${name}${optional}${typeParameters}(${parameters}): ${returns};`];
    };

    const indent = '  ';
    const body: string[] = [];
    for (const member of carried) {
      for (const declaration of member.declarations) {
        if (!isCarryableKind(declaration)) continue;
        const column = classSource.getLineAndCharacterOfPosition(
          declaration.getStart(classSource, false),
        ).character;
        const doc = jsDocOf(declaration, classSource);
        const lines = [...(doc ? [doc] : []), ...signatureLines(declaration)].join('\n');
        if (
          lines.includes('\n') &&
          /`[^`]*\n/.test(lines)
        ) {
          warnings.push(
            `${member.name} carries a multi-line template literal type, whose line breaks are ` +
              'content rather than layout; check its indentation in the generated interface.',
          );
        }
        body.push(reindent(lines, column, indent));
      }
    }

    const typeParameterText = classDeclaration.typeParameters
      ? `<${classDeclaration.typeParameters.map((parameter) => parameter.getText(classSource)).join(', ')}>`
      : '';
    const typeArgumentText = classDeclaration.typeParameters
      ? `<${classDeclaration.typeParameters.map((parameter) => parameter.name.text).join(', ')}>`
      : '';
    const exported =
      destinationFile !== classFile ||
      (flagsOf(classDeclaration) & ts.ModifierFlags.Export) !== 0 ||
      useSites.some((site) => site.file !== classFile);
    const interfaceText = `${exported ? 'export ' : ''}interface ${input.name}${typeParameterText} {\n${body.join('\n')}\n}`;

    // Names the generated interface needs in scope. Reading them back
    // out of the printed text rather than off the declarations covers
    // the synthesized annotations too, which have no type node to walk.
    const parsed = ts.createSourceFile(
      'extracted-interface.ts',
      interfaceText,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const ownTypeParameters = new Set(
      (classDeclaration.typeParameters ?? []).map((parameter) => parameter.name.text),
    );
    const referencedTypeNames = new Set<string>();
    const collect = (node: ts.Node): void => {
      if (ts.isTypeReferenceNode(node) || ts.isTypeQueryNode(node)) {
        let entity: ts.EntityName = ts.isTypeReferenceNode(node) ? node.typeName : node.exprName;
        while (ts.isQualifiedName(entity)) entity = entity.left;
        if (!ownTypeParameters.has(entity.text)) referencedTypeNames.add(entity.text);
      }
      node.forEachChild(collect);
    };
    collect(parsed);

    // Edits.
    const changes: Record<string, TextEdit[]> = {};
    const add = (file: string, edit: TextEdit): void => {
      changes[file] = [...(changes[file] ?? []), edit];
    };
    const positionIn = (file: string, offset: number) => {
      const source = session.program().getSourceFile(file);
      if (!source) throw new Error(`${file} is not a source file in this project`);
      return source.getLineAndCharacterOfPosition(offset);
    };
    const additions = new Map<string, ImportAddition[]>();
    const requestImport = (file: string, addition: ImportAddition): void => {
      const list = additions.get(file) ?? [];
      if (!list.some((other) => other.name === addition.name)) list.push(addition);
      additions.set(file, list);
    };

    const classScope = scopeAt(checker, classDeclaration);
    if (destinationFile !== classFile) {
      for (const name of referencedTypeNames) {
        const symbol = classScope.get(name);
        if (!symbol) continue;
        const resolved = unalias(checker, symbol);
        const declarations = resolved.declarations ?? [];
        // A global is declared in a script, so there is no module to
        // import it from and nothing to write.
        if (!declarations.some((home) => ts.isExternalModule(home.getSourceFile()))) continue;
        if (
          declarations.some(
            (home) => path.resolve(home.getSourceFile().fileName) === destinationFile,
          )
        ) {
          continue;
        }
        // Always `import type`: an interface's signatures are erased, so
        // nothing they name is needed at runtime.
        const binding = (symbol.declarations ?? [])[0];
        if (binding && ts.isImportSpecifier(binding) && ts.isImportDeclaration(binding.parent.parent.parent)) {
          const statement = binding.parent.parent.parent;
          const origin = resolvedModuleOf(session, statement);
          requestImport(destinationFile, {
            name,
            origin:
              origin === undefined
                ? { kind: 'package', text: (statement.moduleSpecifier as ts.StringLiteral).text }
                : { kind: 'file', file: origin },
            ...(binding.propertyName ? { propertyName: binding.propertyName.text } : {}),
            typeOnly: true,
          });
          continue;
        }
        const home = binding?.getSourceFile();
        if (!home) continue;
        const moduleSymbol = checker.getSymbolAtLocation(home);
        const isExported =
          moduleSymbol !== undefined &&
          checker.getExportsOfModule(moduleSymbol).some((candidate) => candidate.name === name);
        if (!isExported) {
          throw new Error(
            `${input.name} names "${name}", which ${path.resolve(home.fileName)} does not export, ` +
              `so ${destinationFile} cannot refer to it. Extract into the class's own file, or ` +
              `export "${name}".`,
          );
        }
        requestImport(destinationFile, {
          name,
          origin: { kind: 'file', file: path.resolve(home.fileName) },
          typeOnly: true,
        });
      }
    }

    // Files that must name the interface: the class's own file (for the
    // implements clause) and every file holding a rewritten annotation.
    const namingFiles = new Set<string>([classFile, ...useSites.map((site) => site.file)]);
    for (const file of namingFiles) {
      if (file === destinationFile) continue;
      const source = session.program().getSourceFile(file);
      if (!source) continue;
      const anchor = source.statements[source.statements.length - 1] ?? source;
      if (scopeAt(checker, anchor).has(input.name)) {
        throw new Error(
          `"${input.name}" already means something else in ${file}, so the interface cannot be ` +
            'named there',
        );
      }
      requestImport(file, {
        name: input.name,
        origin: { kind: 'file', file: destinationFile },
        typeOnly: true,
      });
    }
    if (destinationSource !== undefined && destinationFile !== classFile) {
      const anchor =
        destinationSource.statements[destinationSource.statements.length - 1] ?? destinationSource;
      if (scopeAt(checker, anchor).has(input.name)) {
        throw new Error(`"${input.name}" already means something else in ${destinationFile}`);
      }
    }
    if (destinationFile === classFile && classScope.has(input.name)) {
      throw new Error(`"${input.name}" already means something else in ${classFile}`);
    }

    // Imports of the class a file no longer needs. `import type { C }`
    // used only by an annotation this rewrote is dead once it moves, and
    // under noUnusedLocals a dead import is TS6133 — which the guard
    // would report as a diagnostic the edit introduced, refusing the
    // whole refactoring over tidiness.
    const removals = new Set<ts.ImportSpecifier>();
    for (const specifier of importBindings) {
      const file = path.resolve(specifier.getSourceFile().fileName);
      if ((survivingByFile.get(file) ?? 0) > 0) continue;
      if (!rewrites.some((rewrite) => rewrite.file === file)) continue;
      removals.add(specifier);
    }

    // Text edits: use-site rewrites first.
    for (const rewrite of rewrites) {
      add(rewrite.file, {
        range: {
          start: positionIn(rewrite.file, rewrite.start),
          end: positionIn(rewrite.file, rewrite.end),
        },
        newText: rewrite.newText,
      });
    }

    // The implements clause.
    const implementsClause = (classDeclaration.heritageClauses ?? []).find(
      (clause) => clause.token === ts.SyntaxKind.ImplementsKeyword,
    );
    const implementsText = `${input.name}${typeArgumentText}`;
    if (implementsClause) {
      const at = implementsClause.getEnd();
      add(classFile, {
        range: { start: positionIn(classFile, at), end: positionIn(classFile, at) },
        newText: `, ${implementsText}`,
      });
    } else {
      const extendsClause = (classDeclaration.heritageClauses ?? [])[0];
      // Anchor on the body's `{`, not on the type parameter list:
      // `typeParameters.end` is the end of the last *parameter*, so on
      // `class Crate<T>` it addresses the gap before `>` and produces
      // `class Crate<T implements Crated<T>>` — a parse error, measured.
      const brace = classDeclaration
        .getChildren(classSource)
        .find((child) => child.kind === ts.SyntaxKind.OpenBraceToken);
      const at = extendsClause ? extendsClause.getEnd() : (brace?.getStart(classSource) ?? classDeclaration.getEnd());
      const spaced = extendsClause || /\s/.test(classSource.text[at - 1] ?? '');
      add(classFile, {
        range: { start: positionIn(classFile, at), end: positionIn(classFile, at) },
        newText: extendsClause
          ? ` implements ${implementsText}`
          : `${spaced ? '' : ' '}implements ${implementsText} `,
      });
    }

    // The interface itself.
    const fileOps: WorkspaceEdit['fileOps'] = [];
    if (createsDestination) {
      fileOps.push({ kind: 'create', file: destinationFile });
      const header = (additions.get(destinationFile) ?? [])
        .map((addition) => importStatement(session, destinationFile, addition))
        .join('\n');
      additions.delete(destinationFile);
      const zero = { line: 0, character: 0 };
      add(destinationFile, {
        range: { start: zero, end: zero },
        newText: `${header === '' ? '' : `${header}\n\n`}${interfaceText}\n`,
      });
    } else if (destinationFile === classFile) {
      let at = classDeclaration.getStart(classSource, true);
      while (at > 0 && classSource.text[at - 1] !== '\n') at--;
      add(classFile, {
        range: { start: positionIn(classFile, at), end: positionIn(classFile, at) },
        newText: `${interfaceText}\n\n`,
      });
    } else {
      const end = destinationSource.getEnd();
      add(destinationFile, {
        range: { start: positionIn(destinationFile, end), end: positionIn(destinationFile, end) },
        newText: `\n${interfaceText}\n`,
      });
    }

    // Import edits, per file, rebuilding a named-import clause wholesale
    // rather than deleting one name and inserting another: two edits in
    // the same list overlap at the comma between them.
    const importFiles = new Set<string>([
      ...additions.keys(),
      ...[...removals].map((specifier) => path.resolve(specifier.getSourceFile().fileName)),
    ]);
    for (const file of importFiles) {
      const source = session.program().getSourceFile(file);
      if (!source) continue;
      const pending = [...(additions.get(file) ?? [])];
      const at = (offset: number) => source.getLineAndCharacterOfPosition(offset);
      const displaced: ts.ImportDeclaration[] = [];

      for (const statement of source.statements) {
        if (!ts.isImportDeclaration(statement)) continue;
        const clause = statement.importClause;
        const bindings = clause?.namedBindings;
        if (!bindings || !ts.isNamedImports(bindings)) continue;
        const survivors = bindings.elements.filter((element) => !removals.has(element));
        const moduleFile = resolvedModuleOf(session, statement);
        const absorbed = pending.filter(
          (addition) =>
            addition.origin.kind === 'file' &&
            addition.origin.file === moduleFile &&
            (!clause.isTypeOnly || addition.typeOnly),
        );
        if (survivors.length === bindings.elements.length && absorbed.length === 0) continue;
        for (const addition of absorbed) pending.splice(pending.indexOf(addition), 1);

        const written = [
          ...survivors.map((element) => element.getText(source)),
          ...absorbed.map((addition) => {
            const alias =
              addition.propertyName && addition.propertyName !== addition.name
                ? `${addition.propertyName} as ${addition.name}`
                : addition.name;
            return addition.typeOnly && !clause.isTypeOnly ? `type ${alias}` : alias;
          }),
        ];
        if (written.length > 0) {
          add(file, {
            range: { start: at(bindings.getStart(source)), end: at(bindings.getEnd()) },
            newText: `{ ${written.join(', ')} }`,
          });
          continue;
        }
        if (clause.name) {
          add(file, {
            range: { start: at(clause.name.getEnd()), end: at(bindings.getEnd()) },
            newText: '',
          });
          continue;
        }
        const span = lineSpanOf(statement, source);
        add(file, { range: { start: at(span.start), end: at(span.end) }, newText: '' });
        displaced.push(statement);
      }

      if (pending.length === 0) continue;
      const text = pending.map((addition) => importStatement(session, file, addition)).join('\n');
      const imports = source.statements
        .filter(ts.isImportDeclaration)
        .filter((statement) => !displaced.includes(statement));
      const last = imports[imports.length - 1];
      if (last) {
        add(file, { range: { start: at(last.getEnd()), end: at(last.getEnd()) }, newText: `\n${text}` });
      } else if (displaced[0]) {
        // Every import this file had is going: the new block takes the
        // vacated lines, so the blank line that followed them still
        // separates imports from code.
        const start = lineSpanOf(displaced[0], source).start;
        add(file, { range: { start: at(start), end: at(start) }, newText: `${text}\n` });
      } else {
        const first = source.statements[0];
        const start = first ? first.getStart(source, true) : 0;
        add(file, { range: { start: at(start), end: at(start) }, newText: `${text}\n\n` });
      }
    }

    if (!updateUseSites) {
      warnings.push(
        'updateUseSites is off, so this generates the interface and asserts it with implements ' +
          'and changes nothing else. TypeScript is structurally typed: every consumer already ' +
          'accepts anything of the right shape, so nothing about what compiles has changed and ' +
          'every signature still names ' +
          `${className}.`,
      );
    }

    const edit: WorkspaceEdit = fileOps.length > 0 ? { changes, fileOps } : { changes };
    const filesChanged = filesTouched(edit);
    const newDiagnostics = (await diagnosticsIntroducedBy(session, edit)).map((d) => d.text);
    const output = {
      edit,
      filesChanged,
      newDiagnostics,
      warnings,
      members: carried.map((member) => member.name),
      useSites: useSites.sort(
        (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.character - b.character,
      ),
    };

    if (input.apply !== true || newDiagnostics.length > 0) return { applied: false, ...output };
    const written = await applyWorkspaceEdit(edit);
    session.invalidate(written);
    return { applied: true, ...output };
  },
};

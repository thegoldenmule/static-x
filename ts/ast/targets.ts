import path from 'node:path';
import ts from 'typescript';
import type { Position } from '../../core/tool/index.js';
import type { TsProjectSession } from '../project/index.js';
import { isDeclarationSite } from './declarations.js';

/**
 * How a caller names the thing to refactor when there is no caret: by
 * declaration name, or by an exact position. Every symbol-addressed
 * refactor takes the same four fields, so one convention and one good
 * ambiguity error serve all of them.
 */
export interface SymbolTarget {
  /** Declaration name to resolve project-wide. */
  symbol?: string;
  /** File path — with line/character, or to disambiguate `symbol`. */
  file?: string;
  /** Zero-based line of the symbol. */
  line?: number;
  /** Zero-based character of the symbol. */
  character?: number;
}

/** JSON Schema fragment for the four targeting fields. */
export const SYMBOL_TARGET_PROPERTIES = {
  symbol: { type: 'string', description: 'Declaration name to target' },
  file: {
    type: 'string',
    description: 'File path (with line/character, or to disambiguate symbol)',
  },
  line: { type: 'integer', minimum: 0, description: 'Zero-based line of the symbol' },
  character: { type: 'integer', minimum: 0, description: 'Zero-based character of the symbol' },
} as const;

export interface ResolvedTarget {
  file: string;
  position: Position;
  /** Offset of the position, which the language service speaks in. */
  offset: number;
  sourceFile: ts.SourceFile;
  /** The declaration found, when the target was resolved by name. */
  declaration?: ts.NamedDeclaration;
}

/** Find declarations named `symbol` across the project. */
export function findDeclarations(
  session: TsProjectSession,
  symbol: string,
  fileFilter?: string,
): ResolvedTarget[] {
  const targets: ResolvedTarget[] = [];
  for (const sourceFile of session.sourceFiles()) {
    if (fileFilter && !sourceFile.fileName.endsWith(fileFilter)) continue;
    // `#tag` is matched with or without its hash: the hash is part of
    // the name in the AST but not part of how anyone refers to it.
    const wanted = symbol.startsWith('#') ? symbol.slice(1) : symbol;
    const visit = (node: ts.Node) => {
      if (
        isDeclarationSite(node) &&
        node.name &&
        (ts.isIdentifier(node.name) || ts.isPrivateIdentifier(node.name)) &&
        (node.name.text === symbol || node.name.text.replace(/^#/, '') === wanted)
      ) {
        const offset = node.name.getStart(sourceFile);
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(offset);
        targets.push({
          file: sourceFile.fileName,
          position: { line, character },
          offset,
          sourceFile,
          declaration: node,
        });
      }
      node.forEachChild(visit);
    };
    visit(sourceFile);
  }
  return targets;
}

/**
 * Resolve a target to one file and position. Declarations sharing a
 * name across files are an error listing the candidates — guessing
 * would refactor the wrong one — while same-file multiples (overloads,
 * declaration merges) name one symbol and resolve to the first.
 */
export function resolveTarget(session: TsProjectSession, target: SymbolTarget): ResolvedTarget {
  if (target.symbol !== undefined) {
    const targets = findDeclarations(session, target.symbol, target.file);
    const files = new Set(targets.map((t) => t.file));
    if (targets.length === 0) {
      throw new Error(`No declaration named "${target.symbol}" found in project`);
    }
    if (files.size > 1) {
      const locations = targets
        .map((t) => `${t.file}:${t.position.line + 1}:${t.position.character + 1}`)
        .join('\n  ');
      throw new Error(
        `"${target.symbol}" is declared in multiple files; disambiguate with file/line/character:\n  ${locations}`,
      );
    }
    return targets[0]!;
  }

  if (target.file === undefined || target.line === undefined || target.character === undefined) {
    throw new Error('Provide either symbol, or file + line + character');
  }
  const file = path.resolve(session.rootPath, target.file);
  const sourceFile = session.program().getSourceFile(file);
  if (!sourceFile) throw new Error(`${file} is not a source file in this project`);
  const position = { line: target.line, character: target.character };
  return {
    file,
    position,
    offset: sourceFile.getPositionOfLineAndCharacter(target.line, target.character),
    sourceFile,
  };
}

/** The declaration a resolved target sits on, by name identifier. */
export function declarationAt(target: ResolvedTarget): ts.NamedDeclaration {
  if (target.declaration) return target.declaration;
  let found: ts.NamedDeclaration | undefined;
  const visit = (node: ts.Node) => {
    if (
      isDeclarationSite(node) &&
      node.name &&
      node.name.getStart(target.sourceFile) <= target.offset &&
      target.offset < node.name.getEnd()
    ) {
      found = node;
    }
    node.forEachChild(visit);
  };
  visit(target.sourceFile);
  if (!found) {
    throw new Error(
      `No declaration at ${target.file}:${target.position.line + 1}:${target.position.character + 1}`,
    );
  }
  return found;
}

/**
 * A member target narrowed by the class that declares it.
 *
 * `symbol` alone is ambiguous the moment two classes declare a `kind` or
 * a `size`, and picking the first match silently refactors the wrong
 * one. With no `class` given this is exactly `resolveTarget`, so callers
 * can pass their input through unconditionally.
 */
export function resolveMemberTarget(
  session: TsProjectSession,
  input: SymbolTarget & { class?: string },
): ResolvedTarget {
  if (input.symbol === undefined || input.class === undefined) return resolveTarget(session, input);
  const candidates = findDeclarations(session, input.symbol, input.file).filter((candidate) => {
    const parent = candidate.declaration?.parent;
    const container = parent && ts.isClassLike(parent) ? parent : undefined;
    return container?.name?.text === input.class;
  });
  if (candidates.length === 0) {
    throw new Error(`No member named "${input.symbol}" is declared on class "${input.class}"`);
  }
  if (new Set(candidates.map((candidate) => candidate.file)).size > 1) {
    const locations = candidates
      .map((candidate) => `${candidate.file}:${candidate.position.line + 1}`)
      .join('\n  ');
    throw new Error(
      `"${input.class}.${input.symbol}" is declared in multiple files; disambiguate with ` +
        `file/line/character:\n  ${locations}`,
    );
  }
  return candidates[0]!;
}

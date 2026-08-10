import path from 'node:path';
import ts from 'typescript';
import type { TsProjectSession } from '../project/index.js';
import { tokenKey } from '../ast/structural.js';

/**
 * Addressing a piece of code that has no name.
 *
 * Rename can be told a symbol; extraction cannot — its target is a
 * span. Asking a caller without a cursor to compute line and character
 * offsets is asking it to count characters, and an approximate answer
 * is worse than no answer here: TypeScript's extraction adjusts the
 * span it is given out to node boundaries, so a range that starts a few
 * characters inside the intended expression yields a complete, valid,
 * plausible extraction of something else.
 *
 * So the caller writes the code instead. Every range TypeScript could
 * legitimately be asked to extract is enumerated and keyed by its
 * tokens; the selection is parsed and keyed the same way; and the
 * lookup either hits exactly one range or refuses. Because a hit is a
 * node by construction, the span adjustment is a no-op and a selection
 * that is not a whole statement run, expression, or type matches
 * nothing at all — a refusal, never a silent widening.
 *
 * Matching on tokens rather than text means indentation, line breaks
 * and comments do not have to be reproduced. It must be *parser*
 * tokens: a raw scanner has no context, so it reads the `}` closing a
 * `${…}` as a plain brace and lets the following backtick open a new
 * template literal that swallows the rest of the file.
 */

export interface SelectionInput {
  /** File the selection lives in. */
  file: string;
  /** The exact code to address. Whitespace and comments are ignored. */
  select: string;
  /**
   * Narrow the search to one function's body. Optional: most files have
   * a unique match without it, and a selection inside a callback has no
   * enclosing named function to give.
   */
  within?: string;
}

export type SelectionKind = 'statements' | 'expression' | 'type';

export interface LocatedSelection {
  file: string;
  sourceFile: ts.SourceFile;
  /** Offsets, which the language service speaks. */
  range: ts.TextRange;
  kind: SelectionKind;
  /** The source text the range actually covers. */
  text: string;
  /** One-based line of the range's start, for messages. */
  line: number;
}

export const SELECTION_PROPERTIES = {
  select: {
    type: 'string',
    description:
      'The exact code to act on — a statement, a run of statements, an expression, or a type. ' +
      'Indentation, line breaks and comments need not match; the code must.',
  },
  within: {
    type: 'string',
    description:
      'Name of the enclosing function or method, when the same code appears more than once in the file',
  },
} as const;

interface Candidate {
  key: string;
  range: ts.TextRange;
  kind: SelectionKind;
  line: number;
}

/** A function with a body — `ts.isFunctionLike` also admits signatures. */
function bodied(node: ts.Node): ts.FunctionLikeDeclaration | undefined {
  if (!ts.isFunctionLike(node)) return undefined;
  const fn = node as ts.FunctionLikeDeclaration;
  return fn.body ? fn : undefined;
}

/** Functions in the file declared under `name`, however they are written. */
function functionsNamed(sourceFile: ts.SourceFile, name: string): ts.FunctionLikeDeclaration[] {
  const found: ts.FunctionLikeDeclaration[] = [];
  const visit = (node: ts.Node): void => {
    const fn = bodied(node);
    if (fn) {
      let declared: string | undefined;
      if (fn.name && (ts.isIdentifier(fn.name) || ts.isStringLiteral(fn.name))) {
        declared = fn.name.text;
      } else if (
        (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) &&
        fn.parent &&
        (ts.isVariableDeclaration(fn.parent) || ts.isPropertyDeclaration(fn.parent)) &&
        ts.isIdentifier(fn.parent.name)
      ) {
        declared = fn.parent.name.text;
      }
      if (declared === name) found.push(fn);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

/**
 * Every range extraction could legitimately be asked for: each
 * contiguous run of statements in each block, each expression, and each
 * type node. Statement runs are enumerated per block rather than only
 * at the function's top level — a selection inside an `if` or a loop is
 * an ordinary thing to want, and index-based addressing cannot name one
 * at all.
 */
function candidatesIn(sourceFile: ts.SourceFile, root: ts.Node): Candidate[] {
  const found: Candidate[] = [];
  const lineOf = (pos: number) => sourceFile.getLineAndCharacterOfPosition(pos).line + 1;

  const addRuns = (statements: readonly ts.Statement[]): void => {
    const keys = statements.map((statement) => tokenKey(statement, sourceFile));
    for (let start = 0; start < statements.length; start++) {
      let key = '';
      for (let end = start; end < statements.length; end++) {
        key = key === '' ? keys[end]! : `${key} ${keys[end]!}`;
        found.push({
          key,
          range: { pos: statements[start]!.getStart(sourceFile), end: statements[end]!.getEnd() },
          kind: 'statements',
          line: lineOf(statements[start]!.getStart(sourceFile)),
        });
      }
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isBlock(node) || ts.isCaseClause(node) || ts.isDefaultClause(node)) {
      addRuns(node.statements);
    } else if (ts.isSourceFile(node)) {
      addRuns(node.statements);
    }
    if (ts.isExpression(node)) {
      found.push({
        key: tokenKey(node, sourceFile),
        range: { pos: node.getStart(sourceFile), end: node.getEnd() },
        kind: 'expression',
        line: lineOf(node.getStart(sourceFile)),
      });
    } else if (ts.isTypeNode(node)) {
      found.push({
        key: tokenKey(node, sourceFile),
        range: { pos: node.getStart(sourceFile), end: node.getEnd() },
        kind: 'type',
        line: lineOf(node.getStart(sourceFile)),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

function parseDiagnosticsOf(sourceFile: ts.SourceFile): readonly ts.Diagnostic[] {
  return (sourceFile as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? [];
}

/**
 * The keys a selection could be asking for, most-likely first. A
 * selection can read as more than one thing — `f(x);` is a statement
 * whose expression is `f(x)` — so the reading the caller wrote wins:
 * a trailing semicolon means they wrote a statement.
 */
function keysFor(select: string): { keys: { key: string; kind: SelectionKind }[]; error?: string } {
  const trimmed = select.trim();
  if (trimmed === '') return { keys: [], error: 'select is empty' };

  const keys: { key: string; kind: SelectionKind }[] = [];

  const asCode = ts.createSourceFile('__select.ts', trimmed, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if (parseDiagnosticsOf(asCode).length === 0 && asCode.statements.length > 0) {
    const statementsKey = asCode.statements
      .map((statement) => tokenKey(statement, asCode))
      .join(' ');
    const only = asCode.statements.length === 1 ? asCode.statements[0] : undefined;
    const expression =
      only && ts.isExpressionStatement(only) ? tokenKey(only.expression, asCode) : undefined;

    if (expression !== undefined && !trimmed.endsWith(';')) {
      keys.push({ key: expression, kind: 'expression' });
      keys.push({ key: statementsKey, kind: 'statements' });
    } else {
      keys.push({ key: statementsKey, kind: 'statements' });
      if (expression !== undefined) keys.push({ key: expression, kind: 'expression' });
    }
  }

  // A type reading is always worth keeping as a fallback, because the
  // ambiguity runs both ways: `{ host: string }` parses cleanly as a
  // block containing a labelled statement, and `Endpoint` parses as an
  // expression. Neither would find anything, so the type key has to be
  // tried rather than chosen up front.
  const asType = ts.createSourceFile(
    '__select.ts',
    `type __T = ${trimmed};`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const alias = asType.statements[0];
  if (parseDiagnosticsOf(asType).length === 0 && alias && ts.isTypeAliasDeclaration(alias)) {
    keys.push({ key: tokenKey(alias.type, asType), kind: 'type' });
  }

  if (keys.length > 0) return { keys };

  const reported = parseDiagnosticsOf(asCode)[0];
  return {
    keys: [],
    error: reported
      ? `select does not parse as code or as a type: ${ts.flattenDiagnosticMessageText(reported.messageText, ' ')}`
      : 'select does not parse as code or as a type',
  };
}

/**
 * Resolve a selection to the range it names, or throw explaining why it
 * does not name one. Refusals carry what the caller needs for a single
 * deterministic retry — the lines a repeated selection occurs on, or
 * the functions it could be narrowed to.
 */
export function locateSelection(
  session: TsProjectSession,
  input: SelectionInput,
): LocatedSelection {
  const file = path.resolve(session.rootPath, input.file);
  const sourceFile = session.program().getSourceFile(file);
  if (!sourceFile) throw new Error(`${file} is not a source file in this project`);

  let root: ts.Node = sourceFile;
  if (input.within !== undefined) {
    const functions = functionsNamed(sourceFile, input.within);
    if (functions.length === 0) {
      throw new Error(`No function named "${input.within}" in ${input.file}`);
    }
    if (functions.length > 1) {
      const lines = functions
        .map((fn) => sourceFile.getLineAndCharacterOfPosition(fn.getStart(sourceFile)).line + 1)
        .join(', ');
      throw new Error(
        `"${input.within}" is declared more than once in ${input.file} (lines ${lines}); ` +
          'select a wider range instead of narrowing by name',
      );
    }
    root = functions[0]!.body as ts.Node;
  }

  const { keys, error } = keysFor(input.select);
  if (error) throw new Error(error);

  const all = candidatesIn(sourceFile, root);
  const where = input.within === undefined ? input.file : `"${input.within}"`;

  for (const { key, kind } of keys) {
    const hits = all.filter((candidate) => candidate.key === key && candidate.kind === kind);
    if (hits.length === 0) continue;

    const distinct = new Map(hits.map((hit) => [`${hit.range.pos}:${hit.range.end}`, hit]));
    if (distinct.size > 1) {
      const lines = [...new Set([...distinct.values()].map((hit) => hit.line))].join(', ');
      throw new Error(
        `That selection occurs ${distinct.size} times in ${where} (lines ${lines}). ` +
          (input.within === undefined
            ? 'Narrow it with "within", or include a neighbouring statement.'
            : 'Include a neighbouring statement to make it unique.'),
      );
    }
    const hit = [...distinct.values()][0]!;
    return {
      file,
      sourceFile,
      range: hit.range,
      kind: hit.kind,
      text: sourceFile.getFullText().slice(hit.range.pos, hit.range.end),
      line: hit.line,
    };
  }

  throw new Error(
    `That selection is not a whole statement, run of statements, expression, or type in ${where}. ` +
      'It must match one exactly — whitespace and comments are ignored, but the code is not.',
  );
}

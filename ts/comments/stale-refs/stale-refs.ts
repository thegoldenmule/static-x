import path from 'node:path';
import ts from 'typescript';
import type { Finding, Tool } from '../../../core/tool/index.js';
import type { TsProjectSession } from '../../project/index.js';
import { declaredNames, literalVocabulary, nodeAt } from '../../ast/declarations.js';
import { collectCommentRanges } from '../collect.js';

/**
 * Finds comments that reference code that doesn't exist: @param names
 * that match no parameter, @see/{@link} targets and backtick code
 * spans that resolve to no symbol, and (conservatively) bare prose
 * words shaped like identifiers that resolve nowhere.
 */

type Source = 'param-tag' | 'jsdoc-tag' | 'code-span' | 'bare';

interface Candidate {
  /** As written, e.g. "math.add()" */
  raw: string;
  /** Identifier segments, e.g. ["math", "add"] */
  segments: string[];
  /** Offset of raw within the comment text. */
  offset: number;
  source: Source;
  /** A filename reference ("ref-set-sugar.test.ts"), resolved against files. */
  isFile?: boolean;
}

const CHAIN = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:\(\))?$/;
const CODE_SPAN = /`([^`\n]+)`/g;
const LINK_TAG = /\{@link(?:code|plain)?\s+([^}\s|]+)[^}]*\}/g;
const SEE_TAG = /@see\s+(?!\{@)([\w$.]+(?:\(\))?)/g;
const PARAM_TAG = /@param\s+(?:\{[^}]*\}\s+)?\[?([\w$.]+)/g;
const BARE_TOKEN = /[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:\(\))?/g;
/** Filenames allow hyphens, which identifier chains never do. */
const SOURCE_EXTENSIONS = 'tsx?|[mc]?js|jsx|json|md';
const FILE_NAME = new RegExp(`^[\\w$][\\w$.-]*\\.(?:${SOURCE_EXTENSIONS})$`);
const FILE_REF = new RegExp(`[\\w$][\\w$.-]*\\.(?:${SOURCE_EXTENSIONS})\\b`, 'g');

/** Well-known prose words that are identifier-shaped but not code. */
const PROSE_STOPLIST = new Set([
  'TypeScript', 'JavaScript', 'JSDoc', 'GitHub', 'GraphQL', 'WebSocket',
  'OAuth', 'macOS', 'iOS', 'PostgreSQL', 'MongoDB', 'DevTools', 'IntelliSense',
  'CommonMark',
]);

/** Keywords aren't symbols, so the checker never returns them. */
// prettier-ignore
const TS_KEYWORDS = new Set([
  'string', 'number', 'boolean', 'object', 'symbol', 'bigint', 'any', 'unknown',
  'never', 'void', 'null', 'undefined', 'true', 'false', 'this', 'super', 'new',
  'import', 'export', 'default', 'delete', 'typeof', 'instanceof', 'in', 'of',
  'as', 'is', 'keyof', 'infer', 'satisfies', 'asserts', 'readonly', 'const',
  'let', 'var', 'function', 'class', 'interface', 'type', 'enum', 'namespace',
  'module', 'declare', 'abstract', 'static', 'public', 'private', 'protected',
  'async', 'await', 'yield', 'return', 'if', 'else', 'switch', 'case', 'break',
  'continue', 'for', 'while', 'do', 'try', 'catch', 'finally', 'throw',
  'extends', 'implements', 'get', 'set',
]);

/**
 * Members of the standard builtins (toISOString, sort, parse, ...).
 * These are properties, not scope symbols, so the checker can't
 * resolve a comment's bare `toISOString()` — reflection can.
 */
const BUILTIN_MEMBERS: ReadonlySet<string> = (() => {
  const names = new Set<string>();
  const sources: object[] = [
    Object.prototype, Array.prototype, String.prototype, Number.prototype,
    Boolean.prototype, Date.prototype, RegExp.prototype, Function.prototype,
    Promise.prototype, Map.prototype, Set.prototype, Error.prototype,
    Math, JSON, Object, Array, Reflect, console,
  ];
  for (const source of sources) {
    for (const name of Object.getOwnPropertyNames(source)) names.add(name);
  }
  return names;
})();

function segmentsOf(raw: string): string[] {
  return raw.replace(/\(\)$/, '').split('.');
}

/**
 * Does this token look like a code reference rather than prose? A dot
 * chain, call parens, an underscore, or a case hump qualifies; single
 * capitalized or lowercase words ("Note", "the") do not.
 */
function looksLikeCode(raw: string): boolean {
  const bare = raw.replace(/\(\)$/, '');
  return (
    raw.endsWith('()') ||
    bare.includes('.') ||
    /[a-z_][\w$]*_[\w$]/.test(bare) ||
    /[a-z][A-Z]/.test(bare)
  );
}

/** Blank a span so later extraction passes can't re-match it. */
function blank(text: string, start: number, length: number): string {
  return text.slice(0, start) + ' '.repeat(length) + text.slice(start + length);
}

export function extractCandidates(commentText: string): Candidate[] {
  const candidates: Candidate[] = [];
  let working = commentText;

  const take = (regex: RegExp, source: Source, requireCodeShape: boolean) => {
    for (const match of commentText.matchAll(regex)) {
      working = blank(working, match.index, match[0].length);
      const raw = match[1];
      if (raw === undefined) continue;
      const offset = match.index + match[0].indexOf(raw);
      if (source !== 'param-tag' && FILE_NAME.test(raw)) {
        candidates.push({ raw, segments: [raw], offset, source, isFile: true });
        continue;
      }
      if (!CHAIN.test(raw)) continue;
      if (requireCodeShape && !looksLikeCode(raw)) continue;
      candidates.push({ raw, segments: segmentsOf(raw), offset, source });
    }
  };

  take(PARAM_TAG, 'param-tag', false);
  take(LINK_TAG, 'jsdoc-tag', true);
  take(SEE_TAG, 'jsdoc-tag', true);
  take(CODE_SPAN, 'code-span', false);

  // Filename references first — they may contain hyphens, which the
  // bare-token pass would split into misleading fragments.
  for (const match of working.matchAll(FILE_REF)) {
    const raw = match[0];
    working = blank(working, match.index, raw.length);
    candidates.push({ raw, segments: [raw], offset: match.index, source: 'bare', isFile: true });
  }

  for (const match of working.matchAll(BARE_TOKEN)) {
    const raw = match[0];
    if (!CHAIN.test(raw) || !looksLikeCode(raw)) continue;
    if (PROSE_STOPLIST.has(raw.replace(/\(\)$/, ''))) continue;
    candidates.push({ raw, segments: segmentsOf(raw), offset: match.index, source: 'bare' });
  }
  return candidates;
}

/** Parameter names of the function a JSDoc comment documents. */
function paramOwners(sourceFile: ts.SourceFile): Map<number, ts.SignatureDeclaration> {
  const text = sourceFile.getFullText();
  const owners = new Map<number, ts.SignatureDeclaration>();
  const attach = (statement: ts.Node, fn: ts.SignatureDeclaration) => {
    for (const range of ts.getLeadingCommentRanges(text, statement.getFullStart()) ?? []) {
      owners.set(range.pos, fn);
    }
  };
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
      attach(node, node);
    } else if (
      (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) &&
      ts.isVariableDeclaration(node.parent) &&
      node.parent.parent.parent && ts.isVariableStatement(node.parent.parent.parent)
    ) {
      attach(node.parent.parent.parent, node);
    }
    node.forEachChild(visit);
  };
  visit(sourceFile);
  return owners;
}

export const staleRefs: Tool<Record<string, never>, Finding[], TsProjectSession> = {
  name: 'ts/comments/stale-refs',
  description:
    'Finds comments referencing code that does not exist: @param names matching no ' +
    'parameter (high confidence), @see/{@link} targets and backtick code spans that ' +
    'resolve to no symbol in scope or in the project (medium), and identifier-shaped ' +
    'prose words that resolve nowhere (low). Resolution uses the type checker, so ' +
    'globals, imports, and locals all count as resolved.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  outputSchema: { type: 'array', items: { $ref: '#/definitions/finding' } },
  run(session) {
    const checker = session.checker();
    const projectNames = new Set<string>();
    for (const sourceFile of session.sourceFiles()) {
      for (const name of declaredNames(sourceFile)) projectNames.add(name);
      // String-literal vocabulary counts as existing: union tags, event
      // types, and sentinel values are what comments most often name.
      for (const name of literalVocabulary(sourceFile)) projectNames.add(name);
    }

    // Filename references resolve against real files: project sources
    // first, then a one-time listing of the whole project root.
    let rootListing: Set<string> | undefined;
    const projectBasenames = new Set(
      session.sourceFiles().map((sf) => path.basename(sf.fileName)),
    );
    const fileExists = (name: string): boolean => {
      if (projectBasenames.has(name)) return true;
      rootListing ??= new Set(
        ts.sys
          .readDirectory(
            session.rootPath,
            ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md'],
            ['**/node_modules'],
            undefined,
          )
          .map((file) => path.basename(file)),
      );
      return rootListing.has(name);
    };

    const findings: Finding[] = [];
    for (const sourceFile of session.sourceFiles()) {
      const text = sourceFile.getFullText();
      const owners = paramOwners(sourceFile);
      const scopeCache = new Map<ts.Node, Set<string>>();

      const scopeNamesAt = (position: number): Set<string> => {
        const node = nodeAt(sourceFile, position);
        let names = scopeCache.get(node);
        if (!names) {
          const flags =
            ts.SymbolFlags.Value | ts.SymbolFlags.Type | ts.SymbolFlags.Namespace | ts.SymbolFlags.Alias;
          names = new Set(checker.getSymbolsInScope(node, flags).map((s) => s.name));
          scopeCache.set(node, names);
        }
        return names;
      };

      for (const comment of collectCommentRanges(sourceFile)) {
        const commentText = text.slice(comment.pos, comment.end);
        const owner = owners.get(comment.pos);
        // Binding-pattern params have no single name; skip validation.
        const paramNames =
          owner && owner.parameters.every((p) => ts.isIdentifier(p.name))
            ? owner.parameters.map((p) => (p.name as ts.Identifier).text)
            : undefined;

        for (const candidate of extractCandidates(commentText)) {
          const start = comment.pos + candidate.offset;
          const range = {
            start: sourceFile.getLineAndCharacterOfPosition(start),
            end: sourceFile.getLineAndCharacterOfPosition(start + candidate.raw.length),
          };

          if (candidate.source === 'param-tag') {
            if (paramNames && !paramNames.includes(candidate.raw)) {
              findings.push({
                file: sourceFile.fileName,
                range,
                code: 'comment.stale-param',
                message: `@param "${candidate.raw}" does not match any parameter of the documented function (parameters: ${paramNames.join(', ')}).`,
                severity: 'warning',
                data: { name: candidate.raw, source: candidate.source, confidence: 'high' },
              });
            }
            continue;
          }

          if (candidate.isFile) {
            if (fileExists(candidate.raw)) continue;
            findings.push({
              file: sourceFile.fileName,
              range,
              code: 'comment.stale-ref',
              message: `Comment references "${candidate.raw}", which does not match any file in the project.`,
              severity: 'warning',
              data: { name: candidate.raw, source: candidate.source, confidence: 'medium', kind: 'file' },
            });
            continue;
          }

          const scopeNames = scopeNamesAt(comment.end);
          const resolves = candidate.segments.some(
            (segment) =>
              scopeNames.has(segment) ||
              projectNames.has(segment) ||
              TS_KEYWORDS.has(segment) ||
              BUILTIN_MEMBERS.has(segment),
          );
          if (resolves) continue;

          const confidence = candidate.source === 'bare' ? 'low' : 'medium';
          findings.push({
            file: sourceFile.fileName,
            range,
            code: 'comment.stale-ref',
            message: `Comment references "${candidate.raw}", which does not resolve to any symbol in scope or anywhere in the project.`,
            severity: candidate.source === 'bare' ? 'info' : 'warning',
            data: { name: candidate.raw, source: candidate.source, confidence },
          });
        }
      }
    }
    return Promise.resolve(findings);
  },
};

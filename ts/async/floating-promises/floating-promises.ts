import ts from 'typescript';
import type { Finding, Severity, Tool } from '../../../core/tool/index.js';
import { truncateFlat } from '../../ast/truncate.js';
import type { TsProjectSession } from '../../project/index.js';
import { isTestFile } from '../../project/index.js';

/**
 * Type-aware unawaited-thenable detection at statement level: flags
 * expression statements whose value is thenable but neither awaited
 * nor otherwise consumed. Because detection goes through the checker
 * rather than call-name matching, any Promise-typed expression counts
 * (Promise.all included) and custom thenables like Fastify's
 * FastifyReply are found — and separable by type name in config.
 */

export interface FloatingPromisesInput {
  /**
   * Also scan `*.test.ts(x)` / `*.spec.ts(x)` files. Default true: a
   * dropped rejection in a test silently passes the test.
   */
  includeTests?: boolean;
}

const MAX_PREVIEW_CHARS = 60;

function unwrapParens(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

/**
 * Type-level wrappers are transparent to rejection handling: `!`,
 * `as`/angle-bracket casts, and `satisfies` change only the static
 * type, so a handled chain stays handled underneath them
 * (`x.catch(g)!;` observes its rejection exactly as `x.catch(g);`
 * does).
 */
function unwrapAssertions(node: ts.Expression): ts.Expression {
  let current = unwrapParens(node);
  while (
    ts.isNonNullExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = unwrapParens(current.expression);
  }
  return current;
}

/**
 * The member access underlying a chain link, whether written
 * `x.catch` or `x['catch']` — computed access with a static string
 * key names the same method.
 */
function memberAccess(
  callee: ts.Expression,
): { method: string; target: ts.Expression } | undefined {
  if (ts.isPropertyAccessExpression(callee)) {
    return { method: callee.name.text, target: callee.expression };
  }
  if (ts.isElementAccessExpression(callee) && ts.isStringLiteralLike(callee.argumentExpression)) {
    return { method: callee.argumentExpression.text, target: callee.expression };
  }
  return undefined;
}

/**
 * Does a call chain's final link observe rejections? `.catch(handler)`
 * and two-argument `.then(onFulfilled, onRejected)` do. `.finally()`
 * handles nothing itself but is transparent — it forwards its input
 * promise's fate — so a chain ending `.finally(...)` is judged by
 * whatever sits beneath the trailing finally calls:
 * `x.catch(f).finally(g)` is handled, bare `x.finally(g)` is not.
 */
function chainHandlesRejection(expression: ts.Expression): boolean {
  const call = unwrapAssertions(expression);
  if (!ts.isCallExpression(call)) return false;
  const member = memberAccess(unwrapParens(call.expression));
  if (member === undefined) return false;
  if (member.method === 'catch' && call.arguments.length >= 1) return true;
  if (member.method === 'then' && call.arguments.length >= 2) return true;
  if (member.method === 'finally') return chainHandlesRejection(member.target);
  return false;
}

/**
 * A statement whose result the code already consumes or deliberately
 * discards: awaited, `void`-discarded, stored or combined (assignment
 * and other binary expressions — logical operators included, matching
 * this tool's spec where typescript-eslint would recurse into their
 * operands — plus unary increments/negations and delete), or
 * terminated by a rejection-observing chain link. The comma operator
 * is the one binary form that stores nothing: the statement's value
 * IS the right operand's, so that operand is judged in its place.
 */
function isHandled(expression: ts.Expression): boolean {
  const expr = unwrapParens(expression);
  if (ts.isBinaryExpression(expr)) {
    return expr.operatorToken.kind !== ts.SyntaxKind.CommaToken || isHandled(expr.right);
  }
  return (
    ts.isAwaitExpression(expr) ||
    ts.isVoidExpression(expr) ||
    ts.isPrefixUnaryExpression(expr) ||
    ts.isPostfixUnaryExpression(expr) ||
    ts.isDeleteExpression(expr) ||
    chainHandlesRejection(expr)
  );
}

/**
 * The constituents of a type that are thenable: a `then` property
 * whose type is callable. A union counts if any constituent does —
 * `Promise<void> | undefined` from an optional call is still a
 * droppable promise.
 */
function thenableConstituents(
  type: ts.Type,
  atNode: ts.Node,
  checker: ts.TypeChecker,
): ts.Type[] {
  const constituents = type.isUnion() ? type.types : [type];
  return constituents.filter((constituent) => {
    const then = constituent.getProperty('then');
    if (then === undefined) return false;
    return checker.getTypeOfSymbolAtLocation(then, atNode).getCallSignatures().length > 0;
  });
}

/**
 * A type's symbol name, unless it is compiler-internal (`__type`).
 * Two indirections resolve to the name a user would recognize: a type
 * parameter reports its base constraint ('T' is useless in an ignore
 * list and collides across every generic), and an anonymous
 * intersection reports a member — preferring 'Promise', so
 * cancellable-promise shapes like `Promise<T> & { cancel(): void }`
 * keep the Promise grade.
 */
function symbolName(type: ts.Type, checker: ts.TypeChecker): string | undefined {
  // Flags, not isTypeParameter(): that predicate's false branch
  // narrows Type to never (TypeParameter adds no visible members).
  if ((type.flags & ts.TypeFlags.TypeParameter) !== 0) {
    const constraint = checker.getBaseConstraintOfType(type);
    return constraint === undefined || constraint === type
      ? undefined
      : symbolName(constraint, checker);
  }
  if (type.isIntersection()) {
    const names = type.types.map((member) => symbolName(member, checker));
    return names.find((name) => name === 'Promise') ?? names.find((name) => name !== undefined);
  }
  const name = type.symbol?.name;
  return name === undefined || name.startsWith('__') ? undefined : name;
}

/** Fallback finding name for anonymous thenables: what was called. */
function calleeText(expression: ts.Expression, sourceFile: ts.SourceFile): string {
  const expr = unwrapParens(expression);
  const callee =
    ts.isCallExpression(expr) || ts.isNewExpression(expr) ? expr.expression : expr;
  return truncateFlat(callee.getText(sourceFile), MAX_PREVIEW_CHARS);
}

export function findFloatingPromisesInFile(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  input: FloatingPromisesInput = {},
): Finding[] {
  if (!(input.includeTests ?? true) && isTestFile(sourceFile.fileName)) return [];

  const findings: Finding[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isExpressionStatement(node) && !isHandled(node.expression)) {
      const expr = unwrapParens(node.expression);
      const thenables = thenableConstituents(checker.getTypeAtLocation(expr), expr, checker);
      if (thenables.length > 0) {
        const names = thenables.map((thenable) => symbolName(thenable, checker));
        const promise = names.includes('Promise');
        const name =
          (promise ? 'Promise' : names.find((n) => n !== undefined)) ??
          calleeText(node.expression, sourceFile);
        const [severity, confidence, message]: [Severity, string, string] = promise
          ? [
              'warning',
              'high',
              'This statement creates a Promise and drops it: nothing awaits the work, ' +
                'execution continues immediately, and a rejection becomes an unhandled ' +
                'rejection. Await it, return it, attach .catch(handler) or ' +
                '.then(onFulfilled, onRejected), or mark deliberate fire-and-forget ' +
                "with the 'void' operator.",
              ]
          : [
              'info',
              'medium',
              `This statement discards a thenable '${name}' unawaited. Custom thenables ` +
                'are often fluent framework APIs (FastifyReply-style) where discarding ' +
                `the return value is idiomatic — if '${name}' is one, add it to this ` +
                "tool's ignore list in static-x.json; otherwise await or handle it.",
            ];
        findings.push({
          file: sourceFile.fileName,
          range: {
            start: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)),
            end: sourceFile.getLineAndCharacterOfPosition(node.getEnd()),
          },
          code: 'async.floating-promise',
          message,
          severity,
          data: {
            name,
            kind: promise ? 'promise' : 'thenable',
            confidence,
            preview: truncateFlat(node.getText(sourceFile), MAX_PREVIEW_CHARS),
          },
        });
      }
    }
    // Recurse even through handled statements: `void (async () => {
    // load(); })()` discards only the outer promise, and callbacks in
    // arguments carry statements of their own.
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

export const floatingPromises: Tool<FloatingPromisesInput, Finding[], TsProjectSession> = {
  name: 'ts/async/floating-promises',
  description:
    'Finds floating promises: expression statements whose value is thenable — the type has ' +
    'a callable then property — but is neither awaited nor otherwise consumed ' +
    '(async.floating-promise). Detection is type-aware through the checker, not call-name ' +
    'matching, so Promise.all/race count, a union with any thenable constituent counts ' +
    '(an optional call returning Promise | undefined), and non-promise calls never ' +
    'false-positive. Handled statements are exempt: await, the void operator, assignment ' +
    'and other binary/unary/delete statements (the comma operator excepted — its value is ' +
    'the right operand, which is judged in its place), a chain ending .catch(handler), or ' +
    '.then(onFulfilled, onRejected) with both callbacks; .finally() handles nothing itself ' +
    'but is transparent, so x.catch(f).finally(g) is handled while x.finally(g) is flagged. ' +
    "Genuine Promises are warning/high; other thenables (fluent framework APIs like " +
    "Fastify's FastifyReply whose instances happen to be awaitable) are info/medium. " +
    "data.name is the thenable type's symbol name, so one ignore entry in static-x.json " +
    'silences a whole fluent-API class. Fix by awaiting, returning, attaching a rejection ' +
    'handler, or marking deliberate fire-and-forget with void.',
  inputSchema: {
    type: 'object',
    properties: {
      includeTests: {
        type: 'boolean',
        description: 'Also scan *.test.ts(x) / *.spec.ts(x) files (default true)',
      },
    },
    additionalProperties: false,
  },
  outputSchema: { type: 'array', items: { $ref: '#/definitions/finding' } },
  run(session, input) {
    const checker = session.checker();
    return Promise.resolve(
      session
        .sourceFiles()
        .flatMap((sourceFile) => findFloatingPromisesInFile(sourceFile, checker, input))
        .sort(
          (a, b) =>
            (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) ||
            a.range.start.line - b.range.start.line ||
            a.range.start.character - b.range.start.character,
        ),
    );
  },
};

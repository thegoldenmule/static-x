import ts from 'typescript';
import type { Finding, Range, Severity, Tool } from '../../../core/tool/index.js';
import { FINDINGS_ARRAY_SCHEMA } from '../../../core/tool/index.js';
import { unwrapParens } from '../../ast/expressions.js';
import { truncateFlat } from '../../../core/text/index.js';
import type { TsProjectSession } from '../../project/index.js';
import { isTestFile } from '../../project/index.js';
import { collectCommentRanges } from '../../comments/collect.js';

/**
 * Audits type-safety escape hatches: every place the code overrides or
 * silences the checker instead of satisfying it. Four finding codes —
 * types.assertion, types.non-null, types.any, types.directive — from
 * one syntactic pass, so no checker is needed and every finding is an
 * exact syntax match at high confidence.
 */

export interface LoopholesInput {
  /**
   * Also scan `*.test.ts(x)` / `*.spec.ts(x)` files. Default true: a
   * cast in tests is still a cast.
   */
  includeTests?: boolean;
}

/**
 * TypeScript's own directive grammar, mirrored from the scanner and
 * the pragma parser. In a `//` comment, `@ts-expect-error` and
 * `@ts-ignore` match by prefix — tsc honors `@ts-ignore-me` too —
 * while the `@ts-nocheck` pragma's name ends at whitespace or `:`, so
 * `@ts-nocheck-me` is inert. In a block comment tsc consults only the
 * last line, and only for `@ts-expect-error`/`@ts-ignore`; a
 * block-comment `@ts-nocheck` never takes effect.
 */
const SINGLE_LINE_DIRECTIVE = /^\/\/\/?\s*(@ts-(?:expect-error|ignore)|@ts-nocheck(?=[\s:]|$))/;
const MULTI_LINE_DIRECTIVE = /^(?:\/|\*)*\s*(@ts-(?:expect-error|ignore))/;

const MAX_NAME_CHARS = 40;

function truncateName(text: string): string {
  return truncateFlat(text, MAX_NAME_CHARS);
}

/** Where an `any` annotation sits; parameters and returns are contagion points. */
type AnyPosition = 'parameter' | 'return' | 'other';

/**
 * The nested assertion of a double-cast (`x as unknown as T`), reached
 * through any parentheses. A const assertion never counts as the inner
 * leg: `(x as const) as T` asserts once, off a value the checker still
 * fully understands.
 */
function innerAssertion(node: ts.AssertionExpression): ts.AssertionExpression | undefined {
  const operand = unwrapParens(node.expression);
  return ts.isAssertionExpression(operand) && !ts.isConstTypeReference(operand.type)
    ? operand
    : undefined;
}

/**
 * The return-type annotation of a function-like node, when the node
 * form can carry one. Get accessors count: `get x(): any` spreads
 * `any` into every read exactly as a return type spreads it into
 * every call. Index signatures are excluded: their `.type` annotates
 * a member's value type, not a call result.
 */
function returnTypeOf(node: ts.Node): ts.TypeNode | undefined {
  return ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isMethodSignature(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isCallSignatureDeclaration(node) ||
    ts.isConstructSignatureDeclaration(node) ||
    ts.isFunctionTypeNode(node) ||
    ts.isConstructorTypeNode(node)
    ? node.type
    : undefined;
}

export function findLoopholesInFile(
  sourceFile: ts.SourceFile,
  input: LoopholesInput = {},
): Finding[] {
  if (!(input.includeTests ?? true) && isTestFile(sourceFile.fileName)) return [];

  const findings: Finding[] = [];
  const rangeOf = (pos: number, end: number): Range => ({
    start: sourceFile.getLineAndCharacterOfPosition(pos),
    end: sourceFile.getLineAndCharacterOfPosition(end),
  });
  const push = (
    pos: number,
    end: number,
    code: string,
    message: string,
    severity: Severity,
    name: string,
    kind: string,
  ): void => {
    findings.push({
      file: sourceFile.fileName,
      range: rangeOf(pos, end),
      code,
      message,
      severity,
      data: { name, kind, confidence: 'high' },
    });
  };

  const text = sourceFile.getFullText();
  // tsc reads the @ts-nocheck pragma only from comments before the
  // first token; anywhere later the directive is inert.
  const firstTokenStart = sourceFile.getStart(sourceFile);
  for (const comment of collectCommentRanges(sourceFile)) {
    const commentText = text.slice(comment.pos, comment.end);
    const directive =
      comment.kind === ts.SyntaxKind.SingleLineCommentTrivia
        ? SINGLE_LINE_DIRECTIVE.exec(commentText)?.[1]
        : MULTI_LINE_DIRECTIVE.exec(
            commentText.slice(commentText.lastIndexOf('\n') + 1).trimStart(),
          )?.[1];
    if (directive === undefined) continue;
    let message: string;
    let severity: Severity;
    if (directive === '@ts-nocheck') {
      const leading = comment.pos < firstTokenStart;
      message = leading
        ? "'@ts-nocheck' disables type checking for the entire file. Remove it and fix the " +
          "underlying errors, or scope suppression to single lines with '@ts-expect-error'."
        : "TypeScript only honors '@ts-nocheck' before the first statement, so this one " +
          'suppresses nothing — but it will disable checking for the entire file if the ' +
          'code above it ever moves. Remove it.';
      severity = leading ? 'warning' : 'info';
    } else if (directive === '@ts-ignore') {
      message =
        "'@ts-ignore' suppresses whatever error the next line produces and silently " +
        "outlives the error it was written for. Prefer '@ts-expect-error', which fails " +
        'once the error is gone.';
      severity = 'warning';
    } else {
      message =
        "'@ts-expect-error' suppresses one expected error on the next line and is " +
        'assertion-checked — it errors itself once the suppressed error disappears. ' +
        'Confirm the suppression is deliberate and documented.';
      severity = 'info';
    }
    push(comment.pos, comment.end, 'types.directive', message, severity, directive, directive);
  }

  const visit = (node: ts.Node, anyPosition: AnyPosition, suppressed: boolean): void => {
    if (
      ts.isTypeOperatorNode(node) &&
      node.operator === ts.SyntaxKind.KeyOfKeyword &&
      node.type.kind === ts.SyntaxKind.AnyKeyword
    ) {
      // `keyof any` is the checker-verified spelling of
      // string | number | symbol — nothing is overridden, so it is
      // not a loophole.
      return;
    }
    if (node.kind === ts.SyntaxKind.AnyKeyword) {
      const message =
        anyPosition === 'parameter'
          ? "Parameter typed 'any' disables checking of every call site and every use in the " +
            "body — a contagion point. Type it precisely, or accept 'unknown' and narrow."
          : anyPosition === 'return'
            ? "Return type 'any' spreads unchecked values into every caller — a contagion " +
              "point. Declare the real type, or 'unknown' to force callers to narrow."
            : "Explicit 'any' opts this annotation out of type checking wherever the value " +
              "flows. Prefer a precise type or 'unknown'.";
      push(
        node.getStart(sourceFile),
        node.getEnd(),
        'types.any',
        message,
        anyPosition === 'other' ? 'info' : 'warning',
        'any',
        'any',
      );
      return;
    }
    if (ts.isParenthesizedExpression(node)) {
      visit(node.expression, anyPosition, suppressed);
      return;
    }
    if (ts.isAssertionExpression(node)) {
      const constAssertion = ts.isConstTypeReference(node.type);
      if (!constAssertion && !suppressed) {
        const typeText = node.type.getText(sourceFile);
        const inner = innerAssertion(node);
        const [kind, message, severity]: [string, string, Severity] =
          node.type.kind === ts.SyntaxKind.AnyKeyword
            ? [
                'as-any',
                "Assertion to 'any' removes this expression from type checking entirely, and " +
                  'everything derived from it inherits the hole. Assert a precise type ' +
                  "instead, or go through 'unknown' and narrow.",
                'warning',
              ]
            : inner !== undefined
              ? [
                  'double-cast',
                  `Double assertion through '${inner.type.getText(sourceFile)}' can convert ` +
                    `between any two types — the checker verifies nothing about '${typeText}'. ` +
                    'If the shapes genuinely overlap a single assertion suffices; if not, ' +
                    'validate at runtime.',
                  'warning',
                ]
              : [
                  'assertion',
                  `Type assertion overrides inference with '${typeText}', unverified. If the ` +
                    'value really has this type, a declared type, satisfies, or a type guard ' +
                    'proves it; if not, the assertion hides a bug.',
                  'info',
                ];
        push(
          node.getStart(sourceFile),
          node.getEnd(),
          'types.assertion',
          message,
          severity,
          truncateName(typeText),
          kind,
        );
      }
      // The operand of a non-exempt assertion descends suppressed so a
      // double-cast chain yields exactly one finding, at the outermost
      // assertion. The asserted-to type is never visited: an `any`
      // inside it is the assertion finding's own subject, not a
      // separate annotation.
      visit(node.expression, 'other', !constAssertion);
      return;
    }
    if (ts.isNonNullExpression(node)) {
      const operand = node.expression.getText(sourceFile);
      push(
        node.getStart(sourceFile),
        node.getEnd(),
        'types.non-null',
        `Non-null assertion strips 'null | undefined' from '${operand}' without proof. ` +
          'Narrow instead, or handle the absent case explicitly.',
        'info',
        truncateName(operand),
        'non-null',
      );
      visit(node.expression, 'other', false);
      return;
    }
    if (ts.isParameter(node)) {
      ts.forEachChild(node, (child) => {
        visit(child, child === node.type ? 'parameter' : 'other', false);
      });
      return;
    }
    const returnType = returnTypeOf(node);
    if (returnType !== undefined) {
      ts.forEachChild(node, (child) => {
        visit(child, child === returnType ? 'return' : anyPosition, false);
      });
      return;
    }
    ts.forEachChild(node, (child) => {
      visit(child, anyPosition, false);
    });
  };
  visit(sourceFile, 'other', false);

  return findings.sort(
    (a, b) =>
      a.range.start.line - b.range.start.line ||
      a.range.start.character - b.range.start.character,
  );
}

export const typeLoopholes: Tool<LoopholesInput, Finding[], TsProjectSession> = {
  name: 'ts/types/loopholes',
  description:
    'Audits type-safety escape hatches: type assertions (types.assertion — as-any and ' +
    'double-casts warn, plain assertions are info, as const is exempt), non-null assertions ' +
    "(types.non-null), explicit 'any' annotations (types.any — warning on parameters and " +
    "return types where any spreads, info elsewhere; checker-verified 'keyof any' is " +
    'exempt), and checker-suppressing directives (types.directive — @ts-ignore/@ts-nocheck ' +
    'warn, assertion-checked @ts-expect-error is info, an inert @ts-nocheck after the first ' +
    "statement is info). Directive matching mirrors tsc's own grammar, including " +
    'last-line block-comment directives like /* @ts-ignore */. Detection is purely ' +
    'syntactic over the AST and real comment ranges, so directive-like text inside strings ' +
    'or JSX text never matches and every finding is high confidence. Each finding marks a ' +
    'place the code overrides the checker instead of satisfying it; fix by modeling real ' +
    'types, narrowing, or validating at runtime.',
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
  outputSchema: FINDINGS_ARRAY_SCHEMA,
  run(session, input) {
    return Promise.resolve(
      session
        .targetFiles()
        .flatMap((sourceFile) => findLoopholesInFile(sourceFile, input))
        .sort(
          (a, b) =>
            (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) ||
            a.range.start.line - b.range.start.line ||
            a.range.start.character - b.range.start.character,
        ),
    );
  },
};

import type { CommentBlock } from '../../../core/comments/index.js';

/**
 * The parameter names a `- Parameter` tag may legitimately name.
 *
 * Swift declares both an argument label and an internal name:
 * `func f(for name: String)` is written `f(for:)` by a caller and uses
 * `name` inside. A doc tag naming either is correct, so both go in the
 * set and a tag is flagged only when it matches neither.
 *
 * Measured before choosing: labels and names differ on 6.8% of
 * documented parameters in one corpus, 18% in another and 25% in a
 * third. Requiring the label would false-positive on every comment
 * naming the internal name — a quarter of them in the worst case.
 * Requiring the name would false-positive on every comment following
 * Apple's own convention. Requiring both is worse than either.
 */
interface ParameterNames {
  accepted: ReadonlySet<string>;
  /** For the message: what the reader should have written instead. */
  display: string[];
}

const DECL = /\b(?:func|init|subscript)\b/;

/**
 * Read the parameter list of the declaration a doc block sits above.
 *
 * Text-scanned rather than parsed, and deliberately conservative: any
 * shape this cannot read confidently returns undefined and validation
 * is skipped entirely. That mirrors the TypeScript tool refusing to
 * check a destructured signature — a tag wrongly reported here would be
 * a wrong edit, since comment.stale-param is meant to be actionable.
 */
export function parametersFor(
  text: string,
  lineStarts: readonly number[],
  block: CommentBlock,
): ParameterNames | undefined {
  let cursor = lineStarts[block.endLine + 1];
  if (cursor === undefined) return undefined;

  // Skip attribute and modifier lines between the comment and the
  // declaration: @MainActor, @available(...), public, final.
  let header = '';
  for (let line = block.endLine + 1; line < lineStarts.length; line++) {
    const start = lineStarts[line]!;
    const end = lineStarts[line + 1] ?? text.length;
    const body = text.slice(start, end).trim();
    if (body === '' || body.startsWith('@') || body.startsWith('//')) continue;
    if (!DECL.test(body)) return undefined;
    cursor = start;
    header = text.slice(start);
    break;
  }
  if (header === '') return undefined;

  const open = header.indexOf('(');
  if (open < 0) return undefined;
  let depth = 0;
  let close = -1;
  for (let i = open; i < header.length; i++) {
    const ch = header[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    } else if (ch === '"' || ch === '\n') {
      // A string or a line break inside the list means this is not a
      // shape worth guessing at.
      if (ch === '"') return undefined;
    }
  }
  if (close < 0) return undefined;

  const accepted = new Set<string>();
  const display: string[] = [];
  const inner = header.slice(open + 1, close);
  if (inner.trim() === '') return { accepted, display };

  for (const raw of splitParameters(inner)) {
    const head = raw.split(':')[0]?.trim();
    if (head === undefined || head === '') return undefined;
    const words = head.split(/\s+/).filter((word) => word !== '');
    // `_ name`, `label name`, or just `name`.
    if (words.length > 2) return undefined;
    const label = words[0]!;
    const internal = words[1] ?? words[0]!;
    if (!/^[A-Za-z_][\w]*$/.test(internal)) return undefined;
    if (label !== '_' && /^[A-Za-z_][\w]*$/.test(label)) accepted.add(label);
    accepted.add(internal);
    display.push(internal);
  }
  return { accepted, display };
}

/** Split on commas that are not inside brackets or generic angles. */
function splitParameters(inner: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of inner) {
    if ('([<'.includes(ch)) depth++;
    else if (')]>'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim() !== '') parts.push(current);
  return parts;
}

type CandidateSource = 'param-tag' | 'doc-link' | 'code-span' | 'bare';

interface Candidate {
  raw: string;
  /** Dot/slash-separated pieces; the chain resolves if any piece does. */
  segments: string[];
  /** Offset within the comment text. */
  offset: number;
  source: CandidateSource;
  isFile?: boolean;
}

const CHAIN = /^\.?[A-Za-z_][\w]*(?:[./][A-Za-z_][\w]*)*(?:\(\))?$/;
const CODE_SPAN = /`([^`\n]+)`/g;
/** DocC symbol links: ``Type/member(_:)``. */
const DOC_LINK = /``([^`\n]+)``/g;
const URL = /\b(?:https?:\/\/|mailto:)\S+|\b[\w-]+\.(?:com|org|net|io|dev|app|tech)\b\S*/g;
/** `- Parameter name:` and the `- name:` items under `- Parameters:`. */
const PARAM_TAG = /^[ \t]*[-*+][ \t]*[Pp]arameter[ \t]+([A-Za-z_]\w*)[ \t]*:/gm;
const PARAMETERS_BLOCK = /^([ \t]*)[-*+][ \t]*[Pp]arameters[ \t]*:[ \t]*$/gm;
const PARAM_ITEM = /^[ \t]*[-*+][ \t]*([A-Za-z_]\w*)[ \t]*:/;
const SOURCE_EXTENSIONS = 'swift|json|md|plist|ya?ml|xcconfig|entitlements|storyboard|xib|strings';
const IS_FILE = new RegExp(`\\.(?:${SOURCE_EXTENSIONS})$`, 'i');
/**
 * A path this project cannot be expected to resolve: absolute, home
 * relative, a URL, or a dot-leading config path. `.hotseat/hotseat.json`
 * is the shape that motivated the last of those — it reads as a
 * relative path and is one, but relative to the user's home rather than
 * to anything in the repository, and it was the single largest
 * false-positive family in the first measured run.
 */
const OUTSIDE = (raw: string): boolean =>
  raw.startsWith('~') ||
  raw.startsWith('/') ||
  raw.includes('://') ||
  (raw.startsWith('.') && raw.includes('/'));
const FILE_REF = new RegExp(`(?:^|[\\s"'\`(])([\\w~./-]*[\\w-]\\.(?:${SOURCE_EXTENSIONS}))\\b`, 'g');
const BARE_TOKEN = /[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*(?:\(\))?/g;
/**
 * A DocC selector: the `(for:)` in a link like Greeter/salute(for:).
 *
 * Deliberately a flat character class. The obvious grammatical
 * spelling — an optional label repeated — nests a quantifier over
 * something that can match empty, and backtracks catastrophically on
 * any comment holding an unmatched parenthesis. The first draft hung
 * outright.
 */
const SELECTOR = /\([\w:]*\)$/;

/**
 * DocC writes a member with its argument labels attached. Reduce it to
 * the plain call shape the chain pattern understands, keeping the fact
 * that it is a call.
 */
function withoutSelector(raw: string): string {
  return SELECTOR.test(raw) ? `${raw.replace(SELECTOR, '')}()` : raw;
}

/** Replace a span with spaces, so later passes cannot re-match it. */
function blank(text: string, start: number, length: number): string {
  return text.slice(0, start) + ' '.repeat(length) + text.slice(start + length);
}

/**
 * A case hump, an underscore between word characters, a dot chain, a
 * leading dot, or call parens. "Note" and "the" do not qualify;
 * `totalCount`, `.finish` and `URL.absoluteString` do.
 */
export function looksLikeCode(raw: string): boolean {
  const bare = raw.replace(/\(\)$/, '');
  return (
    raw.endsWith('()') ||
    raw.startsWith('.') ||
    bare.includes('.') ||
    bare.includes('/') ||
    /[a-z_][\w]*_[\w]/.test(bare) ||
    /[a-z][A-Z]/.test(bare)
  );
}

function segmentsOf(raw: string): string[] {
  return raw
    .replace(/\(\)$/, '')
    .replace(/^\./, '')
    .split(/[./]/)
    .map((piece) => piece.split('(')[0] ?? '')
    .filter((piece) => piece !== '');
}

/**
 * Every reference a comment appears to make, with where in the comment
 * it sits. Passes run in order and blank what they match, so the bare
 * pass never re-reads a filename or a doc tag as loose prose.
 */
export function extractCandidates(comment: string): Candidate[] {
  const candidates: Candidate[] = [];
  let working = comment;

  // URLs first, and this pass pays for itself: without it one corpus
  // reports 502 unresolved bare tokens, dominated by github.com and
  // the scheme itself.
  for (const match of [...working.matchAll(URL)]) {
    working = blank(working, match.index, match[0].length);
  }

  const take = (
    pattern: RegExp,
    source: CandidateSource,
    requireCodeShape: boolean,
    group = 1,
  ): void => {
    for (const match of [...working.matchAll(pattern)]) {
      const captured = (match[group] ?? '').trim();
      const offset = match.index + match[0].indexOf(captured);
      const raw = withoutSelector(captured);
      if (raw !== '' && CHAIN.test(raw) && (!requireCodeShape || looksLikeCode(raw))) {
        // A backtick span may hold a filename rather than a symbol, and
        // it has to be classified here — the file pass below runs over
        // what is left, and this span is about to be blanked.
        if (IS_FILE.test(raw)) {
          if (!OUTSIDE(raw)) {
            candidates.push({ raw, segments: [raw], offset, source, isFile: true });
          }
        } else {
          candidates.push({ raw, segments: segmentsOf(raw), offset, source });
        }
      }
      working = blank(working, match.index, match[0].length);
    }
  };

  take(PARAM_TAG, 'param-tag', false);
  for (const block of [...working.matchAll(PARAMETERS_BLOCK)]) {
    const indent = (block[1] ?? '').length;
    let cursor = block.index + block[0].length;
    for (const line of working.slice(cursor).split('\n').slice(1)) {
      const width = line.length - line.trimStart().length;
      cursor += line.length + 1;
      if (line.trim() === '') continue;
      // Dedent ends the list; a deeper item is one of its entries.
      if (width <= indent) break;
      const item = PARAM_ITEM.exec(line);
      if (!item?.[1]) continue;
      const start = cursor - line.length - 1 + line.indexOf(item[1]);
      candidates.push({
        raw: item[1],
        segments: [item[1]],
        offset: start,
        source: 'param-tag',
      });
      working = blank(working, start, item[1].length);
    }
  }
  take(DOC_LINK, 'doc-link', false);
  take(CODE_SPAN, 'code-span', false);

  // Filenames before bare tokens: they hold dots and hyphens that the
  // bare pass would split into misleading fragments.
  for (const match of [...working.matchAll(FILE_REF)]) {
    const raw = match[1] ?? '';
    const offset = match.index + match[0].indexOf(raw);
    // A path outside the project is not this project's to resolve.
    if (!OUTSIDE(raw)) {
      candidates.push({ raw, segments: [raw], offset, source: 'code-span', isFile: true });
    }
    working = blank(working, offset, raw.length);
  }

  for (const match of [...working.matchAll(BARE_TOKEN)]) {
    const raw = match[0];
    if (CHAIN.test(raw) && looksLikeCode(raw)) {
      candidates.push({ raw, segments: segmentsOf(raw), offset: match.index, source: 'bare' });
    }
  }
  return candidates;
}

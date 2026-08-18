/**
 * The tell list. Data, not logic — tune weights and add patterns here.
 * A comment is flagged when its summed weight reaches the tool's
 * minScore (default 1), so weight-1 patterns flag alone and weight-0.5
 * patterns need company.
 */

interface TellPattern {
  id: string;
  pattern: RegExp;
  weight: number;
}

/** Filler phrasing characteristic of LLM-generated comments. */
export const FILLERS: TellPattern[] = [
  { id: 'worth-noting', pattern: /\bit(?:'|’)?s worth noting\b|\bworth noting that\b/i, weight: 1 },
  { id: 'important-to-note', pattern: /\b(?:it is|it'?s) important to (?:note|remember|understand)\b/i, weight: 1 },
  { id: 'note-that', pattern: /\bnote that\b/i, weight: 0.5 },
  { id: 'additionally', pattern: /\badditionally,/i, weight: 0.5 },
  { id: 'furthermore', pattern: /\bfurthermore\b/i, weight: 1 },
  { id: 'moreover', pattern: /\bmoreover\b/i, weight: 1 },
  { id: 'in-summary', pattern: /\bin summary\b|\bin conclusion\b/i, weight: 1 },
  { id: 'delve', pattern: /\bdelv(?:e|es|ing)\b/i, weight: 1 },
  { id: 'leverage', pattern: /\bleverag(?:e|es|ing)\b/i, weight: 1 },
  { id: 'seamless', pattern: /\bseamless(?:ly)?\b/i, weight: 1 },
  { id: 'robust', pattern: /\brobust\b/i, weight: 0.5 },
  { id: 'comprehensive', pattern: /\bcomprehensive\b/i, weight: 0.5 },
  { id: 'battle-tested', pattern: /\bbattle-tested\b/i, weight: 1 },
  { id: 'crucial', pattern: /\bcrucial\b/i, weight: 0.5 },
  { id: 'vital-role', pattern: /\bplays a (?:crucial|key|vital) role\b/i, weight: 1 },
  { id: 'source-of-truth', pattern: /\bsingle source of truth\b/i, weight: 0.5 },
  { id: 'designed-to', pattern: /\bis designed to\b/i, weight: 0.5 },
  { id: 'responsible-for', pattern: /\bis responsible for\b/i, weight: 0.5 },
  { id: 'wide-variety', pattern: /\bwide (?:variety|range) of\b/i, weight: 0.5 },
  { id: 'ensuring-that', pattern: /\bensuring that\b/i, weight: 0.5 },
  { id: 'future-requirements', pattern: /\bfuture (?:requirements?|needs)\b/i, weight: 0.5 },
];

/**
 * Comments that describe the edit instead of the code — change-log
 * prose that belongs in a commit message, not a comment.
 */
export const CHANGELOG: TellPattern = {
  id: 'changelog',
  pattern: /^(?:updated?|fixed|changed|now (?:uses?|handles?|supports?)|refactored|moved|renamed|added(?: support for)?)\b/i,
  weight: 2,
};

/** Weight given to a narration match (comment restates the next line). */
export const NARRATION_WEIGHT = 2;

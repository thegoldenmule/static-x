import { supportsFileScope } from '../files/index.js';
import type { Confidence, ProjectConfig, ToolConfig } from '../config/index.js';
import type { Severity, ToolRegistry } from '../tool/index.js';

/**
 * A check suite is the answer to "which tools gate this event, and how
 * hard" — the thing that has to be checked into the repo for a hook to
 * be worth installing. It lives in static-x.json beside the thresholds
 * the same tools already read, because splitting selection into shell
 * environment variables and tuning into a config file means neither
 * half tells you what the gate actually does.
 *
 *   {
 *     "checks": {
 *       "commit": {
 *         "novelty": "changed-lines",
 *         "tools": {
 *           "ts/async/floating-promises": "block",
 *           "ts/comments/long": "warn"
 *         }
 *       }
 *     }
 *   }
 *
 * A suite named in config replaces the default of that name outright
 * rather than merging into it; suites left unmentioned keep theirs.
 * Merging would make a default tool impossible to remove except by
 * naming it "off", which reads as a statement about the tool rather
 * than about the suite.
 */

/** What a tool's findings do to the gate. */
export type CheckLevel = 'block' | 'warn' | 'off';

/**
 * Which findings the gate is allowed to complain about — the filter
 * that decides whether a hook is installable on an existing codebase.
 * Without one, a scoped run reports everything the touched files
 * already had, and the first commit is blocked over code its author
 * never wrote.
 */
export type Novelty =
  /** Only findings overlapping lines this change added or edited. */
  | 'changed-lines'
  /** Every finding in a changed file, however old. */
  | 'changed-file'
  /** Everything absent from the recorded baseline. */
  | 'baseline'
  /** Everything the tools report. */
  | 'none';

/**
 * How one tool participates in one suite. The long form carries the
 * `static-x.json` tuning keys, applied on top of whatever the project
 * already sets for that tool, so a gate can be stricter than the tool's
 * everyday settings without editing them: `ts/types/loopholes` at
 * `minSeverity: "warning"` selects `as any`, double casts, and
 * suppression directives while leaving the 326 plain assertions in this
 * repository unreported. Without that, a suite shipped with sensible
 * defaults would be unusable in any project that has no config file.
 */
export interface CheckEntry {
  level: CheckLevel;
  config?: ToolConfig;
}

export interface CheckSuite {
  novelty: Novelty;
  /** Tool name to entry. Tools absent from the map do not run. */
  tools: Record<string, CheckEntry>;
}

const LEVELS = new Set<string>(['block', 'warn', 'off']);
const NOVELTIES = new Set<string>(['changed-lines', 'changed-file', 'baseline', 'none']);
const SEVERITIES = new Set<string>(['error', 'warning', 'info']);
const CONFIDENCES = new Set<string>(['low', 'medium', 'high']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The `checks` block as written, before validation. */
export function checksBlock(config: ProjectConfig | undefined): Record<string, unknown> {
  const block = config?.['checks'];
  return isRecord(block) ? block : {};
}

/**
 * Every suite name available for this project — the configured ones
 * plus the defaults they don't override.
 */
export function suiteNames(
  config: ProjectConfig | undefined,
  defaults: Readonly<Record<string, CheckSuite>>,
): string[] {
  return [...new Set([...Object.keys(defaults), ...Object.keys(checksBlock(config))])].sort();
}

/**
 * Validates one suite, resolving it against the defaults. Rejects a
 * refactoring outright: the ferry cannot scope one to a file list —
 * a partial list would mean a partial refactor — so a refactoring in a
 * suite would fail at the first hook run rather than here, where the
 * error can say why.
 */
export function resolveSuite(
  name: string,
  config: ProjectConfig | undefined,
  defaults: Readonly<Record<string, CheckSuite>>,
  registry: ToolRegistry,
): CheckSuite {
  const configured = checksBlock(config)[name];
  const known = suiteNames(config, defaults);
  if (configured === undefined) {
    const fallback = defaults[name];
    if (!fallback) {
      throw new Error(`Unknown check suite "${name}". Available: ${known.join(', ')}`);
    }
    return fallback;
  }
  if (!isRecord(configured)) {
    throw new Error(`checks.${name} must be an object with "novelty" and "tools"`);
  }

  const novelty = configured['novelty'] ?? 'none';
  if (typeof novelty !== 'string' || !NOVELTIES.has(novelty)) {
    throw new Error(
      `checks.${name}.novelty must be one of ${[...NOVELTIES].join(', ')} (got ${JSON.stringify(novelty)})`,
    );
  }

  const rawTools = configured['tools'];
  if (!isRecord(rawTools)) {
    throw new Error(`checks.${name}.tools must be an object mapping tool names to levels`);
  }

  const tools: Record<string, CheckEntry> = {};
  for (const [tool, raw] of Object.entries(rawTools)) {
    const where = `checks.${name}.tools["${tool}"]`;
    const entry = parseEntry(raw, where);
    if (!registry.has(tool)) {
      throw new Error(
        `checks.${name}.tools names an unknown tool "${tool}". Registered: ${registry.names().join(', ')}`,
      );
    }
    if (!supportsFileScope(registry.get(tool))) {
      throw new Error(
        `checks.${name}.tools names "${tool}", which is a refactoring rather than an analysis ` +
          'tool: it rewrites code and cannot be scoped to a changed-file list, so it cannot ' +
          'gate an event. Suites hold tools that return findings.',
      );
    }
    tools[tool] = entry;
  }
  return { novelty: novelty as Novelty, tools };
}

/** `"block"`, or `{ "level": "block", "minSeverity": "warning" }`. */
function parseEntry(raw: unknown, where: string): CheckEntry {
  if (typeof raw === 'string') {
    if (!LEVELS.has(raw)) {
      throw new Error(`${where} must be one of ${[...LEVELS].join(', ')} (got ${JSON.stringify(raw)})`);
    }
    return { level: raw as CheckLevel };
  }
  if (!isRecord(raw)) {
    throw new Error(`${where} must be a level string or an object with a "level"`);
  }

  const level = raw['level'];
  if (typeof level !== 'string' || !LEVELS.has(level)) {
    throw new Error(`${where}.level must be one of ${[...LEVELS].join(', ')} (got ${JSON.stringify(level)})`);
  }

  const config: ToolConfig = {};
  const { ignore, minSeverity, minConfidence, input } = raw;
  if (ignore !== undefined) {
    if (!Array.isArray(ignore) || ignore.some((name) => typeof name !== 'string')) {
      throw new Error(`${where}.ignore must be an array of strings`);
    }
    config.ignore = ignore as string[];
  }
  if (minSeverity !== undefined) {
    if (typeof minSeverity !== 'string' || !SEVERITIES.has(minSeverity)) {
      throw new Error(`${where}.minSeverity must be one of ${[...SEVERITIES].join(', ')}`);
    }
    config.minSeverity = minSeverity as Severity;
  }
  if (minConfidence !== undefined) {
    if (typeof minConfidence !== 'string' || !CONFIDENCES.has(minConfidence)) {
      throw new Error(`${where}.minConfidence must be one of ${[...CONFIDENCES].join(', ')}`);
    }
    config.minConfidence = minConfidence as Confidence;
  }
  if (input !== undefined) {
    if (!isRecord(input)) throw new Error(`${where}.input must be an object`);
    config.input = input;
  }
  return Object.keys(config).length > 0 ? { level: level as CheckLevel, config } : { level: level as CheckLevel };
}

/** The tools a suite actually runs, in registry order. */
export function activeTools(suite: CheckSuite): { name: string; entry: CheckEntry }[] {
  return Object.entries(suite.tools)
    .filter(([, entry]) => entry.level !== 'off')
    .map(([name, entry]) => ({ name, entry }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

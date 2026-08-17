#!/usr/bin/env node
// A worked example, not something `static-x install` writes: a Claude
// Code PostToolUse gate that blocks a .ts/.tsx edit leaving an over-long
// or LLM-tell comment on a line this working tree changed.
//
// It exists because `check <suite>` cannot serve one hook registered in
// user settings across every project. Suite levels live in the analyzed
// project's static-x.json, so a global command would run whatever each
// repo happens to say — and against a monorepo root, nothing at all.
// Two roots instead: findings from the nearest tsconfig.json (the unit a
// session can load), policy from static-x.json in CLAUDE_PROJECT_DIR, so
// one repo root configures one gate however many packages it holds.
//
// .mts because a copy of this in ~/.claude/hooks has no package.json to
// make it ESM, and `node` runs it there with no loader and no build.

import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** Set to a checkout's cli/sx.mjs to run without a global install. */
const BIN = process.env['STATIC_X_BIN'] ?? 'static-x';
const TIMEOUT_MS = 45_000;
const SUITE = 'claude-comments';
const TOOLS = ['ts/comments/long', 'ts/comments/llm-tells'] as const;

type Level = 'block' | 'warn' | 'off';
type Novelty = 'changed-lines' | 'changed-file' | 'baseline' | 'none';
type Severity = 'info' | 'warning' | 'error';
type Confidence = 'low' | 'medium' | 'high';

const LEVELS = new Set<string>(['block', 'warn', 'off']);
const NOVELTIES = new Set<string>(['changed-lines', 'changed-file', 'baseline', 'none']);
const SEVERITIES = new Set<string>(['info', 'warning', 'error']);
const CONFIDENCES = new Set<string>(['low', 'medium', 'high']);
const SEVERITY_RANK: Record<Severity, number> = { info: 0, warning: 1, error: 2 };
const CONFIDENCE_RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

interface ToolConfig {
  ignore?: string[];
  minSeverity?: Severity;
  minConfidence?: Confidence;
  input?: Record<string, unknown>;
}

interface Plan {
  novelty: Novelty;
  tools: { name: string; level: Exclude<Level, 'off'>; config: ToolConfig }[];
}

interface Finding {
  file: string;
  range: { start: { line: number }; end: { line: number } };
  code: string;
  message: string;
  severity: Severity;
  data?: { name?: unknown; confidence?: unknown };
}

interface Event {
  cwd?: string;
  tool_input?: { file_path?: string };
}

const DEFAULT_PLAN: Plan = {
  novelty: 'changed-lines',
  tools: TOOLS.map((name) => ({ name, level: 'block' as const, config: {} })),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Exit without blocking, optionally telling the user why. */
function ok(notice?: string): never {
  if (notice !== undefined) {
    process.stdout.write(JSON.stringify({ systemMessage: `ts_comments: ${notice}` }));
  }
  process.exit(0);
}

function readStdin(): Promise<string> {
  process.stdin.setEncoding('utf8');
  return new Promise((resolve) => {
    let text = '';
    process.stdin.on('data', (chunk) => (text += chunk as string));
    process.stdin.on('end', () => resolve(text));
    process.stdin.on('error', () => resolve(''));
  });
}

/** Nearest ancestor holding a tsconfig.json — the unit static-x can load. */
function projectRoot(file: string): string | undefined {
  let dir = path.dirname(file);
  for (;;) {
    if (existsSync(path.join(dir, 'tsconfig.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** A ToolConfig as static-x spells it, from wherever it was written. */
function toolConfig(raw: unknown, where: string): ToolConfig {
  if (!isRecord(raw)) return {};
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
  return config;
}

/** Suite tuning layered over the tool's everyday settings. */
function overlay(base: ToolConfig, over: ToolConfig): ToolConfig {
  const merged: ToolConfig = {};
  const ignore = [...(base.ignore ?? []), ...(over.ignore ?? [])];
  if (ignore.length > 0) merged.ignore = ignore;
  const severity = over.minSeverity ?? base.minSeverity;
  if (severity !== undefined) merged.minSeverity = severity;
  const confidence = over.minConfidence ?? base.minConfidence;
  if (confidence !== undefined) merged.minConfidence = confidence;
  if (base.input !== undefined || over.input !== undefined) {
    merged.input = { ...base.input, ...over.input };
  }
  return merged;
}

/** `"block"` or `{ "level": "block", "input": { ... } }`. */
function entry(raw: unknown, where: string): { level: Level; config: ToolConfig } {
  if (typeof raw === 'string') {
    if (!LEVELS.has(raw)) {
      throw new Error(`${where} must be one of ${[...LEVELS].join(', ')} (got ${raw})`);
    }
    return { level: raw as Level, config: {} };
  }
  if (!isRecord(raw)) throw new Error(`${where} must be a level string or an object`);
  const level = raw['level'];
  if (typeof level !== 'string' || !LEVELS.has(level)) {
    throw new Error(`${where}.level must be one of ${[...LEVELS].join(', ')}`);
  }
  return { level: level as Level, config: toolConfig(raw, where) };
}

/**
 * The gate this project asked for. `checks.claude-comments` in
 * static-x.json names the levels and the novelty; `ts.comments.*` under
 * the same file supplies the thresholds those tools read everywhere.
 * Absent either one, both tools block on what the change added.
 */
function plan(configDir: string | undefined): Plan {
  if (configDir === undefined) return DEFAULT_PLAN;
  const file = path.join(configDir, 'static-x.json');
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return DEFAULT_PLAN;
    throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(raw)) throw new Error(`${file}: top level must be a JSON object`);

  const comments = isRecord(raw['ts']) && isRecord(raw['ts']['comments']) ? raw['ts']['comments'] : {};
  const bases = new Map(
    TOOLS.map((name) => {
      const leaf = name.slice('ts/comments/'.length);
      return [name, toolConfig(comments[leaf], `ts.comments.${leaf}`)] as const;
    }),
  );

  const suite = isRecord(raw['checks']) ? raw['checks'][SUITE] : undefined;
  if (suite === undefined) {
    return {
      novelty: DEFAULT_PLAN.novelty,
      tools: TOOLS.map((name) => ({ name, level: 'block' as const, config: bases.get(name)! })),
    };
  }
  if (!isRecord(suite)) throw new Error(`checks.${SUITE} must be an object`);

  const novelty = suite['novelty'] ?? DEFAULT_PLAN.novelty;
  if (typeof novelty !== 'string' || !NOVELTIES.has(novelty)) {
    throw new Error(`checks.${SUITE}.novelty must be one of ${[...NOVELTIES].join(', ')}`);
  }
  const rawTools = suite['tools'];
  if (!isRecord(rawTools)) throw new Error(`checks.${SUITE}.tools must be an object`);
  for (const name of Object.keys(rawTools)) {
    if (!(TOOLS as readonly string[]).includes(name)) {
      throw new Error(`checks.${SUITE}.tools names "${name}"; this gate runs ${TOOLS.join(' and ')}`);
    }
  }

  const tools: Plan['tools'] = [];
  for (const name of TOOLS) {
    const raw = rawTools[name];
    // A tool the suite does not name does not run: same rule static-x
    // gives its own suites, so a two-tool gate can be a one-tool gate.
    if (raw === undefined) continue;
    const { level, config } = entry(raw, `checks.${SUITE}.tools["${name}"]`);
    if (level === 'off') continue;
    tools.push({ name, level, config: overlay(bases.get(name)!, config) });
  }
  return { novelty: novelty as Novelty, tools };
}

/** static-x exits 1 when it has findings to report, which is not a failure. */
async function findings(tool: string, config: ToolConfig, root: string, file: string) {
  const args = [tool, '--project', root, '--files', file];
  if (config.input !== undefined) args.push('--input', JSON.stringify(config.input));
  let stdout: string;
  try {
    ({ stdout } = await exec(BIN, args, {
      cwd: root,
      timeout: TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    }));
  } catch (error) {
    const failure = error as { code?: unknown; stdout?: unknown };
    if (failure.code !== 1 || typeof failure.stdout !== 'string') throw error;
    stdout = failure.stdout;
  }
  const ignored = new Set(config.ignore ?? []);
  return (JSON.parse(stdout) as Finding[]).filter((finding) => {
    const name = finding.data?.name;
    if (typeof name === 'string' && ignored.has(name)) return false;
    if (config.minSeverity && SEVERITY_RANK[finding.severity] < SEVERITY_RANK[config.minSeverity]) {
      return false;
    }
    const confidence = finding.data?.confidence;
    if (
      config.minConfidence &&
      typeof confidence === 'string' &&
      confidence in CONFIDENCE_RANK &&
      CONFIDENCE_RANK[confidence as Confidence] < CONFIDENCE_RANK[config.minConfidence]
    ) {
      return false;
    }
    return true;
  });
}

type Changes =
  /** 1-based lines this file has that HEAD does not. */
  | { kind: 'diff'; lines: Set<number> }
  /** Nothing to compare against, so every line is the change. */
  | { kind: 'new-file' }
  /** The question could not be answered; every line is suspect. */
  | { kind: 'unknown' };

const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

async function tracked(file: string, cwd: string): Promise<boolean> {
  try {
    await exec('git', ['ls-files', '--error-unmatch', '--', file], { cwd, timeout: TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

async function changedLines(file: string, cwd: string): Promise<Changes> {
  let stdout: string;
  try {
    ({ stdout } = await exec('git', ['diff', '-U0', '--no-color', 'HEAD', '--', file], {
      cwd,
      timeout: TIMEOUT_MS,
    }));
  } catch {
    return { kind: 'unknown' };
  }
  // A tracked file with no diff is answerable for nothing; an untracked
  // one has no HEAD to compare against, so all of it is the change.
  if (stdout.trim() === '') {
    return (await tracked(file, cwd)) ? { kind: 'diff', lines: new Set() } : { kind: 'new-file' };
  }
  const lines = new Set<number>();
  for (const line of stdout.split('\n')) {
    const match = HUNK.exec(line);
    if (!match) continue;
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    for (let i = 0; i < count; i++) lines.add(start + i);
  }
  return { kind: 'diff', lines };
}

function touches(finding: Finding, lines: Set<number>): boolean {
  for (let line = finding.range.start.line + 1; line <= finding.range.end.line + 1; line++) {
    if (lines.has(line)) return true;
  }
  return false;
}

function describe(finding: Finding, rel: string): string {
  return `  ${rel}:${finding.range.start.line + 1}  ${finding.code}  ${finding.message}`;
}

const ADVICE =
  'Tighten or delete the comment. Do not restate what the code says; keep what the code cannot.';

async function main(): Promise<void> {
  let event: Event;
  try {
    event = JSON.parse(await readStdin()) as Event;
  } catch {
    ok();
  }

  const file = event.tool_input?.file_path;
  if (typeof file !== 'string' || !/\.tsx?$/.test(file)) ok();

  const target = path.resolve(file);
  if (!existsSync(target)) ok();

  const root = projectRoot(target);
  if (root === undefined) ok();

  let gate: Plan;
  try {
    gate = plan(process.env['CLAUDE_PROJECT_DIR'] ?? event.cwd);
  } catch (error) {
    // Fail open rather than guess at a policy the config got wrong, and
    // say so where the user will see it: a gate that silently stopped
    // gating looks exactly like a gate that found nothing.
    ok(`gate skipped, config is invalid — ${error instanceof Error ? error.message : String(error)}`);
  }
  if (gate.tools.length === 0) ok();

  let found: { level: Level; finding: Finding }[];
  try {
    found = (
      await Promise.all(
        gate.tools.map(async (tool) =>
          (await findings(tool.name, tool.config, root, target)).map((finding) => ({
            level: tool.level,
            finding,
          })),
        ),
      )
    ).flat();
  } catch (error) {
    // Never wedge the session on this hook's own failure.
    ok(`${BIN} did not run — ${error instanceof Error ? error.message : String(error)}`);
  }

  if (found.length === 0) ok();

  // A policy the event cannot supply the inputs for degrades to the next
  // broader one and says so, rather than quietly stopping filtering.
  const degraded = gate.novelty === 'baseline';
  const changed =
    gate.novelty === 'changed-lines' ? await changedLines(target, root) : { kind: 'none' as const };
  const reported =
    changed.kind === 'diff' ? found.filter(({ finding }) => touches(finding, changed.lines)) : found;

  const blocking = reported.filter(({ level }) => level === 'block').map(({ finding }) => finding);
  const advisory = reported.filter(({ level }) => level === 'warn').map(({ finding }) => finding);
  if (blocking.length === 0 && advisory.length === 0) ok();

  const rel = path.relative(root, target) || target;
  const notes: string[] = [];
  if (degraded) notes.push(`novelty "baseline" needs a recorded baseline; judged the whole file.`);
  if (changed.kind === 'unknown') notes.push('no diff against HEAD; judged the whole file.');

  if (blocking.length === 0) {
    const lines = [
      `static-x comment findings in ${rel} (advisory):`,
      ...advisory.map((finding) => describe(finding, rel)),
      ...notes.map((note) => `ts_comments: ${note}`),
      ADVICE,
    ];
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: lines.join('\n') },
      }),
    );
    process.exit(0);
  }

  console.error(`Comment findings in ${rel} — fix these before moving on:`);
  for (const finding of blocking) console.error(describe(finding, rel));
  if (advisory.length > 0) {
    console.error('');
    console.error('Advisory — reported, not blocking:');
    for (const finding of advisory) console.error(describe(finding, rel));
  }
  for (const note of notes) {
    console.error('');
    console.error(`ts_comments: ${note}`);
  }
  console.error('');
  console.error(ADVICE);
  process.exit(2);
}

await main();

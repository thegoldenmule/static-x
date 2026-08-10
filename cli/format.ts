import path from 'node:path';
import { isFindingArray } from '../core/config/index.js';
import type { Finding, Severity } from '../core/tool/index.js';

/**
 * Text rendering of tool output, for hooks and humans: one line per
 * finding in the `file:line:column` form terminals and editors linkify,
 * then a count. Positions are 1-based here — findings carry LSP's
 * 0-based ones, but every editor and compiler prints 1-based.
 *
 * JSON stays the default and the machine contract; text is what a git
 * hook prints when it rejects a commit, or what a Claude Code hook
 * hands back to the model on stderr.
 */

export type OutputFormat = 'json' | 'text';

export function isOutputFormat(value: string): value is OutputFormat {
  return value === 'json' || value === 'text';
}

function location(finding: Finding, cwd: string): string {
  const file = path.isAbsolute(finding.file) ? path.relative(cwd, finding.file) : finding.file;
  // A file outside cwd relativizes to ../.. noise; absolute reads better.
  const shown = file.startsWith('..') ? finding.file : file;
  return `${shown}:${String(finding.range.start.line + 1)}:${String(finding.range.start.character + 1)}`;
}

function summary(findings: readonly Finding[]): string {
  const counts = new Map<Severity, number>();
  for (const finding of findings) counts.set(finding.severity, (counts.get(finding.severity) ?? 0) + 1);
  const parts = (['error', 'warning', 'info'] as const)
    .filter((severity) => counts.has(severity))
    .map((severity) => `${String(counts.get(severity))} ${severity}`);
  const files = new Set(findings.map((finding) => finding.file)).size;
  const noun = findings.length === 1 ? 'finding' : 'findings';
  const where = files === 1 ? '1 file' : `${String(files)} files`;
  return `${String(findings.length)} ${noun} (${parts.join(', ')}) in ${where}`;
}

/**
 * Lines to print for a tool result. Text output of a clean run is
 * empty — silence is what a hook wants when nothing is wrong. Results
 * that are not findings (a refactor's WorkspaceEdit) have no text form
 * and render as JSON in either format.
 */
export function formatResult(result: unknown, format: OutputFormat, cwd: string): string[] {
  if (format === 'json' || !isFindingArray(result)) {
    return [JSON.stringify(result, null, 2)];
  }
  if (result.length === 0) return [];
  return [
    ...result.map(
      (finding) =>
        `${location(finding, cwd)}  ${finding.severity}  ${finding.code}  ${finding.message}`,
    ),
    '',
    summary(result),
  ];
}

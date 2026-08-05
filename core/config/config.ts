import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Finding, Severity } from '../tool/index.js';

/**
 * Per-project configuration, read from static-x.json in the analyzed
 * project's root. The schema mirrors the tool paths:
 *
 *   {
 *     "ts": {
 *       "comments": {
 *         "stale-refs": {
 *           "ignore": ["ts_rank"],
 *           "minConfidence": "medium",
 *           "input": { "extraRoots": ["../sibling"] }
 *         }
 *       }
 *     }
 *   }
 *
 * Config is applied at the dispatch layer (the ferry), so every
 * delivery surface — CLI, MCP — honors it identically.
 */

export const CONFIG_FILENAME = 'static-x.json';

export type Confidence = 'low' | 'medium' | 'high';

export interface ToolConfig {
  /** Drop findings whose data.name matches one of these exactly. */
  ignore?: string[];
  /** Drop findings below this severity. */
  minSeverity?: Severity;
  /** Drop findings whose data.confidence is below this. */
  minConfidence?: Confidence;
  /** Default tool input; explicitly passed input fields win. */
  input?: Record<string, unknown>;
}

export type ProjectConfig = Record<string, unknown>;

export async function loadProjectConfig(rootPath: string): Promise<ProjectConfig | undefined> {
  const file = path.join(rootPath, CONFIG_FILENAME);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `Invalid JSON in ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid config in ${file}: top level must be a JSON object`);
  }
  return parsed as ProjectConfig;
}

/** Walk the config tree along the tool's path segments. */
export function toolConfigFor(
  config: ProjectConfig | undefined,
  toolName: string,
): ToolConfig | undefined {
  let node: unknown = config;
  for (const segment of toolName.split('/')) {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node !== null && typeof node === 'object' && !Array.isArray(node)
    ? (node)
    : undefined;
}

const SEVERITY_RANK: Record<Severity, number> = { info: 0, warning: 1, error: 2 };
const CONFIDENCE_RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

/** Is this tool output a finding list the filters can apply to? */
export function isFindingArray(value: unknown): value is Finding[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        item !== null &&
        typeof item === 'object' &&
        'file' in item &&
        'range' in item &&
        'code' in item &&
        'message' in item &&
        'severity' in item,
    )
  );
}

export function filterFindings(findings: Finding[], config: ToolConfig): Finding[] {
  const ignored = new Set(config.ignore ?? []);
  return findings.filter((finding) => {
    const name = finding.data?.name;
    if (typeof name === 'string' && ignored.has(name)) return false;
    if (
      config.minSeverity &&
      SEVERITY_RANK[finding.severity] < SEVERITY_RANK[config.minSeverity]
    ) {
      return false;
    }
    if (config.minConfidence) {
      const confidence = finding.data?.confidence;
      // Findings without a confidence are not subject to the filter.
      if (
        typeof confidence === 'string' &&
        confidence in CONFIDENCE_RANK &&
        CONFIDENCE_RANK[confidence as Confidence] < CONFIDENCE_RANK[config.minConfidence]
      ) {
        return false;
      }
    }
    return true;
  });
}

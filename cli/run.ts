import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { TsFerry } from '../ts/ferry/ferry.js';
import { createTsRegistry } from '../ts/registry.js';
import { formatResult, isOutputFormat } from './format.js';

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
  /** Base for the paths text output prints. Default: process.cwd(). */
  cwd?: string;
  /** Reads all of stdin, for `--files-from -`. */
  readStdin?(): Promise<string>;
}

const USAGE = [
  "Usage: static-x <tool> --project <root> [--input '<json>']",
  '                 [--files <path>]... [--files-from <file|->] [--format json|text]',
  '',
  '  --files       Report findings only in these paths (repeatable; directories included).',
  '  --files-from  Read that list from a file, or from stdin with `-`; one path per line',
  '                (NUL-separated works too, so `git diff --name-only -z` pipes straight in).',
  '  --format      json (default) or text, one `file:line:col` line per finding.',
];

/** Splits a newline- or NUL-separated path list, as hooks produce it. */
function parseFileList(text: string): string[] {
  return text
    .split(/[\n\0]/)
    .map((line) => line.replace(/\r$/, '').trim())
    .filter((line) => line !== '');
}

async function readStdin(): Promise<string> {
  process.stdin.setEncoding('utf8');
  let text = '';
  for await (const chunk of process.stdin) text += chunk as string;
  return text;
}

/**
 * `sx <tool> --project <root> [--input '<json>'] [--files <path>]...`
 *
 * Prints the tool result as JSON (or as text lines, with --format
 * text). Exit codes: 0 clean, 1 findings reported, 2 usage or execution
 * error — so a hook can block on 1 and report on 2.
 */
export async function runCli(argv: string[], io: CliIo): Promise<number> {
  let parsed: {
    positionals: string[];
    values: {
      project?: string;
      input?: string;
      files?: string[];
      'files-from'?: string;
      format?: string;
    };
  };
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        project: { type: 'string' },
        input: { type: 'string' },
        files: { type: 'string', multiple: true },
        'files-from': { type: 'string' },
        format: { type: 'string' },
      },
    });
  } catch (error) {
    io.err(String(error instanceof Error ? error.message : error));
    return 2;
  }

  const registry = createTsRegistry();
  const [toolName] = parsed.positionals;
  const project = parsed.values.project;
  if (!toolName || !project) {
    for (const line of USAGE) io.err(line);
    io.err(`Tools: ${registry.names().join(', ')}`);
    return 2;
  }

  const format = parsed.values.format ?? 'json';
  if (!isOutputFormat(format)) {
    io.err(`--format must be json or text (got ${format})`);
    return 2;
  }

  let input: Record<string, unknown> = {};
  if (parsed.values.input !== undefined) {
    let value: unknown;
    try {
      value = JSON.parse(parsed.values.input);
    } catch {
      io.err(`--input is not valid JSON: ${parsed.values.input}`);
      return 2;
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      io.err('--input must be a JSON object');
      return 2;
    }
    input = value as Record<string, unknown>;
  }

  const listSource = parsed.values['files-from'];
  if (parsed.values.files !== undefined || listSource !== undefined) {
    const fromList: string[] = [];
    if (listSource !== undefined) {
      try {
        fromList.push(
          ...parseFileList(
            listSource === '-'
              ? await (io.readStdin ?? readStdin)()
              : await readFile(listSource, 'utf8'),
          ),
        );
      } catch (error) {
        io.err(
          `--files-from ${listSource}: ${error instanceof Error ? error.message : String(error)}`,
        );
        return 2;
      }
    }
    // Explicit --files win nothing over the list; both are one scope.
    input = { ...input, files: [...(parsed.values.files ?? []), ...fromList] };
  }

  const cwd = io.cwd ?? process.cwd();
  const ferry = new TsFerry(registry);
  try {
    const result = await ferry.call(toolName, project, input);
    for (const line of formatResult(result, format, cwd)) io.out(line);
    return Array.isArray(result) && result.length > 0 ? 1 : 0;
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    return 2;
  } finally {
    await ferry.dispose();
  }
}

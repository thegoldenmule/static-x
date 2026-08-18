import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { PackRouter } from '../core/pack/index.js';
import { createPacks } from '../packs/index.js';
import { formatResult, isOutputFormat } from './format.js';
import { isHelpFlag } from './usage.js';

import type { CliIo } from './io.js';

// Re-exported so `runCli` and its io type still arrive together.
export type { CliIo };

const USAGE = [
  "Usage: static-x <tool> --project <root> [--input '<json>']",
  '                 [--files <path>]... [--files-from <file|->] [--format json|text]',
  '',
  '  --files       Report findings only in these paths (repeatable; directories included).',
  '  --files-from  Read that list from a file, or from stdin with `-`; one path per line',
  '                (NUL-separated works too, so `git diff --name-only -z` pipes straight in).',
  '  --format      json (default) or text, one `file:line:col` line per finding.',
  '',
  'Commands: check <suite>   run a suite of tools over one session (what a hook runs)',
  '          baseline        record what a suite reports now, to gate on what comes after',
  '          ratchet         tighten the gates as far as the project already allows',
  '          todo            what the baseline is hiding, as a work queue',
  '          install         write the git and Claude Code hooks, and the default suites',
];

/**
 * Subcommands, resolved lazily. `check` and `install` pull in the whole
 * suite machinery and the TypeScript defaults, which a plain tool run
 * has no use for.
 */
const COMMANDS: Record<string, (argv: string[], io: CliIo) => Promise<number>> = {
  check: async (argv, io) => (await import('./check.js')).runCheck(argv, io),
  baseline: async (argv, io) => (await import('./check.js')).runBaselineCommand(argv, io),
  ratchet: async (argv, io) => (await import('./ratchet.js')).runRatchet(argv, io),
  todo: async (argv, io) => (await import('./todo.js')).runTodo(argv, io),
  install: async (argv, io) => (await import('./install.js')).runInstall(argv, io),
  help: (argv, io) => runCli(argv.length > 0 ? [...argv, '--help'] : ['--help'], io),
};

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
  const [first, ...rest] = argv;

  // Asked-for help goes to stdout and exits 0; the same text on a usage
  // error goes to stderr and exits 2. Conflating them makes `static-x
  // --help | less` come back empty — and makes a forgotten argument look
  // like success to whatever is checking the exit code.
  if (first !== undefined && isHelpFlag(first)) {
    const registry = new PackRouter(createPacks()).registry;
    for (const line of USAGE) io.out(line);
    io.out('');
    io.out(`Tools: ${registry.names().join(', ')}`);
    return 0;
  }

  // Tool names are always path-like ("ts/comments/long"), so a bare
  // first word can only be a command — no ambiguity to resolve, and no
  // reserved word that a future tool could collide with.
  if (first !== undefined && !first.startsWith('-') && !first.includes('/')) {
    const command = COMMANDS[first];
    if (!command) {
      io.err(`Unknown command "${first}". Commands: ${Object.keys(COMMANDS).join(', ')}`);
      io.err('A tool is named path-like, e.g. `static-x ts/comments/long --project .`');
      return 2;
    }
    return command(rest, io);
  }

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

  const router = new PackRouter(createPacks());
  const registry = router.registry;
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
  const ferry = router;
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

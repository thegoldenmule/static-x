import { parseArgs } from 'node:util';
import { TsFerry } from '../ts/ferry/ferry.js';
import { createTsRegistry } from '../ts/registry.js';

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

/**
 * `sx <tool> --project <root> [--input '<json>']`
 *
 * Prints the tool result as JSON. Exit codes: 0 clean, 1 findings
 * reported, 2 usage or execution error.
 */
export async function runCli(argv: string[], io: CliIo): Promise<number> {
  let parsed: { positionals: string[]; values: { project?: string; input?: string } };
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { project: { type: 'string' }, input: { type: 'string' } },
    });
  } catch (error) {
    io.err(String(error instanceof Error ? error.message : error));
    return 2;
  }

  const registry = createTsRegistry();
  const [toolName] = parsed.positionals;
  const project = parsed.values.project;
  if (!toolName || !project) {
    io.err('Usage: sx <tool> --project <root> [--input \'<json>\']');
    io.err(`Tools: ${registry.names().join(', ')}`);
    return 2;
  }

  let input: unknown = {};
  if (parsed.values.input !== undefined) {
    try {
      input = JSON.parse(parsed.values.input);
    } catch {
      io.err(`--input is not valid JSON: ${parsed.values.input}`);
      return 2;
    }
  }

  const ferry = new TsFerry(registry);
  try {
    const result = await ferry.call(toolName, project, input);
    io.out(JSON.stringify(result, null, 2));
    return Array.isArray(result) && result.length > 0 ? 1 : 0;
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    return 2;
  } finally {
    await ferry.dispose();
  }
}

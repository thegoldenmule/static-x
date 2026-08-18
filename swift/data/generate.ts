/**
 * Regenerates apple-names.json. Run by hand, not on install:
 *
 *   npx tsx swift/data/generate.ts
 *
 * TypeScript resolves a comment's `toISOString()` by reflecting over
 * Object.getOwnPropertyNames at module load. Swift has no runtime to
 * ask, so the equivalent is generated data — the same trade
 * core/comments/tells/patterns.ts makes, and for the same reason: it is
 * data, and the place to change it is here.
 *
 * swift-symbolgraph-extract rather than the SDK's .swiftinterface
 * files, and the difference is not stylistic. The interfaces cover the
 * Swift-native modules well (7,575 names across five of them) but
 * Objective-C imported API has none at all, which left UserDefaults,
 * URLSessionDataTask, WKWebView and NSError unresolved in all three
 * corpora. symbolgraph covers clang modules with the same invocation.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** What a Swift project is overwhelmingly likely to name in a comment. */
const MODULES = [
  'Swift',
  '_Concurrency',
  'Observation',
  'Foundation',
  'Dispatch',
  'os',
  'SwiftUI',
  'Combine',
  'AppKit',
  'WebKit',
  'CoreData',
  'CoreGraphics',
  'XCTest',
];

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface SymbolGraph {
  symbols?: { names?: { title?: string }; pathComponents?: string[] }[];
}

function namesFrom(graph: SymbolGraph): string[] {
  const found: string[] = [];
  for (const symbol of graph.symbols ?? []) {
    const title = symbol.names?.title;
    // A member arrives as `move(to:from:)`; the base name is what a
    // comment writes when it names it without its labels.
    if (title) found.push(title.split('(')[0] ?? '');
    const last = symbol.pathComponents?.at(-1);
    if (last) found.push(last.split('(')[0] ?? '');
  }
  return found.filter((name) => IDENTIFIER.test(name));
}

function main(): void {
  const sdk = execFileSync('xcrun', ['--show-sdk-path'], { encoding: 'utf8' }).trim();
  const info = JSON.parse(
    execFileSync('swift', ['-print-target-info'], { encoding: 'utf8' }),
  ) as { target?: { unversionedTriple?: string } };
  const target = info.target?.unversionedTriple ?? 'arm64-apple-macosx';
  const version = execFileSync('swift', ['--version'], { encoding: 'utf8' }).split('\n')[0] ?? '';

  const names = new Set<string>();
  const included: string[] = [];
  const skipped: string[] = [];
  const dir = mkdtempSync(path.join(os.tmpdir(), 'static-x-symbolgraph-'));
  try {
    for (const module of MODULES) {
      const out = path.join(dir, module);
      // -output-dir must already exist; the tool will not create it.
      mkdirSync(out, { recursive: true });
      try {
        execFileSync(
          'xcrun',
          ['swift-symbolgraph-extract', '-module-name', module, '-target', target,
            '-sdk', sdk, '-output-dir', out, '-minimum-access-level', 'public'],
          { stdio: ['ignore', 'ignore', 'pipe'] },
        );
      } catch (error) {
        // Not every module exists on every SDK — UIKit is absent on
        // macOS, and a missing module costs recall rather than
        // correctness. But the reason is recorded: a silent skip here
        // once emptied this whole file while reporting success.
        const stderr = (error as { stderr?: Buffer }).stderr?.toString().trim() ?? '';
        skipped.push(`${module}: ${stderr.split('\n')[0] ?? 'failed'}`);
        continue;
      }
      let before = names.size;
      for (const file of readdirSync(out)) {
        if (!file.endsWith('.symbols.json')) continue;
        const graph = JSON.parse(readFileSync(path.join(out, file), 'utf8')) as SymbolGraph;
        for (const name of namesFrom(graph)) {
          names.add(name);
        }
      }
      included.push(`${module} (+${String(names.size - before)})`);
      before = names.size;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const sorted = [...names].sort();
  writeFileSync(
    path.join(import.meta.dirname, 'apple-names.json'),
    `${JSON.stringify(
      {
        generatedFrom: version,
        target,
        modules: included,
        skipped,
        count: sorted.length,
        names: sorted,
      },
      null,
      0,
    )}\n`,
    'utf8',
  );
  if (sorted.length === 0) {
    throw new Error(`No names extracted. Skipped: ${skipped.join('; ')}`);
  }
  process.stdout.write(`${String(sorted.length)} names from ${String(included.length)} modules\n`);
  process.stdout.write(`included: ${included.join(', ')}\n`);
  if (skipped.length > 0) process.stdout.write(`skipped: ${skipped.join(', ')}\n`);
}

main();

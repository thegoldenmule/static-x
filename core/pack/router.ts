import { ToolRegistry } from '../tool/index.js';
import type { CheckSuite } from '../checks/index.js';
import type { LanguagePack, PackFerry } from './types.js';

/**
 * Routes a call to the pack that owns the tool, by the first segment of
 * its name — a rule ToolRegistry's name pattern already enforces, so
 * the router never learns which languages exist.
 *
 * Ferries are built lazily, per pack, on the first call that reaches
 * one. A TypeScript-only repository must never construct a Swift ferry,
 * because constructing one is what starts a language server.
 */
export class PackRouter {
  /** Every pack's tools in one registry; names are namespaced already. */
  readonly registry: ToolRegistry;
  readonly #packs: readonly LanguagePack[];
  readonly #byId: ReadonlyMap<string, LanguagePack>;
  #ferries = new Map<string, PackFerry>();

  constructor(packs: readonly LanguagePack[]) {
    this.#packs = packs;
    const byId = new Map<string, LanguagePack>();
    for (const pack of packs) {
      if (byId.has(pack.id)) {
        throw new Error(`Two language packs claim the id "${pack.id}"`);
      }
      byId.set(pack.id, pack);
    }
    this.#byId = byId;

    this.registry = new ToolRegistry();
    for (const pack of packs) {
      for (const tool of pack.createRegistry().list()) {
        // Without this, a misnamed tool would route to no pack at all,
        // and only at the moment someone called it.
        if (tool.name.split('/')[0] !== pack.id) {
          throw new Error(
            `Tool "${tool.name}" is registered by the "${pack.id}" pack but does not start ` +
              `with "${pack.id}/", so it could not be routed back to it.`,
          );
        }
        this.registry.register(tool);
      }
    }
    assertSuitesAgree(packs);
  }

  packs(): readonly LanguagePack[] {
    return this.#packs;
  }

  packForTool(toolName: string): LanguagePack {
    const id = toolName.split('/')[0] ?? '';
    const pack = this.#byId.get(id);
    if (!pack) {
      throw new Error(`No language pack owns "${toolName}" (no pack has id "${id}")`);
    }
    return pack;
  }

  /** The packs a project at this root binds to, in pack order. */
  bindingPacks(rootPath: string): LanguagePack[] {
    return this.#packs.filter((pack) => pack.binds(rootPath));
  }

  /** Every pack's suites, same-named ones merged. */
  defaultChecks(): Readonly<Record<string, CheckSuite>> {
    const merged: Record<string, CheckSuite> = {};
    for (const pack of this.#packs) {
      for (const [name, suite] of Object.entries(pack.defaultChecks)) {
        const existing = merged[name];
        merged[name] = existing
          ? { novelty: existing.novelty, tools: { ...existing.tools, ...suite.tools } }
          : { novelty: suite.novelty, tools: { ...suite.tools } };
      }
    }
    return merged;
  }

  fixableCodes(): ReadonlySet<string> {
    return new Set(this.#packs.flatMap((pack) => [...pack.fixableCodes]));
  }

  /** Every extension any pack analyzes — "is this file worth waking us for". */
  sourceExtensions(): ReadonlySet<string> {
    return new Set(this.#packs.flatMap((pack) => [...pack.sourceExtensions]));
  }

  #ferry(pack: LanguagePack): PackFerry {
    let ferry = this.#ferries.get(pack.id);
    if (!ferry) {
      ferry = pack.createFerry(this.registry);
      this.#ferries.set(pack.id, ferry);
    }
    return ferry;
  }

  call(toolName: string, projectRoot: string, input: unknown): Promise<unknown> {
    return this.#ferry(this.packForTool(toolName)).call(toolName, projectRoot, input);
  }

  async dispose(): Promise<void> {
    const ferries = [...this.#ferries.values()];
    this.#ferries.clear();
    await Promise.all(ferries.map((ferry) => ferry.dispose()));
  }
}

/**
 * A suite name is an event — `commit` is one hook, whatever languages a
 * repository holds — so two packs naming the same suite must agree on
 * how it filters, or merging them would silently pick one.
 */
function assertSuitesAgree(packs: readonly LanguagePack[]): void {
  const novelty = new Map<string, { id: string; novelty: string }>();
  for (const pack of packs) {
    for (const [name, suite] of Object.entries(pack.defaultChecks)) {
      const seen = novelty.get(name);
      if (seen && seen.novelty !== suite.novelty) {
        throw new Error(
          `Packs disagree on the "${name}" suite's novelty policy: ` +
            `${seen.id} says "${seen.novelty}", ${pack.id} says "${suite.novelty}".`,
        );
      }
      if (!seen) novelty.set(name, { id: pack.id, novelty: suite.novelty });
    }
  }
}

import type { LanguagePack } from '../core/pack/index.js';
import { swiftPack } from '../swift/pack.js';
import { tsPack } from '../ts/pack.js';

/**
 * Every shipped language pack, and the only file that imports more than
 * one. It cannot live in core/ (that would invert the dependency) or in
 * cli/ (mcp would then import cli, a cycle this repo has already paid
 * to break once), so it is its own layer.
 */
export function createPacks(): LanguagePack[] {
  return [tsPack, swiftPack];
}

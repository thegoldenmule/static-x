import type { LanguagePack, PackFerry } from '../core/pack/index.js';
import type { ToolRegistry } from '../core/tool/index.js';
import { TS_DEFAULT_CHECKS, TS_FIXABLE_CODES } from './checks.js';
import { TsFerry } from './ferry/ferry.js';
import { bindsTypeScript, TS_SOURCE_EXTENSIONS } from './project/index.js';
import { createTsRegistry } from './registry.js';

export const tsPack: LanguagePack = {
  id: 'ts',
  label: 'TypeScript',
  sourceExtensions: TS_SOURCE_EXTENSIONS,
  projectRootHint: 'its root or any directory containing tsconfig.json',
  defaultChecks: TS_DEFAULT_CHECKS,
  fixableCodes: TS_FIXABLE_CODES,
  binds: bindsTypeScript,
  createRegistry: createTsRegistry,
  createFerry: (registry: ToolRegistry): PackFerry => new TsFerry(registry),
};

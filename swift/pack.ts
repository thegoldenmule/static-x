import type { LanguagePack, PackFerry } from '../core/pack/index.js';
import type { ToolRegistry } from '../core/tool/index.js';
import { SWIFT_DEFAULT_CHECKS, SWIFT_FIXABLE_CODES } from './checks.js';
import { SwiftFerry } from './ferry/ferry.js';
import { bindsSwift, SWIFT_SOURCE_EXTENSIONS } from './project/index.js';
import { createSwiftRegistry } from './registry.js';

export const swiftPack: LanguagePack = {
  id: 'swift',
  label: 'Swift',
  sourceExtensions: SWIFT_SOURCE_EXTENSIONS,
  projectRootHint:
    'its root — the directory holding Package.swift, buildServer.json, or the .xcodeproj',
  defaultChecks: SWIFT_DEFAULT_CHECKS,
  fixableCodes: SWIFT_FIXABLE_CODES,
  binds: bindsSwift,
  createRegistry: createSwiftRegistry,
  createFerry: (registry: ToolRegistry): PackFerry => new SwiftFerry(registry),
};

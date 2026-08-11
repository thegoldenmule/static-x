import { ToolRegistry } from '../core/tool/index.js';
import { floatingPromises } from './async/floating-promises/floating-promises.js';
import { llmTells } from './comments/llm-tells/llm-tells.js';
import { longComments } from './comments/long/long.js';
import { staleRefs } from './comments/stale-refs/stale-refs.js';
import { dupeFunctions } from './dupes/functions/functions.js';
import { importCycles } from './graph/cycles/cycles.js';
import { deadExports } from './graph/dead-exports/dead-exports.js';
import { changeSignature } from './refactors/change-signature/change-signature.js';
import { extract } from './refactors/extract/extract.js';
import { extractType } from './refactors/extract-type/extract-type.js';
import { inlineFunction } from './refactors/inline-function/inline-function.js';
import { inlineParameter } from './refactors/inline-parameter/inline-parameter.js';
import { makeReadonly } from './refactors/make-readonly/make-readonly.js';
import { moduleForm } from './refactors/module-form/module-form.js';
import { moveFile } from './refactors/move-file/move-file.js';
import { moveSymbol } from './refactors/move-symbol/move-symbol.js';
import { rename } from './refactors/rename/rename.js';
import { safeDelete } from './refactors/safe-delete/safe-delete.js';
import { typeLoopholes } from './types/loopholes/loopholes.js';

/**
 * Every shipped TypeScript tool, registered in the alphabetical order
 * the CLI and MCP listings display (the registry sorts regardless).
 */
export function createTsRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(floatingPromises);
  registry.register(llmTells);
  registry.register(longComments);
  registry.register(staleRefs);
  registry.register(dupeFunctions);
  registry.register(importCycles);
  registry.register(deadExports);
  registry.register(changeSignature);
  registry.register(extract);
  registry.register(extractType);
  registry.register(inlineFunction);
  registry.register(inlineParameter);
  registry.register(makeReadonly);
  registry.register(moduleForm);
  registry.register(moveFile);
  registry.register(moveSymbol);
  registry.register(rename);
  registry.register(safeDelete);
  registry.register(typeLoopholes);
  return registry;
}

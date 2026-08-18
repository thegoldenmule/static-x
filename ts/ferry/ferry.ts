import { Ferry } from '../../core/ferry/index.js';
import type { ToolRegistry } from '../../core/tool/index.js';
import { TsProjectSession } from '../project/index.js';

/** The shared dispatcher, bound to TypeScript sessions. */
export class TsFerry extends Ferry<TsProjectSession> {
  constructor(registry: ToolRegistry) {
    super(registry, (rootPath) => TsProjectSession.open(rootPath));
  }
}

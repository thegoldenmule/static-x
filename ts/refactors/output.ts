import type { JsonSchema, WorkspaceEdit } from '../../core/tool/index.js';

/**
 * The shape every refactoring returns, so a consumer reads one result
 * format regardless of which one it called.
 *
 * `newDiagnostics` and `warnings` divide the two ways a refactoring can
 * be wrong. A diagnostic is what the in-memory typecheck proves the
 * edit would break; non-empty means the edit was refused, always. A
 * warning is a hazard the typecheck structurally cannot see — a
 * reference through a string key, a path in package.json, a value the
 * language erases — where the edit is applied and the caller is told
 * what the compiler could not check.
 */
export interface RefactorOutput {
  applied: boolean;
  edit: WorkspaceEdit;
  /** Absolute paths the edit changes, creates, renames, or deletes. */
  filesChanged: string[];
  /** Diagnostics the edit would introduce. Non-empty blocks apply. */
  newDiagnostics: string[];
  /** Hazards outside what the typecheck can see. Does not block apply. */
  warnings: string[];
}

export const REFACTOR_OUTPUT_PROPERTIES = {
  applied: { type: 'boolean' },
  edit: { type: 'object' },
  filesChanged: { type: 'array', items: { type: 'string' } },
  newDiagnostics: { type: 'array', items: { type: 'string' } },
  warnings: { type: 'array', items: { type: 'string' } },
} as const;

export const REFACTOR_OUTPUT_REQUIRED = [
  'applied',
  'edit',
  'filesChanged',
  'newDiagnostics',
  'warnings',
];

/**
 * Build a refactor's output schema from the shared envelope. Tool-
 * specific fields that are always present belong in `required` too,
 * so a consumer can rely on them without a presence check.
 */
export function refactorOutputSchema(
  extra: Record<string, JsonSchema> = {},
  alsoRequired: readonly string[] = [],
): JsonSchema {
  return {
    type: 'object',
    properties: { ...REFACTOR_OUTPUT_PROPERTIES, ...extra },
    required: [...REFACTOR_OUTPUT_REQUIRED, ...alsoRequired],
  };
}

/** Every path a WorkspaceEdit touches, in the post-edit tree. */
export function filesTouched(edit: WorkspaceEdit): string[] {
  const files = new Set(Object.keys(edit.changes));
  for (const op of edit.fileOps ?? []) {
    if (op.kind === 'rename') {
      files.add(op.oldFile);
      files.add(op.newFile);
    } else {
      files.add(op.file);
    }
  }
  return [...files].sort();
}

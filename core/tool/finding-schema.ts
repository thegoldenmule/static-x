import type { JsonSchema } from './types.js';

/**
 * JSON Schema for the canonical Finding shape (types.ts), inlined into
 * every finding-producing tool's outputSchema. Inlining keeps each
 * tool's schema self-contained — a bare `$ref` into a shared
 * definitions block would be unresolvable for any consumer that
 * compiles the schema standalone.
 */
const POSITION_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    line: { type: 'integer', minimum: 0, description: 'Zero-based line, matching LSP' },
    character: { type: 'integer', minimum: 0, description: 'Zero-based character, matching LSP' },
  },
  required: ['line', 'character'],
  additionalProperties: false,
};

export const FINDING_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    file: { type: 'string', description: 'Absolute path of the file the finding is in' },
    range: {
      type: 'object',
      properties: { start: POSITION_SCHEMA, end: POSITION_SCHEMA },
      required: ['start', 'end'],
      additionalProperties: false,
    },
    code: { type: 'string', description: 'Machine-readable code, e.g. "comment.stale-ref"' },
    message: { type: 'string', description: 'Human/LLM-readable explanation of the finding' },
    severity: { enum: ['error', 'warning', 'info'] },
    data: { type: 'object', description: 'Tool-specific structured detail' },
  },
  required: ['file', 'range', 'code', 'message', 'severity'],
  additionalProperties: false,
};

/** The outputSchema shared by every tool that returns `Finding[]`. */
export const FINDINGS_ARRAY_SCHEMA: JsonSchema = { type: 'array', items: FINDING_SCHEMA };

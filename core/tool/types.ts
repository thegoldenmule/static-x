/**
 * Core contracts shared by every language pack and every delivery
 * adapter (CLI, MCP). Positions and edits are LSP-compatible so tool
 * output can flow to/from language servers without translation.
 */

/** Zero-based line/character, matching LSP. */
export interface Position {
  line: number;
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export type Severity = 'error' | 'warning' | 'info';

/** The canonical output shape for analysis tools. */
export interface Finding {
  /** Absolute path of the file the finding is in. */
  file: string;
  range: Range;
  /** Machine-readable code, e.g. "comment.stale-ref". */
  code: string;
  /** Human/LLM-readable explanation of the finding. */
  message: string;
  severity: Severity;
  /** Tool-specific structured detail. */
  data?: Record<string, unknown>;
}

export interface TextEdit {
  range: Range;
  newText: string;
}

/**
 * A change to the file tree itself, which text edits cannot express.
 * Mirrors LSP's CreateFile/RenameFile/DeleteFile resource operations.
 */
export type FileOperation =
  | { kind: 'create'; file: string; text?: string }
  | { kind: 'rename'; oldFile: string; newFile: string }
  | { kind: 'delete'; file: string };

/** The canonical output shape for mutating tools (LSP-compatible). */
export interface WorkspaceEdit {
  /** Map of absolute file path to edits within that file. */
  changes: Record<string, TextEdit[]>;
  /**
   * File-tree changes accompanying the text edits. Order within the
   * array is not significant: creates happen first and deletes last,
   * with text edits applied to post-rename paths in between — see
   * applyWorkspaceEdit.
   */
  fileOps?: FileOperation[];
}

/**
 * A bound connection to one project on disk. Language packs provide
 * concrete implementations (e.g. a TS session owning a language-server
 * process and a ts.Program).
 */
export interface ProjectSession {
  readonly language: string;
  readonly rootPath: string;
  dispose(): Promise<void>;
}

/** JSON Schema object; validated structurally by delivery adapters. */
export type JsonSchema = Record<string, unknown>;

export interface Tool<
  In = unknown,
  Out = unknown,
  Session extends ProjectSession = ProjectSession,
> {
  /** Fully-qualified name, e.g. "ts/comments/long". */
  name: string;
  /** Written for LLM consumption: what it checks, what findings mean. */
  description: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  run(session: Session, input: In): Promise<Out>;
}

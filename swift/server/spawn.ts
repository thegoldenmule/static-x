import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { LspClient } from '../../core/lsp/index.js';

/**
 * The token legend the pack asks for. Declared explicitly rather than
 * accepting whatever the server offers, because the decoded token types
 * are read by name and a silently reordered legend would mislabel every
 * token. sourcekit-lsp answers with its own legend regardless; the
 * client's list is what the request is gated on.
 */
const TOKEN_TYPES = [
  'namespace', 'type', 'class', 'enum', 'interface', 'struct', 'typeParameter',
  'parameter', 'variable', 'property', 'enumMember', 'event', 'function', 'method',
  'macro', 'keyword', 'modifier', 'comment', 'string', 'number', 'regexp', 'operator',
  'decorator', 'identifier',
];

const TOKEN_MODIFIERS = [
  'declaration', 'definition', 'readonly', 'static', 'deprecated', 'abstract',
  'async', 'modification', 'documentation', 'defaultLibrary',
];

/**
 * What this pack declares on top of core's blob. semanticTokens is the
 * load-bearing one: omit it and semanticTokens/full answers null, which
 * reads exactly like the request being unsupported.
 */
const SWIFT_CAPABILITIES = {
  window: { workDoneProgress: true },
  textDocument: {
    semanticTokens: {
      dynamicRegistration: false,
      requests: { full: true, range: true },
      tokenTypes: TOKEN_TYPES,
      tokenModifiers: TOKEN_MODIFIERS,
      formats: ['relative'],
    },
    documentSymbol: { hierarchicalDocumentSymbolSupport: true },
  },
};

/**
 * Where sourcekit-lsp is, in the order a project should get to decide.
 * `xcode-select` and DEVELOPER_DIR are machine-global state that a
 * repository cannot control, so a project pinned to a toolchain has to
 * be able to say so before either is consulted.
 *
 * There is no --version flag; `swift --version` is the only way to
 * record which toolchain answered, and nothing here gates on it.
 */
function findSourcekitLsp(configured?: string): string {
  if (configured) return configured;
  try {
    const found = execFileSync('xcrun', ['--find', 'sourcekit-lsp'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (found) return found;
  } catch {
    // No xcrun (Linux), or no selected Xcode. Fall through to PATH.
  }
  return 'sourcekit-lsp';
}

/**
 * Spawn the server. A scratch path keeps its build and index cache out
 * of the project's own .build, so analysing a project never races the
 * developer's open editor or leaves artifacts behind.
 */
function spawnSwiftServer(serverPath: string, scratchPath?: string): ChildProcess {
  const args = scratchPath ? ['--scratch-path', scratchPath] : [];
  return spawn(serverPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
}

interface SwiftServerOptions {
  serverPath?: string | undefined;
  scratchPath?: string | undefined;
}

export interface SwiftServer {
  client: LspClient;
  /**
   * The legend the server answered with, not the one we asked for.
   * Token types arrive as indexes into it, so decoding against our own
   * list would mislabel every token if the two ever diverge.
   */
  legend: { tokenTypes: string[]; tokenModifiers: string[] };
}

/** Spawn sourcekit-lsp and complete the handshake. */
export async function startSwiftServer(
  rootPath: string,
  options: SwiftServerOptions = {},
): Promise<SwiftServer> {
  const serverPath = findSourcekitLsp(options.serverPath);
  const client = new LspClient(spawnSwiftServer(serverPath, options.scratchPath));
  let legend: { tokenTypes: string[]; tokenModifiers: string[] };
  try {
    const result = await client.initialize(rootPath, SWIFT_CAPABILITIES);
    // Only what the shipped tools consume. Asserting a capability no
    // tool uses turns a working session into a hard failure for no
    // benefit; each assertion arrives with the tool that needs it.
    const caps = result.capabilities as Record<string, unknown>;
    const missing = ['semanticTokensProvider', 'documentSymbolProvider', 'hoverProvider'].filter(
      (name) => !caps[name],
    );
    if (missing.length > 0) {
      throw new Error(`server is missing required capabilities (${missing.join(', ')})`);
    }
    const provider = caps['semanticTokensProvider'] as
      | { legend?: { tokenTypes?: string[]; tokenModifiers?: string[] } }
      | undefined;
    legend = {
      tokenTypes: provider?.legend?.tokenTypes ?? TOKEN_TYPES,
      tokenModifiers: provider?.legend?.tokenModifiers ?? TOKEN_MODIFIERS,
    };
  } catch (error) {
    await client.shutdown();
    const stderr = client.serverStderr.trim();
    throw new Error(
      `sourcekit-lsp (${serverPath}) failed to initialize for ${rootPath}` +
        (stderr ? `\nserver stderr:\n${stderr}` : ''),
      { cause: error },
    );
  }
  return { client, legend };
}

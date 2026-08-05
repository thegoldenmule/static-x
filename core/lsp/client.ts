import type { ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from 'vscode-jsonrpc/node';
import type { InitializeResult } from 'vscode-languageserver-protocol';

/**
 * Generic LSP client over a child process speaking JSON-RPC on stdio.
 * Language packs own spawning; this owns the protocol: handshake,
 * document sync bookkeeping, request/notification ferrying, shutdown.
 */
export class LspClient {
  #child: ChildProcess;
  #connection: MessageConnection;
  /** uri -> document version, for didOpen/didChange bookkeeping. */
  #openDocuments = new Map<string, number>();
  #notificationHandlers = new Set<(method: string, params: unknown) => void>();
  #initialized = false;
  #stderr = '';

  constructor(child: ChildProcess) {
    if (!child.stdout || !child.stdin) {
      throw new Error('LspClient requires a child process with piped stdio');
    }
    this.#child = child;
    child.stderr?.on('data', (chunk: Buffer) => {
      this.#stderr += chunk.toString();
    });
    this.#connection = createMessageConnection(
      new StreamMessageReader(child.stdout),
      new StreamMessageWriter(child.stdin),
    );
    // Servers may send requests we don't handle (e.g. workspace/configuration);
    // returning null keeps the session alive instead of erroring.
    this.#connection.onRequest(() => null);
    this.#connection.onNotification((method, params) => {
      for (const handler of this.#notificationHandlers) handler(method, params);
    });
    this.#connection.listen();
  }

  /** stderr captured from the server process, for error reporting. */
  get serverStderr(): string {
    return this.#stderr;
  }

  async initialize(rootPath: string): Promise<InitializeResult> {
    const rootUri = pathToFileURL(rootPath).href;
    const result = await this.#connection.sendRequest('initialize', {
      processId: process.pid,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: 'root' }],
      capabilities: {
        textDocument: {
          hover: { contentFormat: ['markdown', 'plaintext'] },
          definition: {},
          rename: { prepareSupport: true },
          publishDiagnostics: {},
        },
        workspace: { workspaceEdit: { documentChanges: false } },
      },
    });
    await this.#connection.sendNotification('initialized', {});
    this.#initialized = true;
    return result as InitializeResult;
  }

  /** Opens a file from disk with the server. Idempotent per URI. */
  async openDocument(filePath: string, languageId: string): Promise<string> {
    const uri = pathToFileURL(filePath).href;
    if (this.#openDocuments.has(uri)) return uri;
    const text = await readFile(filePath, 'utf8');
    await this.#connection.sendNotification('textDocument/didOpen', {
      textDocument: { uri, languageId, version: 1, text },
    });
    this.#openDocuments.set(uri, 1);
    return uri;
  }

  isDocumentOpen(uri: string): boolean {
    return this.#openDocuments.has(uri);
  }

  /**
   * Resolves with the params of the next matching server notification,
   * or undefined after timeoutMs. Register BEFORE triggering the action
   * that causes the notification, then await.
   */
  waitForNotification<P>(
    method: string,
    predicate: (params: P) => boolean,
    timeoutMs: number,
  ): Promise<P | undefined> {
    return new Promise((resolve) => {
      const handler = (incoming: string, params: unknown) => {
        if (incoming !== method || !predicate(params as P)) return;
        this.#notificationHandlers.delete(handler);
        clearTimeout(timer);
        resolve(params as P);
      };
      const timer = setTimeout(() => {
        this.#notificationHandlers.delete(handler);
        resolve(undefined);
      }, timeoutMs);
      timer.unref();
      this.#notificationHandlers.add(handler);
    });
  }

  async closeDocument(filePath: string): Promise<void> {
    const uri = pathToFileURL(filePath).href;
    if (!this.#openDocuments.delete(uri)) return;
    await this.#connection.sendNotification('textDocument/didClose', {
      textDocument: { uri },
    });
  }

  request<R>(method: string, params: unknown): Promise<R> {
    if (!this.#initialized) {
      return Promise.reject(new Error(`LSP request "${method}" before initialize`));
    }
    return this.#connection.sendRequest<R>(method, params);
  }

  notify(method: string, params: unknown): Promise<void> {
    return this.#connection.sendNotification(method, params);
  }

  /** Graceful LSP shutdown; force-kills the process if it lingers. */
  async shutdown(): Promise<void> {
    const exited = new Promise<void>((resolve) => {
      if (this.#child.exitCode !== null) resolve();
      else this.#child.once('exit', () => resolve());
    });
    try {
      await this.#connection.sendRequest('shutdown', null);
      await this.#connection.sendNotification('exit', null);
    } catch {
      // Server may already be gone; killing below is the fallback.
    }
    const timeout = new Promise<'timeout'>((resolve) =>
      setTimeout(() => resolve('timeout'), 3000).unref(),
    );
    if ((await Promise.race([exited, timeout])) === 'timeout') {
      this.#child.kill('SIGKILL');
      await exited;
    }
    this.#connection.dispose();
  }
}

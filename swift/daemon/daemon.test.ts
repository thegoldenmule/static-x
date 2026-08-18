import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { decode, encode } from './protocol.js';
import { socketDir, socketPath } from './socket.js';

describe('daemon wire protocol', () => {
  it('round-trips a message', () => {
    const { messages, rest } = decode(encode({ id: 1, tool: 'swift/x' }));
    expect(messages).toEqual([{ id: 1, tool: 'swift/x' }]);
    expect(rest).toBe('');
  });

  // A response can exceed one chunk. Parsing a partial read would
  // surface as a syntax error rather than as the incomplete read it is.
  it('holds back a partial message until its newline arrives', () => {
    const framed = encode({ id: 1 }) + encode({ id: 2 });
    const split = framed.slice(0, framed.length - 5);
    const first = decode(split);
    expect(first.messages).toEqual([{ id: 1 }]);
    expect(first.rest).not.toBe('');

    const second = decode(first.rest + framed.slice(framed.length - 5));
    expect(second.messages).toEqual([{ id: 2 }]);
    expect(second.rest).toBe('');
  });

  it('reads several messages out of one chunk', () => {
    const { messages } = decode(encode({ id: 1 }) + encode({ id: 2 }) + encode({ id: 3 }));
    expect(messages).toHaveLength(3);
  });
});

describe('daemon socket paths', () => {
  it('gives different roots different sockets', () => {
    expect(socketPath('/a/one')).not.toBe(socketPath('/a/two'));
  });

  it('is stable for one root', () => {
    expect(socketPath('/a/one')).toBe(socketPath('/a/one'));
    expect(socketPath('/a/one/../one')).toBe(socketPath('/a/one'));
  });

  // The version is in the name so an upgraded static-x cannot talk to a
  // daemon running older code: it finds no socket, spawns its own, and
  // the stale one idles out. Cheaper and more reliable than negotiating.
  it('carries the package version, so an upgrade cannot reuse a stale daemon', () => {
    expect(path.basename(socketPath('/a/one'))).toMatch(/^\d[^-]*-[0-9a-f]{16}\.sock$/);
  });

  // macOS caps a unix socket path near 104 bytes.
  it('stays inside the platform path limit for a deep root', () => {
    const deep = `/${'nested/'.repeat(40)}project`;
    expect(socketPath(deep).length).toBeLessThan(104);
    expect(socketPath(deep).startsWith(socketDir())).toBe(true);
  });
});

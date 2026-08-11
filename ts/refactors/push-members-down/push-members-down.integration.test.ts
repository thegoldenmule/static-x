import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { TsProjectSession } from '../../project/index.js';
import { preview, withProjectCopy } from '../testing.js';
import { pushMembersDown } from './push-members-down.js';

const FIXTURE = path.resolve(import.meta.dirname, '../../../fixtures/push-members-down-ts');
const MIXIN = path.join(FIXTURE, 'mixin');
const src = (file: string) => path.join(FIXTURE, 'src', file);

describe('ts/refactors/push-members-down', () => {
  const session = TsProjectSession.open(FIXTURE);
  afterAll(() => session.dispose());

  it('copies a member into every subclass and deletes it from the base', { timeout: 30_000 }, async () => {
    const before = await readFile(src('channel.ts'), 'utf8');
    const result = await pushMembersDown.run(session, {
      symbol: 'Channel',
      members: ['signature'],
    });

    expect(result.applied).toBe(false);
    expect(result.newDiagnostics).toEqual([]);
    expect(result.members).toEqual(['signature']);
    expect(result.targets).toEqual([
      { container: 'EmailChannel', file: src('email.ts') },
      { container: 'PushChannel', file: src('push.ts') },
      { container: 'SmsChannel', file: src('wire/sms.ts') },
    ]);

    // The copy carries the JSDoc and lands at the class's own indent.
    expect(await preview(result.edit, src('wire/sms.ts'))).toBe(
      "import { Channel } from '../channel.js';\n" +
        "import type { Payload } from '../types.js';\n" +
        "import { BULLET, pad } from '../format.js';\n" +
        '\n' +
        'export class SmsChannel extends Channel {\n' +
        "  out = '';\n" +
        '\n' +
        '  constructor() {\n' +
        "    super('sms');\n" +
        '  }\n' +
        '\n' +
        '  send(payload: Payload): void {\n' +
        '    this.out = `${this.signature()} ${this.envelope(payload).text}`;\n' +
        '  }\n' +
        '\n' +
        '  /** How this channel signs the messages it sends. */\n' +
        '  signature(): string {\n' +
        '    return `${BULLET} ${pad(this.name, 8)} ${this.tagline()}`;\n' +
        '  }\n' +
        '}\n',
    );

    const channel = await preview(result.edit, src('channel.ts'));
    expect(channel).not.toContain('signature(): string');
    // The member left, and the members around it kept their separation.
    expect(channel).toContain(
      '  constructor(readonly name: string) {\n' +
        '    super();\n' +
        '  }\n' +
        '\n' +
        '  tagline(): string {\n',
    );

    // Duplication is the point, and is named as a hazard anyway.
    expect(result.warnings.join('\n')).toContain(
      'signature now exists in 3 places (EmailChannel, PushChannel, SmsChannel)',
    );

    // Dry run: nothing on disk changed.
    expect(await readFile(src('channel.ts'), 'utf8')).toBe(before);
  });

  it('is not blocked by a class extending a lib type', { timeout: 30_000 }, async () => {
    // errors.ts has `class DeliveryFailed extends Error`. lib.d.ts
    // declares Error as an interface plus a var of constructor type, so
    // it resolves to no class declaration — and a scan that calls that
    // opaque refuses every unrelated hierarchy in the project. Found on
    // a real package, where one custom Error subclass made every push
    // impossible.
    const result = await pushMembersDown.run(session, {
      symbol: 'Channel',
      members: ['signature'],
    });

    expect(result.newDiagnostics).toEqual([]);
    expect(result.targets.length).toBeGreaterThan(0);
  });

  it('writes the imports each copy depends on, and drops the ones the base orphans', { timeout: 30_000 }, async () => {
    const result = await pushMembersDown.run(session, {
      symbol: 'Channel',
      members: ['signature'],
    });

    // Two names from one module arrive as one statement, re-based for
    // the subdirectory the subclass lives in.
    expect(await preview(result.edit, src('email.ts'))).toContain(
      "import { BULLET, pad } from './format.js';",
    );
    expect(await preview(result.edit, src('wire/sms.ts'))).toContain(
      "import { BULLET, pad } from '../format.js';",
    );
    // channel.ts still uses MARK in stamp(), so only the two names the
    // departing member took are unbound.
    expect(await preview(result.edit, src('channel.ts'))).toContain(
      "import { MARK } from './format.js';",
    );
  });

  it('folds a type-only dependency into the import the destination already has', { timeout: 30_000 }, async () => {
    const result = await pushMembersDown.run(session, { symbol: 'Channel', members: ['envelope'] });

    expect(result.newDiagnostics).toEqual([]);
    // Envelope is a type, email.ts already imports Payload type-only
    // from that module, so the name joins the clause rather than
    // starting a second import of the same specifier.
    expect(await preview(result.edit, src('email.ts'))).toContain(
      "import type { Payload, Envelope } from './types.js';",
    );
    // The base still names Payload in `abstract send`, so only Envelope
    // is unbound there — the single-orphan path through removeBinding.
    expect(await preview(result.edit, src('channel.ts'))).toContain(
      "import type { Payload } from './types.js';",
    );
  });

  it('narrows the receiving set with to', { timeout: 30_000 }, async () => {
    const result = await pushMembersDown.run(session, {
      symbol: 'Channel',
      members: ['retries'],
      to: ['EmailChannel'],
    });

    expect(result.newDiagnostics).toEqual([]);
    expect(result.targets).toEqual([{ container: 'EmailChannel', file: src('email.ts') }]);
    expect(await preview(result.edit, src('email.ts'))).toContain(
      '  /** How many times a failed send is retried. */\n  retries = 3;\n',
    );
    // A member that opens the class body takes the blank line after it
    // rather than the one before, so the body does not open with a gap.
    expect(await preview(result.edit, src('channel.ts'))).toContain(
      'export abstract class Channel extends Endpoint {\n  constructor(readonly name: string) {\n',
    );
    // One destination, so nothing is duplicated and nothing is warned.
    expect(result.warnings).toEqual([]);
  });

  it('moves every declaration of a member, so a get/set pair stays whole', { timeout: 30_000 }, async () => {
    const result = await pushMembersDown.run(session, {
      symbol: 'Channel',
      members: ['label'],
      to: ['PushChannel'],
    });

    expect(result.newDiagnostics).toEqual([]);
    expect(result.members).toEqual(['label']);
    const push = await preview(result.edit, src('push.ts'));
    expect(push).toContain('  get label(): string {\n    return this.tag;\n  }\n');
    expect(push).toContain('  set label(value: string) {\n    this.tag = value;\n  }\n');
    const channel = await preview(result.edit, src('channel.ts'));
    expect(channel).not.toContain('get label');
    expect(channel).not.toContain('set label');
    // The backing field is protected, so the copy can still read it —
    // and it stays where it is, since it was not asked for.
    expect(channel).toContain("  protected tag = '';");
  });

  it('takes a name given twice once', { timeout: 30_000 }, async () => {
    // Copied twice, the member would be a duplicate identifier: a
    // guard-visible failure whose cause is the input rather than the code.
    const result = await pushMembersDown.run(session, {
      symbol: 'Channel',
      members: ['retries', 'retries'],
      to: ['EmailChannel', 'EmailChannel'],
    });

    expect(result.newDiagnostics).toEqual([]);
    expect(result.members).toEqual(['retries']);
    expect(result.targets).toHaveLength(1);
  });

  it('counts a reference from inside another pushed member as a use of it', { timeout: 30_000 }, async () => {
    // No subclass calls tagline() directly — every call is the one
    // inside signature(), which travels with the copy. Pushed together
    // they land together; pushed alone, tagline is called by the base.
    const result = await pushMembersDown.run(session, {
      symbol: 'Channel',
      members: ['signature', 'tagline'],
    });

    expect(result.newDiagnostics).toEqual([]);
    expect(result.members).toEqual(['signature', 'tagline']);
    const sms = await preview(result.edit, src('wire/sms.ts'));
    expect(sms).toContain('  signature(): string {\n');
    expect(sms).toContain('  tagline(): string {\n');
    const channel = await preview(result.edit, src('channel.ts'));
    expect(channel).not.toContain('tagline(): string');
    expect(channel).not.toContain('signature(): string');

    await expect(
      pushMembersDown.run(session, { symbol: 'Channel', members: ['tagline'] }),
    ).rejects.toThrow(/Channel\.tagline is used by Channel's own code/);
  });
});

describe('ts/refactors/push-members-down refusals', () => {
  const session = TsProjectSession.open(FIXTURE);
  afterAll(() => session.dispose());

  it('refuses a member a receiving subclass does not use', { timeout: 30_000 }, async () => {
    await expect(
      pushMembersDown.run(session, { symbol: 'Channel', members: ['retries'] }),
    ).rejects.toThrow(
      /PushChannel does not use Channel\.retries.*pure duplication.*Narrow with to: \["EmailChannel"\]/s,
    );
  });

  it('refuses a member nothing that extends the base uses', { timeout: 30_000 }, async () => {
    await expect(
      pushMembersDown.run(session, { symbol: 'Channel', members: ['describe'] }),
    ).rejects.toThrow(/Nothing that extends Channel uses it/);
  });

  it('refuses a subclass that would lose a member it uses', { timeout: 30_000 }, async () => {
    await expect(
      pushMembersDown.run(session, {
        symbol: 'Channel',
        members: ['signature'],
        to: ['EmailChannel'],
      }),
    ).rejects.toThrow(/PushChannel uses Channel\.signature but is not in to/);
  });

  it('refuses a member the base itself calls', { timeout: 30_000 }, async () => {
    await expect(
      pushMembersDown.run(session, { symbol: 'Channel', members: ['banner'] }),
    ).rejects.toThrow(/Channel\.banner is used by Channel's own code at .*channel\.ts/);
  });

  it('refuses an abstract member', { timeout: 30_000 }, async () => {
    await expect(
      pushMembersDown.run(session, { symbol: 'Channel', members: ['send'] }),
    ).rejects.toThrow(/Channel\.send is abstract/);
  });

  it('refuses a member a subclass already declares', { timeout: 30_000 }, async () => {
    await expect(
      pushMembersDown.run(session, { symbol: 'Channel', members: ['trace'] }),
    ).rejects.toThrow(/EmailChannel .* already declares "trace"/);
  });

  it('refuses a member a base class also declares', { timeout: 30_000 }, async () => {
    // Channel.ping overrides Endpoint.ping: removing it from Channel
    // does not remove the member, it changes which body runs.
    await expect(
      pushMembersDown.run(session, { symbol: 'Channel', members: ['ping'] }),
    ).rejects.toThrow(/Channel\.ping overrides the declaration on Endpoint/);
  });

  it('refuses a static member, and a private one', { timeout: 30_000 }, async () => {
    await expect(
      pushMembersDown.run(session, { symbol: 'Channel', members: ['brand'] }),
    ).rejects.toThrow(/is static.*ts\/refactors\/move-member/s);
    await expect(
      pushMembersDown.run(session, { symbol: 'Channel', members: ['token'] }),
    ).rejects.toThrow(/Channel\.token is private/);
  });

  it('refuses a member that reads super', { timeout: 30_000 }, async () => {
    await expect(
      pushMembersDown.run(session, { symbol: 'Channel', members: ['relay'] }),
    ).rejects.toThrow(/reads `super`/);
  });

  it('refuses a reference off a base-typed value', { timeout: 30_000 }, async () => {
    await expect(
      pushMembersDown.run(session, { symbol: 'Channel', members: ['preview'] }),
    ).rejects.toThrow(/read off a Channel-typed value at .*dispatch\.ts/);
  });

  it('refuses a name that means something else at the destination', { timeout: 30_000 }, async () => {
    // push.ts declares its own MARK, so the copied body would compile
    // and produce a different string.
    await expect(
      pushMembersDown.run(session, {
        symbol: 'Channel',
        members: ['stamp'],
        to: ['PushChannel'],
      }),
    ).rejects.toThrow(/"MARK" already means something else in .*push\.ts/);
  });

  it('refuses a base whose subclasses cannot be enumerated', { timeout: 30_000 }, async () => {
    await withProjectCopy(MIXIN, async (copy) => {
      await expect(
        pushMembersDown.run(copy, { symbol: 'Feed', members: ['hydrate'] }),
      ).rejects.toThrow(
        /Feed's subclasses cannot be enumerated: AuditedFeed extends WithAudit\(Feed\)/,
      );
    });
  });

  it('leaves a hierarchy an unrelated mixin cannot reach pushable', { timeout: 30_000 }, async () => {
    // clock.ts holds `LoggedClock extends WithLogging(Clock)`, opaque in
    // exactly the same way. It names no class the Channel hierarchy
    // contains, so it refuses a push off Clock and nothing else.
    await expect(
      pushMembersDown.run(session, { symbol: 'Clock', members: ['now'] }),
    ).rejects.toThrow(/Clock's subclasses cannot be enumerated/);
    const unaffected = await pushMembersDown.run(session, {
      symbol: 'Channel',
      members: ['signature'],
    });
    expect(unaffected.newDiagnostics).toEqual([]);
  });

  it('refuses a base with no subclasses, and a target that is not a class', { timeout: 30_000 }, async () => {
    await expect(
      pushMembersDown.run(session, { symbol: 'Beacon', members: ['pulse'] }),
    ).rejects.toThrow(/Nothing in this project extends Beacon/);
    await expect(
      pushMembersDown.run(session, { symbol: 'pad', members: ['x'] }),
    ).rejects.toThrow(/targets a base class; the declaration here is a FunctionDeclaration/);
  });

  it('refuses an unknown member, an unknown subclass, and an empty selection', { timeout: 30_000 }, async () => {
    await expect(
      pushMembersDown.run(session, { symbol: 'Channel', members: ['nope'] }),
    ).rejects.toThrow(/Channel declares no member named "nope"/);
    await expect(
      pushMembersDown.run(session, { symbol: 'Channel', members: ['signature'], to: ['Nope'] }),
    ).rejects.toThrow(/"Nope" does not extend Channel\. Its subclasses are: EmailChannel/);
    await expect(pushMembersDown.run(session, { symbol: 'Channel', members: [] })).rejects.toThrow(
      /at least one member/,
    );
  });

  it('refuses an edit the typecheck rejects', { timeout: 30_000 }, async () => {
    // audit() reads the private token(), which stays on the base — so
    // the copy cannot reach it. Nothing before the edit knows that; the
    // guard does, and it blocks the write even with apply: true.
    const before = await readFile(src('email.ts'), 'utf8');
    const result = await pushMembersDown.run(session, {
      symbol: 'Channel',
      members: ['audit'],
      to: ['EmailChannel'],
      apply: true,
    });

    expect(result.applied).toBe(false);
    expect(result.newDiagnostics.join('\n')).toContain('TS2341');
    expect(await readFile(src('email.ts'), 'utf8')).toBe(before);
  });
});

describe('ts/refactors/push-members-down placement', () => {
  it('opens an empty class body rather than welding the copy to the brace', { timeout: 60_000 }, async () => {
    await withProjectCopy(FIXTURE, async (copy, root) => {
      // The subclass is written into the copy: a class with no members
      // can only be reached from outside, so the receiving-set rules
      // make this the one way the empty-body insertion happens.
      const file = path.join(root, 'src', 'void.ts');
      await writeFile(
        file,
        "import { Channel } from './channel.js';\n" +
          '\n' +
          'export abstract class VoidChannel extends Channel {}\n' +
          '\n' +
          'export function describeSilently(channel: VoidChannel): string {\n' +
          '  return channel.describe();\n' +
          '}\n',
        'utf8',
      );
      copy.invalidate();

      const result = await pushMembersDown.run(copy, {
        symbol: 'Channel',
        members: ['describe'],
        to: ['VoidChannel'],
      });

      expect(result.newDiagnostics).toEqual([]);
      expect(await preview(result.edit, file)).toContain(
        'export abstract class VoidChannel extends Channel {\n' +
          '  describe(): string {\n' +
          '    return `${this.banner()} channel`;\n' +
          '  }\n' +
          '}\n',
      );
    });
  });
});

describe('ts/refactors/push-members-down apply mode', () => {
  it('writes the push to disk, leaving the project compiling', { timeout: 60_000 }, async () => {
    await withProjectCopy(FIXTURE, async (copy, root) => {
      const file = (name: string) => path.join(root, 'src', name);
      const result = await pushMembersDown.run(copy, {
        symbol: 'Channel',
        members: ['signature', 'tagline'],
        apply: true,
      });

      expect(result.newDiagnostics).toEqual([]);
      expect(result.applied).toBe(true);
      expect(await readFile(file('channel.ts'), 'utf8')).not.toContain('signature(): string');
      for (const name of ['email.ts', 'push.ts', 'wire/sms.ts']) {
        expect(await readFile(file(name), 'utf8')).toContain('  signature(): string {');
      }

      // An authored edit that merely looked right fails here: the whole
      // project is re-read from disk and typechecked from scratch.
      const reopened = TsProjectSession.open(root);
      try {
        expect(
          reopened
            .program()
            .getSemanticDiagnostics()
            .map((diagnostic) => diagnostic.messageText),
        ).toEqual([]);
      } finally {
        await reopened.dispose();
      }

      // The session must see the project as it now is: the member is a
      // subclass member now, and the base no longer declares it.
      await expect(
        pushMembersDown.run(copy, { symbol: 'Channel', members: ['signature'] }),
      ).rejects.toThrow(/Channel declares no member named "signature"/);
    });
  });
});

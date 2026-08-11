import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { TsProjectSession } from '../../project/index.js';
import { preview, withProjectCopy } from '../testing.js';
import { constructorToFactory } from './constructor-to-factory.js';

const FIXTURE = path.resolve(import.meta.dirname, '../../../fixtures/constructor-to-factory-ts');
const src = (file: string) => path.join(FIXTURE, 'src', file);

describe('ts/refactors/constructor-to-factory', () => {
  const session = TsProjectSession.open(FIXTURE);
  afterAll(() => session.dispose());

  it('adds a factory, closes the constructor, rewrites every new', { timeout: 30_000 }, async () => {
    const result = await constructorToFactory.run(session, { symbol: 'Client' });

    expect(result.applied).toBe(false);
    expect(result.newDiagnostics).toEqual([]);
    expect(result.factory).toBe('create');
    expect(result.visibility).toBe('private');

    const client = await preview(result.edit, src('client.ts'));
    expect(client).toContain('  static create(host: string, retries = 3): Client {\n');
    expect(client).toContain('    return new Client(host, retries);\n');
    // The JSDoc belongs to the constructor and stays with it, below the
    // factory rather than above.
    expect(client).toContain('  /** Opens a client against `host`. */\n  private constructor(');

    const app = await preview(result.edit, src('app.ts'));
    expect(app).toContain("return Client.create('example.com').describe();");
    expect(app).toContain("const a = Client.create('a.example', 5);");
    expect(app).toContain("const b = Client.create('b.example');");

    // Comments between arguments survive, because the argument list is
    // not rebuilt: a dropped `// @ts-expect-error` brings back the error
    // it suppressed, which is how this was found.
    expect(app).toContain('    // A directive here must survive the rewrite.\n');
    expect(app).toContain('  return Client.create(\n');

    expect(result.sites).toHaveLength(4);
  });

  it('carries the class type parameters onto the factory', { timeout: 30_000 }, async () => {
    const result = await constructorToFactory.run(session, { symbol: 'Box' });

    expect(result.newDiagnostics).toEqual([]);
    expect(await preview(result.edit, src('client.ts'))).toContain(
      '  static create<T>(value: T): Box<T> {\n',
    );
    expect(await preview(result.edit, src('app.ts'))).toContain('return Box.create<number>(1).value;');
  });

  it('leaves the constructor protected when the class is extended', { timeout: 30_000 }, async () => {
    const result = await constructorToFactory.run(session, { symbol: 'Node2' });

    expect(result.newDiagnostics).toEqual([]);
    expect(result.visibility).toBe('protected');
    expect(await preview(result.edit, src('client.ts'))).toContain('  protected constructor(');
    expect(result.warnings.join('\n')).toContain('extended by Leaf');
    // `super(label)` in Leaf still reaches it.
    expect(await preview(result.edit, src('app.ts'))).toContain("Node2.create('root').label");
  });

  it('names a destructured parameter so the factory can forward it', { timeout: 30_000 }, async () => {
    const result = await constructorToFactory.run(session, { symbol: 'Destructured' });

    expect(result.newDiagnostics).toEqual([]);
    const hazards = await preview(result.edit, src('hazards.ts'));
    expect(hazards).toContain('static create(arg1: { a: number; b: number }): Destructured {');
    expect(hazards).toContain('return new Destructured(arg1);');
  });

  it('honours a custom factory name', { timeout: 30_000 }, async () => {
    const result = await constructorToFactory.run(session, { symbol: 'Box', name: 'of' });
    expect(result.factory).toBe('of');
    expect(await preview(result.edit, src('app.ts'))).toContain('Box.of<number>(1)');
  });
});

describe('ts/refactors/constructor-to-factory refusals', () => {
  const session = TsProjectSession.open(FIXTURE);
  afterAll(() => session.dispose());

  it('refuses a class whose name escapes into a value', async () => {
    // `const Alias = Escaped` means `new Alias(...)` is not a reference
    // to `Escaped` anyone can find, and it compiles either way.
    await expect(constructorToFactory.run(session, { symbol: 'Escaped' })).rejects.toThrow(
      /reaches a binding this cannot follow/,
    );
  });

  it('refuses an abstract class', async () => {
    await expect(constructorToFactory.run(session, { symbol: 'Shape' })).rejects.toThrow(
      /is abstract, so nothing constructs it directly/,
    );
  });

  it('refuses a class with no explicit constructor', async () => {
    await expect(constructorToFactory.run(session, { symbol: 'Implicit' })).rejects.toThrow(
      /declares no constructor/,
    );
  });

  it('refuses a constructor reading new.target', async () => {
    await expect(constructorToFactory.run(session, { symbol: 'Reflective' })).rejects.toThrow(
      /reads `new\.target`/,
    );
  });

  it('refuses a factory name already taken by a static', async () => {
    await expect(constructorToFactory.run(session, { symbol: 'Registry' })).rejects.toThrow(
      /already declares a static "create"/,
    );
  });
});

describe('ts/refactors/constructor-to-factory apply mode', () => {
  it('writes the edit and leaves the project compiling', { timeout: 60_000 }, async () => {
    await withProjectCopy(FIXTURE, async (copy) => {
      const result = await constructorToFactory.run(copy, { symbol: 'Client', apply: true });
      expect(result.applied).toBe(true);

      const reopened = TsProjectSession.open(copy.rootPath);
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
    });
  });
});

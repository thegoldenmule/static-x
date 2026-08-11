import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { applyTextEdits } from '../../core/edits/index.js';
import { relativeSpecifier, removeBinding } from './imports.js';

/** Parse a file and remove the binding of `name`, returning the result. */
function unbind(source: string, name: string): string {
  const sourceFile = ts.createSourceFile('m.ts', source, ts.ScriptTarget.Latest, true);
  let target: ts.Node | undefined;
  const visit = (node: ts.Node): void => {
    if (
      ts.isIdentifier(node) &&
      node.text === name &&
      node.parent &&
      (ts.isImportSpecifier(node.parent) || ts.isExportSpecifier(node.parent))
    ) {
      target ??= node;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!target) throw new Error(`no binding of "${name}" in the source`);
  const edit = removeBinding(target, sourceFile);
  if (!edit) throw new Error('removeBinding declined');
  return applyTextEdits(source, [edit]);
}

describe('removeBinding', () => {
  it('takes the comma after the first name in a list', () => {
    expect(unbind("import { a, b, c } from './m.js';\n", 'a')).toBe(
      "import { b, c } from './m.js';\n",
    );
  });

  it('takes the comma before a later name', () => {
    expect(unbind("import { a, b, c } from './m.js';\n", 'c')).toBe(
      "import { a, b } from './m.js';\n",
    );
  });

  it('preserves a trailing comma by eating the preceding one', () => {
    // The last element has no next, so the comma before it goes and the
    // list's own trailing comma survives.
    expect(unbind("import {\n  a,\n  b,\n} from './m.js';\n", 'b')).toBe(
      "import {\n  a,\n} from './m.js';\n",
    );
  });

  it('removes the whole statement when it bound nothing else', () => {
    expect(unbind("import { only } from './m.js';\nconst x = 1;\n", 'only')).toBe('const x = 1;\n');
  });

  it('keeps a default binding when the named one goes', () => {
    expect(unbind("import Default, { gone } from './m.js';\n", 'gone')).toBe(
      "import Default from './m.js';\n",
    );
  });

  it('removes a re-export specifier the same way', () => {
    expect(unbind("export { a, b } from './m.js';\n", 'a')).toBe("export { b } from './m.js';\n");
  });

  it('removes a whole re-export statement when it named one symbol', () => {
    expect(unbind("export { only } from './m.js';\nexport const x = 1;\n", 'only')).toBe(
      'export const x = 1;\n',
    );
  });
});

describe('relativeSpecifier', () => {
  it('writes a sibling as an explicit relative path', () => {
    expect(relativeSpecifier('/p/src/a.ts', '/p/src/b.ts', true)).toBe('./b.js');
  });

  it('writes a parent directory without inventing a leading dot', () => {
    expect(relativeSpecifier('/p/src/deep/a.ts', '/p/src/b.ts', true)).toBe('../b.js');
  });

  it('omits the extension when the project does', () => {
    expect(relativeSpecifier('/p/src/a.ts', '/p/src/b.ts', false)).toBe('./b');
  });

  it('maps .mts and .cts to their own import extensions', () => {
    // `.mts` imports as `.mjs`, not `.js` — getting this wrong is a
    // module-resolution failure rather than a style difference.
    expect(relativeSpecifier('/p/src/a.ts', '/p/src/b.mts', true)).toBe('./b.mjs');
    expect(relativeSpecifier('/p/src/a.ts', '/p/src/b.cts', true)).toBe('./b.cjs');
  });
});

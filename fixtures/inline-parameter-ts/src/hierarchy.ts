export class Base {
  render(text: string, prefix: string): string {
    return `${prefix}${text}`;
  }
}

/**
 * Both declarations of `render` are one signature. In one file because
 * ts/ast/hierarchy.ts does not resolve an imported base class through
 * its import alias yet, and reports a cross-file `extends` as
 * unresolved instead of as the override it is.
 */
export class Derived extends Base {
  override render(text: string, prefix: string): string {
    return `${prefix}!${text}`;
  }
}

export function renderBoth(base: Base, derived: Derived): string[] {
  return [base.render('a', '> '), derived.render('b', '> ')];
}

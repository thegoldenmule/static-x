export class Base {
  render(text: string): string {
    return '> '.concat(text);
  }
}

/**
 * Both declarations of `render` are one signature. In one file because
 * ts/ast/hierarchy.ts reports a cross-file `extends` as unresolved
 * rather than as the override it is.
 */
export class Derived extends Base {
  override render(text: string): string {
    return '>> '.concat(text);
  }
}

export function renderBoth(base: Base, derived: Derived): string[] {
  return [base.render('a'), derived.render('b')];
}

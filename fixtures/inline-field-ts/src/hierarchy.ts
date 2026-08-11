export class Base {
  readonly kind: string = 'base';
}

export class Derived extends Base {
  override readonly kind = 'derived';
}

export function describe(node: Base): string {
  return node.kind;
}

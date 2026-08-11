export class Crate<T> {
  readonly items: T[] = [];

  add(item: T): void {
    this.items.push(item);
  }
}

export function first(crate: Crate<string>): string | undefined {
  return crate.items[0];
}

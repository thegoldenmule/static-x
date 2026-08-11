/** Members that every conversion in this tool has to refuse. */

export class Base {
  getName(): string {
    return 'base';
  }
}

export class Child extends Base {
  override getName(): string {
    return 'child';
  }
}

export class Keyed {
  getSize(): number {
    return 3;
  }
}

export function viaKey(k: Keyed): number {
  return k['getSize']();
}

export class Tally {
  count = 0;
}

export function makeTally(): Tally {
  return new Tally();
}

export function bumpFresh(): void {
  makeTally().count += 1;
}

export class Pair {
  left = 1;
}

export function split(p: Pair): number {
  const { left } = p;
  return left;
}

export class Clamped {
  private _v = 0;

  get v(): number {
    return this._v;
  }

  set v(next: number) {
    this._v = Math.max(0, next);
  }
}

export class Toggle {
  private _on = false;

  get on(): boolean {
    return this._on;
  }

  set on(next: boolean) {
    this._on = next;
  }
}

export function flip(t: Toggle): void {
  t.on ||= true;
}

export class Detached {
  getStamp(): string {
    return 'stamp';
  }
}

export function detach(d: Detached): () => string {
  return d.getStamp;
}

export class Slot {
  value = 0;
}

export function chain(s: Slot): number {
  return (s.value = 7);
}

export class Sum {
  total = 0;
}

export function fold(a: Sum, b: Sum): void {
  a.total += b.total;
}

export class Volume {
  level = 1;
}

export function scale(v: Volume, a: number, b: number): void {
  v.level *= a + b;
}

export function tick(v: Volume): void {
  v.level++;
}

export class Sealed {
  readonly code: string;

  constructor(code: string) {
    this.code = code;
  }

  show(): string {
    return this.code;
  }
}

export class Registry {
  static count = 0;
}

export function register(): void {
  Registry.count = Registry.count + 1;
}

export class Mirror {
  private _v = 0;

  constructor(private readonly peer: Mirror) {}

  /** Reads the peer's field, not its own, under a name this class also declares. */
  get mirrored(): number {
    return this.peer._v;
  }

  bump(): void {
    this._v += 1;
  }
}

/** Satisfied structurally, never named by a heritage clause. */
export interface Named {
  getLabel(): string;
}

export class Widget {
  getLabel(): string {
    return 'widget';
  }
}

export const named: Named = new Widget();

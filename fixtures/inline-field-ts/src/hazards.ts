let scale = 2;

export function bump(): number {
  scale += 1;
  return scale;
}

function make(): Widget {
  return new Widget();
}

export class Widget {
  /** Reassigned in a method, so its reads are not its initializer. */
  mutable = 1;

  /** Calls out, and is read more than once. */
  readonly ticket = bump();

  /** Reads a variable that is assigned elsewhere. */
  readonly scaled = scale * 2;

  /** Allocates: two reads would be two different objects. */
  readonly tags = ['a'];

  /** Reads a property, which may hold something else by then. */
  readonly doubled = this.mutable * 2;

  /** Reads `this` and nothing else, so it describes one instance. */
  readonly me = this;

  retag(): void {
    this.mutable = 5;
  }

  twice(): number {
    return this.ticket + this.ticket;
  }

  pair(): string[] {
    return [...this.tags, ...this.tags];
  }
}

export function fromCall(): number {
  return make().mutable;
}

export function elsewhere(other: Widget): number {
  return other.doubled;
}

export function identity(other: Widget): Widget {
  return other.me;
}

export function scaledTwice(w: Widget): number {
  return w.scaled + w.scaled;
}

export namespace Layout {
  /** Indented, exported from inside a namespace, and oddly spelled. */
  export enum Edge {
    'top-left' = 'tl',
    Offset = -1,
  }
}

export const corner = Layout.Edge['top-left'];
export const offset: Layout.Edge = Layout.Edge.Offset;

export enum Terse { On = 1, Off = 0 }

export const on: Terse = Terse.On;

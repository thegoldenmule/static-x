export function scanned(pound: Pound): number {
  return pound.strays;
}

export class Pound {
  strays = 0;

  /** Dogs scanned for a chip on intake. */
  scan(): number {
    return this.strays;
  }

  /** Hands the whole pound out as a value, which the base class is not. */
  report(): number {
    return scanned(this);
  }
}

/** A pound that scans every dog twice. */
export class CityPound extends Pound {
  override scan(): number {
    return super.scan() * 2;
  }
}

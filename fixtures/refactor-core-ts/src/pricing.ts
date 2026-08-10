interface Line {
  qty: number;
  unit: number;
}

export function totalPrice(lines: Line[], taxRate: number): number {
  let total = 0;
  for (const line of lines) {
    total += line.qty * line.unit;
  }
  const taxed = total * (1 + taxRate);
  return Math.round(taxed * 100) / 100;
}

/** Template literals and regex are where a raw scanner loses the plot. */
export function describe(lines: Line[], label: string): string {
  const heading = `cart of ${String(lines.length)} items`;
  const safe = /[^a-z ]/i.test(label) ? 'unnamed' : label;
  return `${heading}: ${safe}`;
}

/** The same statement twice, so ambiguity has something to report. */
export function twice(lines: Line[]): number {
  let total = 0;
  if (lines.length > 0) {
    total += lines[0]!.qty;
  }
  if (lines.length > 1) {
    total += lines[0]!.qty;
  }
  return total;
}

export function inCallback(lines: Line[]): number[] {
  return lines.map((line) => {
    const scaled = line.qty * 2;
    return scaled;
  });
}

/** Declared once and written inline once — the dedupe case. */
export type Endpoint = { host: string; port: number };

export function connect(target: { host: string; port: number }): string {
  return `${target.host}:${String(target.port)}`;
}

export function probe(): { ok: boolean; latencyMs: number } {
  return { ok: true, latencyMs: 0 };
}

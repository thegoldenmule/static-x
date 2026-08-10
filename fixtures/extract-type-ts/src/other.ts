/** Identical to net.ts's shape, but in a file that cannot name a local alias. */
export function ping(target: { host: string; port: number }): boolean {
  return target.port > 0;
}

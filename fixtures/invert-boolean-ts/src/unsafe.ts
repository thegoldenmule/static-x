/** Targets this tool must refuse. Each one still compiles today. */

/**
 * The dangerous case, not an edge case: `!maybeShown` maps both `false`
 * and `undefined` to `true`, so negating every read is not an
 * inversion at all.
 */
export let maybeShown: boolean | undefined = undefined;

export function describeMaybe(): string {
  return maybeShown ? 'yes' : 'no';
}

/** `const` gives this the literal type `true`, not `boolean`. */
export const alwaysOn = true;

/** `counted ||= true` means `if (!counted) counted = true` — no negated form of that exists. */
export let counted = false;

export function bump(): void {
  counted ||= true;
}

export interface Prefs {
  loud: boolean;
}

export function volume(prefs: Prefs): string {
  const { loud } = prefs;
  return loud ? 'high' : 'low';
}

export let latched = false;

export function latch(source: () => boolean): string {
  if ((latched = source())) {
    return 'on';
  }
  return 'off';
}

export let bundled = false;

export function envelope(): { bundled: boolean } {
  return { bundled };
}

export function positive(n: number): boolean {
  return n > 0;
}

export function apply(test: (n: number) => boolean): boolean {
  return test(1);
}

export function handedOut(): boolean {
  return apply(positive);
}

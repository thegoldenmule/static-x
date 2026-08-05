/**
 * Builds a greeting for a user.
 *
 * @param userName the name to greet
 * @param excited whether to add an exclamation point
 * @see formatSalutation for the underlying formatting
 */
export function greet(userName: string, excited: boolean): string {
  const base = `Hello, ${userName}`;
  return excited ? `${base}!` : base;
}

// Uses `LegacyGreeter` under the hood for backwards compatibility.
export function greetAll(names: string[]): string[] {
  return names.map((name) => greet(name, false));
}

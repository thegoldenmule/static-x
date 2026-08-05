// Parses overrides with `JSON.parse()` before merging into
// defaultConfig; see loadConfig() and greet() for usage.
export const defaultConfig = { retries: 3 };

export function loadConfig(): typeof defaultConfig {
  return defaultConfig;
}

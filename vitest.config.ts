import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['{core,ts,swift,gd,packs,cli,mcp,hooks}/**/*.test.ts'],
    /**
     * Vitest's 5s default sits inside the range these tests actually
     * take. A test that opens a session spawns typescript-language-
     * server and waits for it to finish loading the project, and the
     * suite runs those in parallel across every core: measured here, the
     * slowest single test is 8.7s with a cluster at 4-6s. So on a loaded
     * machine a different handful times out on every run — noise that
     * reads exactly like a real failure.
     *
     * 20s is roughly twice the slowest observed, which is enough headroom
     * to be quiet while still bounding a genuinely hung language server.
     */
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['{core,ts,cli,mcp}/**/*.test.ts'],
  },
});

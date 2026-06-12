import { defineConfig } from 'vitest/config';

// slow balance simulation suite, run via `npm run test:balance`
export default defineConfig({
  test: {
    include: ['src/core/balance.test.ts'],
    testTimeout: 1_800_000,
  },
});

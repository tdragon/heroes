import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  base: process.env.PAGES_BASE_PATH ?? '/',
  test: {
    include: ['src/**/*.test.ts'],
    // the slow balance simulation runs separately via `npm run test:balance`
    exclude: [...configDefaults.exclude, 'src/core/balance.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/core/**', 'src/data/**', 'src/maps/**'],
    },
  },
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.{ts,tsx,js,cjs,mjs}'],
    exclude: ['node_modules/**', 'artifacts/**', 'apps/dashboard/dist/**'],
    testTimeout: 30_000,
  },
});

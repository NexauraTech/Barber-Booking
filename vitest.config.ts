import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Database-backed tests share one Postgres schema and TRUNCATE between
    // cases, so they must not run concurrently with each other.
    fileParallelism: false,
    include: ['tests/**/*.test.ts'],
  },
});

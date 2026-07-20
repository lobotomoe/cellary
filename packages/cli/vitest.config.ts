import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Unit tests only. Integration tests run under vitest.integration.config.ts
    // (separate `test:integration` script) since they need a live daemon.
    include: ['test/unit/**/*.test.ts'],
    environment: 'node',
    testTimeout: 10_000,
  },
})

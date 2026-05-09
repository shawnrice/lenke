import { defineConfig } from 'vitest/config';

// Build is handled by `bun build.ts` via @pl-graph/dev. This config is
// retained for vitest only — jsdom-based tests need a vitest config to
// resolve, and vitest discovers vite.config.ts by default.
export default defineConfig({
  test: {
    globals: true,
    include: ['**/*.test.tsx', '**/*.test.ts'],
  },
});

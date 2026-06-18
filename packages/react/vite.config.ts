import { defineConfig } from 'vitest/config';

// Build is handled by `bun build.ts` via @pl-graph/dev. This config is
// retained for vitest only — the hook tests need a DOM, and vitest discovers
// vite.config.ts by default. `happy-dom` is the DOM environment (faster than
// jsdom); set here so test files don't need a per-file `@vitest-environment`.
export default defineConfig({
  test: {
    globals: true,
    environment: 'happy-dom',
    include: ['**/*.test.tsx', '**/*.test.ts'],
  },
});

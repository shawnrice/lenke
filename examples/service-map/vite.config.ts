import { defineConfig } from 'vite';

export default defineConfig({
  // No react plugin on purpose (esbuild handles automatic JSX; we trade fast
  // refresh for zero extra dependencies in an example).
  esbuild: { jsx: 'automatic' },
  server: {
    fs: {
      // The wasm artifact is imported by URL from the crate's target dir,
      // outside this app's root.
      allow: ['../..'],
    },
  },
  worker: {
    format: 'es',
  },
});

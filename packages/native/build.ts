import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildPackage } from '@lenke/dev';

const __dirname = dirname(fileURLToPath(import.meta.url));

await buildPackage({
  packageRoot: __dirname,
  // The backends are subpath exports (`@lenke/native/ffi`, `/wasm`) so a
  // browser bundle never pulls in the Bun-only `bun:ffi` import.
  additionalEntrypoints: ['src/backend-ffi.ts', 'src/backend-wasm.ts'],
  skipCjs: true,
  skipMin: true,
});

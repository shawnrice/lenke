import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildPackage } from '@pl-graph/dev';

const __dirname = dirname(fileURLToPath(import.meta.url));

await buildPackage({
  packageRoot: __dirname,
  // The wasm/native connector is a subpath export (`@pl-graph/react/store`) so a
  // consumer using only the TS `Graph` never pulls in the `@pl-graph/native`
  // types, and vice versa.
  additionalEntrypoints: ['src/store.ts'],
  skipCjs: true,
  skipMin: true,
});

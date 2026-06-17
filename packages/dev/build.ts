import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildPackage } from './src/build.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

await buildPackage({
  packageRoot: __dirname,
  skipCjs: true,
  skipMin: true,
});

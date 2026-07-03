import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildPackage } from '@lenke/dev';

const __dirname = dirname(fileURLToPath(import.meta.url));

await buildPackage({
  packageRoot: __dirname,
  perFile: true,
  skipCjs: true,
  skipMin: true,
});

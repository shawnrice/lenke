import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildPackage } from '@pl-graph/dev';

const __dirname = dirname(fileURLToPath(import.meta.url));

buildPackage({
  packageRoot: __dirname,
  perFile: true,
  skipCjs: true,
  skipMin: true,
});

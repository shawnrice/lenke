import { buildPackage } from '@pl-graph/dev';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

buildPackage({
  packageRoot: __dirname,
  skipCjs: true,
  skipMin: true,
});

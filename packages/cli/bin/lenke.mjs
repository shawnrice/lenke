#!/usr/bin/env node
// Thin launcher: the CLI logic lives in src/ (built to dist/) and is unit-tested
// there; this file just wires argv and turns a thrown error into a clean exit.
import { main } from '../dist/esm/index.mjs';

main(process.argv.slice(2)).catch((err) => {
  process.stderr.write(`${err?.message ?? err}\n`);
  process.exit(1);
});

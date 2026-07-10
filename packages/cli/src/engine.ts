import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createWasmBackend } from '@lenke/native/wasm';

type Backend = Awaited<ReturnType<typeof createWasmBackend>>;

const WASM_REL = 'crates/lenke-core/target/wasm32-unknown-unknown/release/lenke_core.wasm';

// Locate the wasm engine: an explicit path / $LENKE_WASM, else walk up from this
// module looking for the workspace build output. (A published CLI would bundle
// the artifact beside itself; in-repo it's the cargo target dir.)
export const resolveWasmPath = (override?: string): string => {
  const explicit = override ?? process.env.LENKE_WASM;

  if (explicit) {
    return explicit;
  }

  let dir = path.dirname(fileURLToPath(import.meta.url));

  for (let i = 0; i < 12; i++) {
    const candidate = path.join(dir, WASM_REL);

    if (existsSync(candidate)) {
      return candidate;
    }

    const parent = path.dirname(dir);

    if (parent === dir) {
      break;
    }

    dir = parent;
  }

  throw new Error(
    `Could not locate ${WASM_REL}. Build it with \`bun run build:wasm\`, or set LENKE_WASM=/path/to/lenke_core.wasm.`,
  );
};

export const openBackend = async (wasmPath?: string): Promise<Backend> =>
  createWasmBackend(await readFile(resolveWasmPath(wasmPath)));

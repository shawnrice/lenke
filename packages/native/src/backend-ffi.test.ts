// End-to-end proof of the FFI backend through the public facade: load the native
// library, build a graph from NDJSON, and run GQL + Gremlin through `RustGraph`.
// The wasm backend exercises the identical `Backend` contract; its own test runs
// in a browser/wasm host. Run: bun test packages/native/src/backend-ffi.test.ts
import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';

import { ErrorCode, hasErrorCode, isLenkeError } from '@lenke/errors';

import { ABI_VERSION } from './abi.js';
import { createFfiBackend } from './backend-ffi.js';
import { graphFromFormat, graphFromNdjson } from './graph.js';

// The shared-library extension is platform-specific: macOS `.dylib`, Linux
// `.so`, Windows `.dll`. `build:rust` emits the one for the host.
const LIB_EXTENSIONS: Partial<Record<NodeJS.Platform, string>> = { darwin: 'dylib', win32: 'dll' };
const LIB_EXT = LIB_EXTENSIONS[process.platform] ?? 'so';
const LIB = new URL(
  `../../../crates/lenke-core/target/release/liblenke_core.${LIB_EXT}`,
  import.meta.url,
).pathname;

// The artifact is built by `bun run build:rust` (not by the test). Skip cleanly
// with a hint when it's absent, rather than hard-erroring at dlopen.
const hasLib = existsSync(LIB);

if (!hasLib) {
  console.warn(`[backend-ffi.test] skipping: ${LIB} not found — run \`bun run build:rust\` first.`);
}

const suite = hasLib ? describe : describe.skip;

const NDJSON = [
  '{"type":"node","id":"a","labels":["P"],"properties":{"name":"marko","age":29}}',
  '{"type":"node","id":"b","labels":["P"],"properties":{"name":"vadas","age":27}}',
  '{"type":"edge","id":"e1","labels":["knows"],"from":"a","to":"b","properties":{"weight":0.5}}',
].join('\n');

const bytes = new TextEncoder().encode(NDJSON);

suite('@lenke/native FFI backend', () => {
  test('loads at the expected ABI version', () => {
    const backend = createFfiBackend(LIB);
    expect(backend.abiVersion).toBe(ABI_VERSION);
  });

  test('builds a graph and reports counts', () => {
    const backend = createFfiBackend(LIB);
    const g = graphFromNdjson(backend, bytes);
    expect(g.vertexCount).toBe(2);
    expect(g.edgeCount).toBe(1);
    g.free();
  });

  test('runs a GQL query through the facade (string + template)', () => {
    const backend = createFfiBackend(LIB);
    const g = graphFromNdjson(backend, bytes);

    const rows = g.query('MATCH (n:P) RETURN n.name, n.age ORDER BY n.age');
    expect(rows).toEqual([
      { 'n.name': 'vadas', 'n.age': 27 },
      { 'n.name': 'marko', 'n.age': 29 },
    ]);

    const min = 28;
    const tpl = g.query`MATCH (n:P) WHERE n.age > ${min} RETURN n.name`;
    expect(tpl).toEqual([{ 'n.name': 'marko' }]);

    g.free();
  });

  test('runs a textual Gremlin query through the facade', () => {
    const backend = createFfiBackend(LIB);
    const g = graphFromNdjson(backend, bytes);
    const names = g.gremlin("g.V().has('name','marko').out('knows').values('name')");
    expect(names).toEqual(['vadas']);
    g.free();
  });

  test('round-trips through NDJSON', () => {
    const backend = createFfiBackend(LIB);
    const g = graphFromNdjson(backend, bytes);
    const out = g.toNdjson();
    const g2 = graphFromNdjson(backend, out);
    expect(g2.vertexCount).toBe(2);
    expect(g2.edgeCount).toBe(1);
    g.free();
    g2.free();
  });

  test('serializes + round-trips through every format', () => {
    const backend = createFfiBackend(LIB);
    const g = graphFromNdjson(backend, bytes);

    for (const fmt of ['pg-json', 'pg-text', 'graphson', 'csv', 'ndjson']) {
      const doc = g.serialize(fmt);
      expect(doc.length).toBeGreaterThan(0);
      const g2 = graphFromFormat(backend, doc, fmt);
      expect(g2.vertexCount).toBe(2);
      expect(g2.edgeCount).toBe(1);
      // the GQL query gives the same answer regardless of the carrier format
      expect(g2.query('MATCH (n:P) RETURN n.name ORDER BY n.name')).toEqual([
        { 'n.name': 'marko' },
        { 'n.name': 'vadas' },
      ]);
      g2.free();
    }

    g.free();
  });

  test('graphson preserves the edge id; unknown format throws a coded error', () => {
    const backend = createFfiBackend(LIB);
    const g = graphFromNdjson(backend, bytes);
    const gson = g.serialize('graphson');
    expect(gson).toContain('"e1"'); // the edge id survives

    let caught: unknown;

    try {
      g.serialize('nope');
    } catch (e) {
      caught = e;
    }

    expect(hasErrorCode(caught, ErrorCode.UnknownFormat)).toBe(true);
    g.free();
  });

  // The failure crossing: a real crate error rides the last-error side channel,
  // gets read back, and arrives as a `LenkeError` carrying the *same*
  // `ErrorCode` a pure-TS engine would raise — identical to the wasm backend.
  test('a GQL syntax error surfaces as a coded LenkeError with crate details', () => {
    const backend = createFfiBackend(LIB);
    const g = graphFromNdjson(backend, bytes);

    let caught: unknown;

    try {
      g.query('THIS IS NOT GQL');
    } catch (e) {
      caught = e;
    }

    expect(isLenkeError(caught)).toBe(true);
    expect(hasErrorCode(caught, ErrorCode.Syntax)).toBe(true);
    // the parse offset carried over from the crate's structured report
    expect((caught as { details?: { pos?: number } }).details?.pos).toBeTypeOf('number');
    g.free();
  });
});

// Proof that `@lenke/native/arrow` emits real, conformant Apache Arrow IPC: build
// an ARW1 blob from a live query, then reconstruct a Table AND round-trip both IPC
// layouts (stream + file/Feather) through `apache-arrow`'s reference decoder — the
// same decoder pandas / Polars / DuckDB use. Loads the real FFI cdylib by path.
import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';

import { tableFromIPC } from 'apache-arrow';

import { arrowTable, toArrowIPC } from './arrow.js';
import { createFfiBackend } from './backend-ffi.js';
import { graphFromFormat } from './graph.js';

const LIB_EXTENSIONS: Partial<Record<NodeJS.Platform, string>> = { darwin: 'dylib', win32: 'dll' };
const LIB_EXT = LIB_EXTENSIONS[process.platform] ?? 'so';
const LIB = new URL(
  `../../../crates/lenke-core/target/release/liblenke_core.${LIB_EXT}`,
  import.meta.url,
).pathname;

const hasLib = existsSync(LIB);

if (!hasLib) {
  console.warn(`[arrow.test] skipping: ${LIB} not found — run \`bun run build:rust\` first.`);
}

const suite = hasLib ? describe : describe.skip;

const NDJSON = [
  '{"type":"node","id":"a","labels":["P"],"properties":{"name":"marko","age":29,"active":true}}',
  '{"type":"node","id":"b","labels":["P"],"properties":{"name":"vadas","age":27}}',
  '{"type":"node","id":"c","labels":["P"],"properties":{"name":"josh","age":32,"active":false}}',
].join('\n');

suite('@lenke/native/arrow — real Arrow IPC egress', () => {
  const backend = createFfiBackend(LIB);
  const blobOf = (q: string): Uint8Array => {
    const g = graphFromFormat(backend, NDJSON, 'ndjson');

    try {
      return g.queryArrow(q);
    } finally {
      g.free();
    }
  };

  const QUERY =
    'MATCH (n:P) RETURN n.name AS name, n.age AS age, n.active AS active ORDER BY n.age';
  const EXPECTED = [
    { name: 'vadas', age: 27, active: null },
    { name: 'marko', age: 29, active: true },
    { name: 'josh', age: 32, active: false },
  ];

  test('arrowTable reconstructs a typed Table (Utf8/Float64/Bool) with nulls', () => {
    const t = arrowTable(blobOf(QUERY));

    expect(t.numRows).toBe(3);
    expect(t.schema.fields.map((f) => `${f.name}:${f.type}`)).toEqual([
      'name:Utf8',
      'age:Float64',
      'active:Bool',
    ]);
    expect([...t].map((r) => ({ name: r.name, age: r.age, active: r.active }))).toEqual(EXPECTED);
  });

  test('IPC stream round-trips through the reference decoder', () => {
    const back = tableFromIPC(toArrowIPC(blobOf(QUERY), 'stream'));

    expect([...back].map((r) => ({ name: r.name, age: r.age, active: r.active }))).toEqual(
      EXPECTED,
    );
  });

  test('IPC file / Feather layout round-trips and carries the ARROW1 magic', () => {
    const ipc = toArrowIPC(blobOf(QUERY), 'file');

    expect(new TextDecoder().decode(ipc.subarray(0, 6))).toBe('ARROW1');

    const back = tableFromIPC(ipc);
    expect([...back].map((r) => ({ name: r.name, age: r.age, active: r.active }))).toEqual(
      EXPECTED,
    );
  });

  test('default format is the IPC stream (no ARROW1 file magic)', () => {
    const ipc = toArrowIPC(blobOf(QUERY));

    expect(new TextDecoder().decode(ipc.subarray(0, 6))).not.toBe('ARROW1');
    expect(tableFromIPC(ipc).numRows).toBe(3);
  });

  test('an all-null column survives the round-trip', () => {
    const back = tableFromIPC(toArrowIPC(blobOf('MATCH (n:P) RETURN n.dept AS dept'), 'stream'));

    expect([...back].map((r) => r.dept)).toEqual([null, null, null]);
  });

  test('rejects a non-ARW1 blob', () => {
    expect(() => arrowTable(new Uint8Array([1, 2, 3, 4]))).toThrow();
  });
});

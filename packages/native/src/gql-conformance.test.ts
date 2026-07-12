// Differential conformance for GQL rich results: the TS GQL engine
// (@lenke/gql, in-process over @lenke/core) vs the Rust core (this package,
// over bun:ffi), driven from ONE source of truth — the same NDJSON loaded into
// both — so a `RETURN n` / `RETURN r` shape can't drift between the two forms.
//
//   load once:   identical NDJSON (same ids/labels/properties)
//   TS engine:   JSON.stringify(query(tsGraph, q))
//   Rust core:   JSON.stringify(nativeGraph.query(q))
//   assert:      the two serializations are byte-identical
//
// This pins the "rich results" contract: a returned node serializes to
// `{id, labels, properties}` and a returned edge to
// `{id, from, to, labels, properties}`, with labels and property keys in
// sorted order (the columnar core has no per-element key order, so both
// engines canonicalize to sorted). A bare-id regression on either side, or a
// key-ordering divergence, shows up here as a red diff.
//
// Run: bun test packages/native/src/gql-conformance.test.ts
import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';

import { Graph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { deserialize as tsDeserialize } from '@lenke/serialization';

import { createFfiBackend } from './backend-ffi.js';
import { graphFromFormat } from './graph.js';

// --- native library bootstrap (mirrors gremlin-conformance.test.ts) ---------
const LIB_EXTENSIONS: Partial<Record<NodeJS.Platform, string>> = { darwin: 'dylib', win32: 'dll' };
const LIB_EXT = LIB_EXTENSIONS[process.platform] ?? 'so';
const LIB = new URL(
  `../../../crates/lenke-core/target/release/liblenke_core.${LIB_EXT}`,
  import.meta.url,
).pathname;
const hasLib = existsSync(LIB);

if (!hasLib) {
  console.warn(`[gql-conformance] skipping: ${LIB} not found — run \`bun run build:rust\`.`);
}

const suite = hasLib ? describe : describe.skip;

// Same ids/labels/properties as the TinkerPop "modern" graph. Property keys are
// authored in NON-sorted insertion order (`name` before `age`, `weight` before
// `since`) precisely so the test proves both engines re-sort them on output.
const MODERN_NDJSON = [
  '{"type":"node","id":"1","labels":["Person"],"properties":{"name":"marko","age":29}}',
  '{"type":"node","id":"2","labels":["Person"],"properties":{"name":"vadas","age":27}}',
  '{"type":"node","id":"4","labels":["Person"],"properties":{"name":"josh","age":32}}',
  '{"type":"node","id":"3","labels":["Software"],"properties":{"name":"lop","lang":"java"}}',
  '{"type":"edge","id":"7","from":"1","to":"2","labels":["KNOWS"],"properties":{"weight":0.5,"since":2018}}',
  '{"type":"edge","id":"8","from":"1","to":"4","labels":["KNOWS"],"properties":{"weight":1.0,"since":2020}}',
  '{"type":"edge","id":"9","from":"1","to":"3","labels":["CREATED"],"properties":{"weight":0.4,"since":2009}}',
].join('\n');

suite('GQL differential: rich RETURN results (TS vs native)', () => {
  const backend = createFfiBackend(LIB);
  const nativeGraph = graphFromFormat(backend, MODERN_NDJSON, 'ndjson');
  const tsGraph = tsDeserialize(MODERN_NDJSON, 'ndjson', new Graph());

  const both = (q: string): [string, string] => [
    JSON.stringify(tsQuery(tsGraph, q)),
    JSON.stringify(nativeGraph.query(q)),
  ];

  test('RETURN n — rich node object, byte-identical, keys sorted', () => {
    const q = `MATCH (n:Person {name: 'marko'}) RETURN n`;
    const [ts, native] = both(q);
    expect(ts).toBe(native);
    expect(ts).toBe(
      `[{"n":{"id":"1","labels":["Person"],"properties":{"age":29,"name":"marko"}}}]`,
    );
  });

  test('RETURN r — rich edge object, byte-identical, keys sorted', () => {
    const q = `MATCH (:Person {name: 'marko'})-[r:KNOWS]->(:Person {name: 'josh'}) RETURN r`;
    const [ts, native] = both(q);
    expect(ts).toBe(native);
    expect(ts).toBe(
      `[{"r":{"id":"8","from":"1","to":"4","labels":["KNOWS"],"properties":{"since":2020,"weight":1}}}]`,
    );
  });

  test('RETURN * — a whole node column serializes richly and identically', () => {
    const [ts, native] = both(`MATCH (n:Person {name: 'vadas'}) RETURN *`);
    expect(ts).toBe(native);
  });

  test('RETURN both endpoints — every element column is rich and identical', () => {
    const q = `MATCH (a:Person {name: 'marko'})-[:CREATED]->(b:Software) RETURN a, b ORDER BY b.name`;
    const [ts, native] = both(q);
    expect(ts).toBe(native);
  });

  test('a scalar projection is unaffected (still a plain value, identical)', () => {
    const [ts, native] = both(`MATCH (n:Person) RETURN n.name AS name ORDER BY name`);
    expect(ts).toBe(native);
    expect(ts).toBe(`[{"name":"josh"},{"name":"marko"},{"name":"vadas"}]`);
  });

  // --- FOR (ISO list unwind / UNWIND) ---------------------------------------

  test('FOR unwinds a literal list identically', () => {
    const [ts, native] = both(`FOR x IN [1, 2, 3] RETURN x`);
    expect(ts).toBe(native);
    expect(ts).toBe(`[{"x":1},{"x":2},{"x":3}]`);
  });

  test('FOR WITH ORDINALITY (1-based) is identical', () => {
    const [ts, native] = both(`FOR x IN ['a', 'b'] WITH ORDINALITY i RETURN x, i`);
    expect(ts).toBe(native);
    expect(ts).toBe(`[{"x":"a","i":1},{"x":"b","i":2}]`);
  });

  test('FOR WITH OFFSET (0-based) is identical', () => {
    const [ts, native] = both(`FOR x IN ['a', 'b'] WITH OFFSET i RETURN x, i`);
    expect(ts).toBe(native);
    expect(ts).toBe(`[{"x":"a","i":0},{"x":"b","i":1}]`);
  });

  test('FOR over null yields no rows on both engines', () => {
    const [ts, native] = both(`FOR x IN null RETURN x`);
    expect(ts).toBe(native);
    expect(ts).toBe(`[]`);
  });

  test('FOR over a scalar unwinds as a singleton, identically', () => {
    const [ts, native] = both(`FOR x IN 5 RETURN x`);
    expect(ts).toBe(native);
    expect(ts).toBe(`[{"x":5}]`);
  });

  test('FOR multiplies a prior MATCH row identically', () => {
    const [ts, native] = both(
      `MATCH (p:Person {name: 'marko'}) FOR t IN ['x', 'y'] RETURN p.name, t`,
    );
    expect(ts).toBe(native);
  });

  test('the FOR list can reference a bound var, identically', () => {
    const [ts, native] = both(`MATCH (p:Person {name: 'marko'}) FOR x IN [p.name, p.age] RETURN x`);
    expect(ts).toBe(native);
    expect(ts).toBe(`[{"x":"marko"},{"x":29}]`);
  });

  test('R-BATCH: FOR drives a batch OPTIONAL MATCH (allow + deny) byte-identically', () => {
    // One row per requested name; josh exists (age 32), nobody does not (null).
    const [ts, native] = both(
      `FOR name IN ['josh', 'nobody'] OPTIONAL MATCH (p:Person {name: name}) RETURN name, p.age`,
    );
    expect(ts).toBe(native);
    expect(ts).toBe(`[{"name":"josh","p.age":32},{"name":"nobody","p.age":null}]`);
  });

  // --- temporal literals + comparison (Phase 1) -----------------------------

  test('a DATE literal serializes to the tagged form byte-identically', () => {
    const [ts, native] = both(`RETURN DATE '2020-02-29' AS d`);
    expect(ts).toBe(native);
    expect(ts).toBe(`[{"d":{"@date":"2020-02-29"}}]`);
  });

  test('a DURATION literal normalizes (years->months) identically', () => {
    const [ts, native] = both(`RETURN DURATION 'P1Y2M3DT4H5M6S' AS d`);
    expect(ts).toBe(native);
    expect(ts).toBe(`[{"d":{"@duration":"P14M3DT14706S"}}]`);
  });

  test('temporal comparison (incl. cross-kind UNKNOWN) is byte-identical', () => {
    const cases: [string, string][] = [
      [`RETURN DATE '2020-01-01' < DATE '2020-06-01' AS x`, `[{"x":true}]`],
      [`RETURN DATE '2020-06-01' < DATE '2020-01-01' AS x`, `[{"x":false}]`],
      [`RETURN DATE '2020-01-01' = DATE '2020-01-01' AS x`, `[{"x":true}]`],
      [
        `RETURN TIMESTAMP '2021-06-15T08:30:00.5' >= DATETIME '2021-06-15T08:30:00' AS x`,
        `[{"x":true}]`,
      ],
      [`RETURN DATE '2020-01-01' < DATETIME '2020-01-01T00:00:00' AS x`, `[{"x":null}]`],
    ];

    for (const [q, want] of cases) {
      const [ts, native] = both(q);
      expect(ts, q).toBe(native);
      expect(ts, q).toBe(want);
    }
  });

  test('ORDER BY over temporal literals sorts chronologically, byte-identical', () => {
    const [ts, native] = both(
      `FOR d IN [DATE '2020-06-01', DATE '2020-01-01', DATE '2020-03-01'] RETURN d ORDER BY d`,
    );
    expect(ts).toBe(native);
    expect(ts).toBe(
      `[{"d":{"@date":"2020-01-01"}},{"d":{"@date":"2020-03-01"}},{"d":{"@date":"2020-06-01"}}]`,
    );
  });

  test('temporal constructor functions are byte-identical', () => {
    const cases: [string, string][] = [
      [`RETURN date('2020-02-29') AS d`, `[{"d":{"@date":"2020-02-29"}}]`],
      [
        `RETURN local_datetime('2021-06-15T08:30:00') AS d`,
        `[{"d":{"@datetime":"2021-06-15T08:30:00"}}]`,
      ],
      [`RETURN duration('P1Y2M') AS d`, `[{"d":{"@duration":"P14M"}}]`],
      [`RETURN date(local_datetime('2020-02-29T13:45:00')) AS d`, `[{"d":{"@date":"2020-02-29"}}]`],
      [`RETURN date('nope') AS d`, `[{"d":null}]`],
      // The point of the function form: convert a runtime string into a temporal.
      [`FOR s IN ['2019-03-15'] RETURN date(s) < DATE '2020-01-01' AS x`, `[{"x":true}]`],
    ];

    for (const [q, want] of cases) {
      const [ts, native] = both(q);
      expect(ts, q).toBe(native);
      expect(ts, q).toBe(want);
    }
  });

  test('as-of WHERE filter over temporal values is byte-identical', () => {
    // Model the as-of over FOR-supplied dates + a WITH…WHERE window: keep the
    // date that falls inside the half-open [from, to) interval.
    const q = `FOR d IN [DATE '2020-06-01', DATE '2021-06-01'] WITH d WHERE DATE '2020-01-01' <= d AND d < DATE '2021-01-01' RETURN d`;
    const [ts, native] = both(q);
    expect(ts).toBe(native);
    expect(ts).toBe(`[{"d":{"@date":"2020-06-01"}}]`);
  });
});

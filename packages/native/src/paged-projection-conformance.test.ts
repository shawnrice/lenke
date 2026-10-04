// Differential conformance for WHICH ROWS GET PROJECTED — TS (@lenke/gql) vs the Rust engine,
// over one NDJSON source, comparing the serialization OR the raised error code.
//
// Why this exists as a fixed-shape test rather than only in the fuzzer: a fast path that skips
// work for rows a query does not emit is observable exactly when a projected expression FAULTS
// on one of those rows. Audit item 145 was that bug — this engine projected every row for an
// `ORDER BY <computed alias> … LIMIT`, so a fallible second item threw on a row it never
// emitted, where native (which keeps the top-k over input bindings) returned rows.
//
// It took a precisely-shaped fixture to see, and item 144 missed it by putting the fault IN the
// sort key, where inlining faults anyway and both engines raise — which reads as agreement. So
// the arrangement below is the point of the file:
//
//   `st` is on v1 and v6 ONLY, so `CAST(n.st AS INTEGER)` faults on exactly those two and is
//   NULL — not a fault — on every other vertex. v1 sorts FIRST by age and v6 LAST, so a SKIP
//   drops the first faulting row and a LIMIT drops the last. A query can therefore fault only
//   on rows it discards, which is the only way to tell the two schedulings apart.
//
// Every fast path items 135-143 added is swept here, each with the fault placed where that path
// might skip it. All 13 shapes AGREE today; the value is that they keep agreeing.
//
// Run: bun test packages/native/src/paged-projection-conformance.test.ts
import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';

import { Graph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { deserialize as tsDeserialize } from '@lenke/serialization';

import { createFfiEngineBackend } from './backend-ffi-engine.js';
import { graphFromNdjson } from './graph.js';

const LIB_EXTENSIONS: Partial<Record<NodeJS.Platform, string>> = { darwin: 'dylib', win32: 'dll' };
const LIB_EXT = LIB_EXTENSIONS[process.platform] ?? 'so';
const ENGINE_LIB = new URL(
  `../../../crates/lenke-engine/target/release/liblenke_engine.${LIB_EXT}`,
  import.meta.url,
).pathname;
const hasLib = existsSync(ENGINE_LIB);

if (!hasLib) {
  console.warn(
    `[paged-projection] skipping: ${ENGINE_LIB} not found — run \`bun run engine:build:rust\`.`,
  );
}

const suite = hasLib ? describe : describe.skip;

const NDJSON = [
  '{"type":"node","id":"v1","labels":["P"],"properties":{"age":1,"st":"nope"}}',
  '{"type":"node","id":"v2","labels":["P"],"properties":{"age":2}}',
  '{"type":"node","id":"v3","labels":["P"],"properties":{"age":3}}',
  '{"type":"node","id":"v4","labels":["P"],"properties":{"age":4}}',
  '{"type":"node","id":"v5","labels":["P"],"properties":{"age":5}}',
  '{"type":"node","id":"v6","labels":["P"],"properties":{"age":6,"st":"nope"}}',
  '{"type":"edge","id":"e1","labels":["T"],"from":"v2","to":"v3","properties":{}}',
  '{"type":"edge","id":"e2","labels":["T"],"from":"v2","to":"v4","properties":{}}',
  // Into v1, whose `st` faults — so a hop can reach a faulting FAR endpoint.
  '{"type":"edge","id":"e3","labels":["T"],"from":"v3","to":"v1","properties":{}}',
].join('\n');

/** `CAST(n.st AS INTEGER)` — null on most vertices, a data exception on v1 and v6. */
const BAD = 'CAST(n.st AS INTEGER)';
const BAD_X = 'CAST(x.st AS INTEGER)';

suite('GQL differential: which rows get projected (TS vs native)', () => {
  const backend = createFfiEngineBackend(ENGINE_LIB);
  const nativeGraph = graphFromNdjson(backend, NDJSON);
  const tsGraph = tsDeserialize(NDJSON, 'ndjson', new Graph());

  /** The serialization, or `RAISED <code>` — so a divergence in RAISING shows up too. */
  const outcome = (f: () => unknown): string => {
    try {
      return JSON.stringify(f());
    } catch (e) {
      return `RAISED ${(e as { code?: string }).code ?? 'unknown'}`;
    }
  };

  const both = (q: string): [string, string] => [
    outcome(() => tsQuery(tsGraph, q)),
    outcome(() => nativeGraph.query(q)),
  ];

  test('ORDER BY + LIMIT does not project the discarded rows — item 145', () => {
    // The regression. `n.age + 0` is a COMPUTED alias, so it is the substitution under test;
    // ascending order with SKIP 2 LIMIT 2 emits ages 3 and 4, discarding BOTH faulting rows.
    const q = `MATCH (n:P) RETURN ${BAD} AS b, n.age + 0 AS a ORDER BY a SKIP 2 LIMIT 2`;
    const [ts, nat] = both(q);

    expect(ts).toBe(nat);
    expect(ts).toBe(
      JSON.stringify([
        { b: null, a: 3 },
        { b: null, a: 4 },
      ]),
    );
  });

  test('an UNBOUNDED SKIP still projects everything, in both engines', () => {
    // The boundary: native's late-materialize fires for a bounded top-k, not for a SKIP with
    // no LIMIT — the tail is unbounded, so every row is a candidate. Both raise, and pinning
    // that is what stops a future "optimization" from quietly diverging on one side.
    for (const q of [
      `MATCH (n:P) RETURN ${BAD} AS b, n.age AS a ORDER BY a SKIP 2`,
      `MATCH (n:P) RETURN ${BAD} AS b, n.age AS a ORDER BY a DESC SKIP 2`,
    ]) {
      const [ts, nat] = both(q);

      expect(ts).toBe(nat);
      expect(ts).toBe('RAISED E_INVALID_VALUE');
    }
  });

  test('paging with NO order projects everything, in both engines', () => {
    // Item 144 established this and then nearly optimized it away: with no ORDER BY the rows a
    // SKIP drops are still projected, in BOTH engines, so moving the paging ahead of the
    // projection would have changed which queries raise.
    for (const q of [
      `MATCH (n:P) RETURN ${BAD} AS b, n.age AS a SKIP 2`,
      `MATCH (n:P) RETURN ${BAD} AS b, n.age AS a LIMIT 2`,
    ]) {
      const [ts, nat] = both(q);

      expect(ts).toBe(nat);
      expect(ts).toBe('RAISED E_INVALID_VALUE');
    }
  });

  test('a faulting SORT KEY raises however the projection is scheduled', () => {
    // The case item 144 mistook for agreement: when the fault IS the key it is evaluated for
    // every row either way, so both engines raise and the shape proves nothing about
    // scheduling. Kept precisely so the distinction stays documented.
    const [ts, nat] = both(`MATCH (n:P) RETURN ${BAD} AS a ORDER BY a LIMIT 2`);

    expect(ts).toBe(nat);
    expect(ts).toBe('RAISED E_INVALID_VALUE');
  });

  test('every fast path from items 135-143 agrees with native on raising', () => {
    // Each of these evaluates the fallible expression once per ELEMENT, exactly as the general
    // path does — so each must raise, and must raise in both. A tally or walk that stopped
    // evaluating it for an element the general path visits would show up here.
    const shapes: [string, string][] = [
      ['DISTINCT walk (143)', `MATCH (n:P) RETURN DISTINCT ${BAD} AS b`],
      ['fused hop projection (138)', `MATCH (a:P)-[:T]->(x) RETURN ${BAD_X} AS b`],
      ['grouped node tally (141)', `MATCH (n:P) RETURN ${BAD} AS b, count(*) AS c`],
      ['grouped hop tally (142)', `MATCH (a:P)-[:T]->(x) RETURN ${BAD_X} AS b, count(*) AS c`],
      ['filtered node count (135)', `MATCH (n:P) WHERE ${BAD} > 0 RETURN count(*) AS c`],
      ['far-hop walk (137)', `MATCH (a:P)-[:T]->(x) WHERE ${BAD_X} > 0 RETURN count(*) AS c`],
    ];

    for (const [name, q] of shapes) {
      const [ts, nat] = both(q);

      expect(ts, name).toBe(nat);
      expect(ts, name).toBe('RAISED E_INVALID_VALUE');
    }
  });

  test('the product count evaluates no per-row expression, and agrees', () => {
    // The one shape with nothing to fault: a cartesian `count(*)` reads bucket sizes. Included
    // so the sweep covers the whole family rather than only the faulting half.
    const [ts, nat] = both('MATCH (a:P), (b:P) RETURN count(*) AS c');

    expect(ts).toBe(nat);
    expect(ts).toBe(JSON.stringify([{ c: 36 }]));
  });
});

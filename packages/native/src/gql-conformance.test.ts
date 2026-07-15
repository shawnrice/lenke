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

import { Graph, parseDate, parseDateTime } from '@lenke/core';
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

  const both = (q: string, params?: Record<string, unknown>): [string, string] => [
    JSON.stringify(tsQuery(tsGraph, q, params)),
    JSON.stringify(nativeGraph.query(q, params)),
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

  // --- ANY SHORTEST: the path value serializes byte-identically across engines.
  test('RETURN p — a shortest Path is {vertices, edges, length}, byte-identical', () => {
    const q = `MATCH p = ANY SHORTEST (a)-[]->*(b) WHERE a.name = 'marko' AND b.name = 'lop' RETURN p`;
    const [ts, native] = both(q);
    expect(ts).toBe(native);
    expect(ts).toBe(
      `[{"p":{"vertices":[` +
        `{"id":"1","labels":["Person"],"properties":{"age":29,"name":"marko"}},` +
        `{"id":"3","labels":["Software"],"properties":{"lang":"java","name":"lop"}}` +
        `],"edges":[` +
        `{"id":"9","from":"1","to":"3","labels":["CREATED"],"properties":{"since":2009,"weight":0.4}}` +
        `],"length":1}}]`,
    );
  });

  test('ANY SHORTEST endpoint set + per-endpoint path, identical under ORDER BY', () => {
    const [ts, native] = both(
      `MATCH p = ANY SHORTEST (a)-[]->*(b) WHERE a.name = 'marko' RETURN b.name AS n, p ORDER BY n`,
    );
    expect(ts).toBe(native);
  });

  test('named procedure CALL (algorithms) is byte-identical across engines', () => {
    // `node` is a live vertex handle; `node.name` reads its property.
    const [tsD, natD] = both(
      'CALL degree() YIELD node, degree RETURN node.name AS n, degree ORDER BY n',
    );
    expect(tsD).toBe(natD);

    // pagerank scores (f64) through the CALL surface, ordered deterministically.
    const [tsP, natP] = both(
      'CALL pagerank() YIELD node, score RETURN node.name AS n, score ORDER BY score DESC, n',
    );
    expect(tsP).toBe(natP);

    // YIELD aliasing + WITH…WHERE filtering.
    const [tsF, natF] = both(
      'CALL degree() YIELD node AS v, degree AS d WITH v, d WHERE d >= 2 RETURN v.name AS n ORDER BY n',
    );
    expect(tsF).toBe(natF);

    // Returning the whole node hydrates the rich {id,labels,properties} map —
    // byte-identical across engines, exactly like `MATCH (n) RETURN n`.
    const [tsN, natN] = both('CALL degree() YIELD node RETURN node ORDER BY node.name LIMIT 2');
    expect(tsN).toBe(natN);
  });

  test('inline subquery CALL (correlated lateral join) is byte-identical', () => {
    // Per-person created-count via a correlated subquery.
    const [tsC, natC] = both(
      `MATCH (p:Person) ` +
        `CALL (p) { MATCH (p)-[:CREATED]->(w) RETURN count(w) AS created } ` +
        `RETURN p.name AS name, created ORDER BY name`,
    );
    expect(tsC).toBe(natC);

    // Row duplication (marko's KNOWS neighbours) via the subquery.
    const [tsD, natD] = both(
      `MATCH (p:Person {name: 'marko'}) ` +
        `CALL (p) { MATCH (p)-[:KNOWS]->(f) RETURN f.name AS friend } ` +
        `RETURN friend ORDER BY friend`,
    );
    expect(tsD).toBe(natD);

    // Scope isolation: `()` imports nothing, so the inner MATCH is unbound.
    const [tsS, natS] = both(
      `MATCH (p:Person {name: 'marko'}) ` +
        `CALL () { MATCH (n) RETURN count(n) AS total } RETURN total`,
    );
    expect(tsS).toBe(natS);

    // Non-agg subquery over MULTIPLE start vertices (native decorrelates this to a
    // flat join; TS runs it correlated) — the outputs must still match exactly.
    const [tsM, natM] = both(
      `MATCH (p:Person) ` +
        `CALL (p) { MATCH (p)-[:CREATED]->(w) RETURN w.name AS thing } ` +
        `RETURN p.name AS pn, thing ORDER BY pn, thing`,
    );
    expect(tsM).toBe(natM);
  });

  test('ISO path functions on a bound path are byte-identical', () => {
    const q =
      `MATCH p = ANY SHORTEST (a)-[]->*(b) WHERE a.name = 'marko' AND b.name = 'lop' ` +
      `RETURN path_length(p) AS len, length(p) AS len2, ` +
      `nodes(p) AS ns, relationships(p) AS es, elements(p) AS el`;
    const [ts, native] = both(q);
    expect(ts).toBe(native);
    // Length is the hop count; nodes/edges/elements are rich element lists.
    expect(ts).toBe(
      `[{"len":1,"len2":1,` +
        `"ns":[` +
        `{"id":"1","labels":["Person"],"properties":{"age":29,"name":"marko"}},` +
        `{"id":"3","labels":["Software"],"properties":{"lang":"java","name":"lop"}}],` +
        `"es":[{"id":"9","from":"1","to":"3","labels":["CREATED"],"properties":{"since":2009,"weight":0.4}}],` +
        `"el":[` +
        `{"id":"1","labels":["Person"],"properties":{"age":29,"name":"marko"}},` +
        `{"id":"9","from":"1","to":"3","labels":["CREATED"],"properties":{"since":2009,"weight":0.4}},` +
        `{"id":"3","labels":["Software"],"properties":{"lang":"java","name":"lop"}}]}]`,
    );
  });

  // --- var-length {1,2} count: native uses a degree-product fast path, TS
  // enumerates trails. They must agree, including with parallel edges + self-loops
  // (which the degree product would double-count without the correction). -------
  test('var-length {1,2} count matches trail enumeration (TS vs native)', () => {
    const VARLEN_NDJSON = [
      '{"type":"node","id":"a","labels":["Person","VIP"],"properties":{}}',
      '{"type":"node","id":"b","labels":["Person"],"properties":{}}',
      '{"type":"node","id":"c","labels":["Person"],"properties":{}}',
      '{"type":"edge","id":"e0","from":"a","to":"b","labels":["KNOWS"],"properties":{}}',
      '{"type":"edge","id":"e1","from":"a","to":"b","labels":["KNOWS"],"properties":{}}',
      '{"type":"edge","id":"e2","from":"b","to":"c","labels":["KNOWS"],"properties":{}}',
      '{"type":"edge","id":"e3","from":"b","to":"b","labels":["KNOWS"],"properties":{}}',
      '{"type":"edge","id":"e4","from":"a","to":"a","labels":["KNOWS"],"properties":{}}',
      '{"type":"edge","id":"e5","from":"c","to":"a","labels":["KNOWS"],"properties":{}}',
    ].join('\n');
    const nat = graphFromFormat(backend, VARLEN_NDJSON, 'ndjson');
    const ts = tsDeserialize(VARLEN_NDJSON, 'ndjson', new Graph());

    for (const q of [
      `MATCH (x)-[:KNOWS]->{1,2}(y) RETURN count(*) AS c`,
      `MATCH (x:VIP)-[:KNOWS]->{1,2}(y) RETURN count(*) AS c`,
    ]) {
      expect(JSON.stringify(nat.query(q)), q).toBe(JSON.stringify(tsQuery(ts, q)));
    }
  });

  // --- correlated EXISTS count: native uses a reverse semi-join (seed the selective
  // inner endpoint), TS tests every outer row. They must agree. Software (1 vertex)
  // is more selective than Person, so the fast path fires. ---------------------
  test('EXISTS / NOT EXISTS count matches per-row evaluation (TS vs native)', () => {
    for (const q of [
      `MATCH (a:Person) WHERE EXISTS { (a)-[:CREATED]->(:Software) } RETURN count(*) AS c`,
      `MATCH (a:Person) WHERE NOT EXISTS { (a)-[:CREATED]->(:Software) } RETURN count(*) AS c`,
    ]) {
      expect(JSON.stringify(nativeGraph.query(q)), q).toBe(JSON.stringify(tsQuery(tsGraph, q)));
    }
  });

  // --- count(DISTINCT endpoint): native marks a reachable frontier, TS enumerates
  // then dedups. Same reachable-set size. --------------------------------------
  test('count(DISTINCT endpoint) matches enumerated dedup (TS vs native)', () => {
    for (const q of [
      `MATCH (a:Person)-[:KNOWS]->(b) RETURN count(DISTINCT b) AS c`,
      `MATCH (a:Person)-[:CREATED]->(b:Software) RETURN count(DISTINCT b) AS c`,
      `MATCH (a:Person)-[:KNOWS]->()-[:CREATED]->(c) RETURN count(DISTINCT c) AS c`,
    ]) {
      expect(JSON.stringify(nativeGraph.query(q)), q).toBe(JSON.stringify(tsQuery(tsGraph, q)));
    }
  });

  // --- percentile_cont / percentile_disc: ISO ordered-set aggregates, newly
  // implemented in both engines — must compute byte-identically. ---------------
  test('percentile_cont / percentile_disc agree (TS vs native)', () => {
    for (const q of [
      `MATCH (n:Person) RETURN percentile_cont(n.age, 0.5) AS x`,
      `MATCH (n:Person) RETURN percentile_disc(n.age, 0.5) AS x`,
      `MATCH (n:Person) RETURN percentile_cont(n.age, 0.9) AS x, percentile_disc(n.age, 0.9) AS y`,
      `MATCH (n:Person) RETURN percentile_cont(n.age, 0.0) AS lo, percentile_cont(n.age, 1.0) AS hi`,
    ]) {
      expect(JSON.stringify(nativeGraph.query(q)), q).toBe(JSON.stringify(tsQuery(tsGraph, q)));
    }
  });

  // --- COUNT { } degree: native takes an adjacency-count fast path, TS enumerates
  // the sub-pattern. Same per-row count. ---------------------------------------
  test('COUNT { } single-segment degree matches enumeration (TS vs native)', () => {
    for (const q of [
      `MATCH (a:Person) RETURN a.name AS name, COUNT { (a)-[:KNOWS]->() } AS deg ORDER BY name`,
      `MATCH (a:Person) RETURN a.name AS name, COUNT { (a)-[:CREATED]->(:Software) } AS d ORDER BY name`,
      `MATCH (a:Person) RETURN a.name AS name, COUNT { (a)<-[:KNOWS]-() } AS indeg ORDER BY name`,
      // reverse degree — the correlated node is the endpoint (native anchors there)
      `MATCH (s:Software) RETURN s.name AS name, COUNT { (:Person)-[:CREATED]->(s) } AS pop ORDER BY name`,
      `MATCH (a:Person) RETURN a.name AS name, COUNT { (b)-[:KNOWS]->(a) } AS indeg ORDER BY name`,
    ]) {
      expect(JSON.stringify(nativeGraph.query(q)), q).toBe(JSON.stringify(tsQuery(tsGraph, q)));
    }
  });

  // --- unbounded var-length + DISTINCT: native BFSes the reachable set, TS
  // enumerates trails then dedups. On a small graph (enumeration completes) they
  // must agree — including ->+ vs ->* seed inclusion and a cycle. -------------
  test('unbounded var-length DISTINCT matches trail enumeration (TS vs native)', () => {
    const REACH_NDJSON = [
      '{"type":"node","id":"s0","labels":["Node"],"properties":{"name":"s0"}}',
      '{"type":"node","id":"a1","labels":["Node"],"properties":{"name":"a1"}}',
      '{"type":"node","id":"a2","labels":["Node"],"properties":{"name":"a2"}}',
      '{"type":"node","id":"t3","labels":["Node","Target"],"properties":{"name":"t3"}}',
      '{"type":"edge","id":"r1","from":"s0","to":"a1","labels":["R"],"properties":{}}',
      '{"type":"edge","id":"r2","from":"a1","to":"a2","labels":["R"],"properties":{}}',
      '{"type":"edge","id":"r3","from":"a2","to":"a1","labels":["R"],"properties":{}}',
      '{"type":"edge","id":"r4","from":"a2","to":"t3","labels":["R"],"properties":{}}',
    ].join('\n');
    const nat = graphFromFormat(backend, REACH_NDJSON, 'ndjson');
    const ts = tsDeserialize(REACH_NDJSON, 'ndjson', new Graph());

    // DISTINCT rows with no ORDER BY are a set — the native BFS and TS enumeration
    // legitimately differ in row order, so compare the sorted name sets.
    const names = (rowset: Array<{ n: string }>): string[] => rowset.map((r) => r.n).sort();

    for (const q of [
      `MATCH (a:Node {name: 's0'})-[:R]->+(b) RETURN DISTINCT b.name AS n`,
      `MATCH (a:Node {name: 's0'})-[:R]->*(b) RETURN DISTINCT b.name AS n`,
      `MATCH (a:Node {name: 's0'})-[:R]->+(b:Target) RETURN DISTINCT b.name AS n`,
    ]) {
      expect(names(nat.query(q)), q).toEqual(names(tsQuery(ts, q)));
    }

    // count(DISTINCT) is a single deterministic value.
    const cq = `MATCH (a:Node {name: 's0'})-[:R]->+(b) RETURN count(DISTINCT b) AS c`;
    expect(JSON.stringify(nat.query(cq)), cq).toBe(JSON.stringify(tsQuery(ts, cq)));

    // EXISTS { reachability }: both engines BFS (was: trail enumeration, faulted on
    // an unreachable target). Reachable t3, unreachable 'nope', endpoint WHERE.
    for (const q of [
      `MATCH (a:Node {name: 's0'}) RETURN EXISTS { (a)-[:R]->+(b:Target) } AS r`,
      `MATCH (a:Node {name: 's0'}) RETURN EXISTS { (a)-[:R]->+(b:Node {name: 'nope'}) } AS r`,
      `MATCH (a:Node {name: 's0'}) RETURN EXISTS { (a)-[:R]->+(b) WHERE b.name = 'a2' } AS r`,
    ]) {
      expect(JSON.stringify(nat.query(q)), q).toBe(JSON.stringify(tsQuery(ts, q)));
    }
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

  test('duration_between returns the exact span, byte-identical', () => {
    const cases: [string, string][] = [
      // Two dates → whole days (96 days from Jan 15 to Apr 20, 2020).
      [
        `RETURN duration_between(DATE '2020-01-15', DATE '2020-04-20') AS d`,
        `[{"d":{"@duration":"P96D"}}]`,
      ],
      // Two datetimes → seconds (1h 1m 1s = 3661s), no month/day rollup.
      [
        `RETURN duration_between(DATETIME '2020-01-01T00:00:00', DATETIME '2020-01-01T01:01:01') AS d`,
        `[{"d":{"@duration":"PT3661S"}}]`,
      ],
      // Cross-kind → UNKNOWN (null).
      [
        `RETURN duration_between(DATE '2020-01-01', DATETIME '2020-01-01T00:00:00') AS d`,
        `[{"d":null}]`,
      ],
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

  test('temporal arithmetic is byte-identical', () => {
    const cases: [string, string][] = [
      [`RETURN DATE '2020-01-31' + DURATION 'P1M' AS d`, `[{"d":{"@date":"2020-02-29"}}]`],
      [`RETURN DATE '2021-01-31' + DURATION 'P1M' AS d`, `[{"d":{"@date":"2021-02-28"}}]`],
      [`RETURN DATE '2020-01-15' + DURATION 'P2M3D' AS d`, `[{"d":{"@date":"2020-03-18"}}]`],
      [
        `RETURN DATETIME '2020-01-01T10:00:00' + DURATION 'PT1H30M' AS d`,
        `[{"d":{"@datetime":"2020-01-01T11:30:00"}}]`,
      ],
      [`RETURN DATE '2020-03-18' - DURATION 'P2M3D' AS d`, `[{"d":{"@date":"2020-01-15"}}]`],
      [`RETURN DATE '2020-04-20' - DATE '2020-01-15' AS d`, `[{"d":{"@duration":"P96D"}}]`],
      [`RETURN DURATION 'P1M' + DURATION 'P2D' AS d`, `[{"d":{"@duration":"P1M2D"}}]`],
      [`RETURN DURATION 'P1M2DT3S' * 3 AS d`, `[{"d":{"@duration":"P3M6DT9S"}}]`],
      // A non-integer multiplier is invalid (a calendar duration has no
      // fractional multiple) → null on both engines, never a truncated value.
      [`RETURN DURATION 'P10D' * 1.5 AS d`, `[{"d":null}]`],
      [`RETURN DURATION 'P10D' * 2 AS d`, `[{"d":{"@duration":"P20D"}}]`],
      [`RETURN 0.5 * DURATION 'P10D' AS d`, `[{"d":null}]`],
    ];

    for (const [q, want] of cases) {
      const [ts, native] = both(q);

      expect(ts, q).toBe(native);
      expect(ts, q).toBe(want);
    }
  });

  test('current_* read an injected now byte-identically (engine stays pure)', () => {
    // A FIXED `now` is handed to BOTH engines (via the reserved $__now param), so
    // the non-deterministic functions become deterministic and byte-identical.
    const now = { __now: parseDateTime('2026-07-12T10:30:45') };

    for (const [q, want] of [
      [`RETURN current_timestamp AS t`, `[{"t":{"@datetime":"2026-07-12T10:30:45"}}]`],
      [`RETURN local_timestamp AS t`, `[{"t":{"@datetime":"2026-07-12T10:30:45"}}]`],
      [`RETURN current_date AS d`, `[{"d":{"@date":"2026-07-12"}}]`],
    ] as [string, string][]) {
      const [ts, native] = both(q, now);
      expect(ts, q).toBe(native);
      expect(ts, q).toBe(want);
    }

    // Without an injected now, both engines return null (no clock read).
    const [ts0, native0] = both(`RETURN current_date AS d`);
    expect(ts0).toBe(native0);
    expect(ts0).toBe(`[{"d":null}]`);
  });

  test('current_timestamp coerces a DATE $__now to a DATETIME, byte-identically', () => {
    // A DATE `$__now` must not leak a DATE out of `current_timestamp` — the
    // datetime now-functions wrap in local_datetime(), coercing to midnight.
    const dateNow = { __now: parseDate('2026-07-12') };

    for (const [q, want] of [
      [`RETURN current_timestamp AS t`, `[{"t":{"@datetime":"2026-07-12T00:00:00"}}]`],
      [`RETURN current_date AS d`, `[{"d":{"@date":"2026-07-12"}}]`],
    ] as [string, string][]) {
      const [ts, native] = both(q, dateNow);
      expect(ts, q).toBe(native);
      expect(ts, q).toBe(want);
    }
  });

  test('UTF-16 slices (substring/left/right) across a surrogate pair are byte-identical', () => {
    // A slice can cut an astral pair; a lone surrogate must render U+FFFD on
    // BOTH engines (the native UTF-8 string cannot carry a lone surrogate).
    for (const q of [
      `RETURN substring('Rocket 🚀 go', 8, 1) AS s`,
      `RETURN substring('🚀🚀', 1, 1) AS s`,
      `RETURN left('🚀ab', 1) AS s`,
      `RETURN right('ab🚀', 1) AS s`,
    ]) {
      const [ts, native] = both(q);
      expect(ts, q).toBe(native);
    }
  });
});

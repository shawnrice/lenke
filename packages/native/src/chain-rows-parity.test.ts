// Byte-identity for the ROW-PROJECTING THREE-HOP CHAIN, which NO fuzzer generates (item 1816).
//
// ⚠️ WHY THIS FILE EXISTS RATHER THAN A FUZZER SEED, AND HOW THE GAP WAS FOUND. Item 1814 shipped
// `detectChainProjection` — the rung that answers `MATCH (a)-[:E]->(b)-[:E]->(c)-[:E]->(d) RETURN
// d.k` — and recorded `bun run fuzz` green with `chain3=57/34/55` as evidence that the family had
// cross-engine coverage. ⚠️ **THAT WAS WRONG, AND IT WAS WRONG IN THE WAY THIS REPO HAS BEEN WRONG
// BEFORE.** Every `chain3` shape in `differential-fuzz` ends in `RETURN count(*)`, and the rung
// DECLINES an aggregating projection outright, so the counter was measuring the degree-product and
// var-length-count routes while the row rung had no cross-engine coverage at all.
//
// The proof is a deletion test, not a reading: injecting a `throw` at the first statement of the
// row walk and re-running `bun run fuzz differential` still PASSED. A green sweep over a shape
// nobody generates is the failure mode CLAUDE.md names — "a generative test whose teeth were never
// verified is worse than no test, because it is believed" — and it is the same shape as item 1582's
// one-column grouped count, which is why this file follows that one's form. Item 1728's dedicated
// astral-ordering parity test is the other precedent: close the gap with an explicit corpus rather
// than by widening a fuzzer band, because a band's share is a probability and an explicit query is
// not. (Widening the band was tried first and the shapes were never sampled.)
//
// ⚠️ THE CORPUS COVERS BOTH WALKS, because item 1816 gave the rung two and the split is invisible
// to any correctness test:
//
//     FAR-END-ONLY   the blocked level-synchronous sweep — batches a level, so it CANNOT
//                    reconstruct the path that reached each vertex
//     INTERIOR READ  the depth-first descent — the only walk that still has the path
//
// A corpus with only the first would leave the descent uncovered here and only the second would
// leave the sweep uncovered, so every question below is asked in both spellings.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { deserialize as tsDeserialize } from '@lenke/serialization';

import { columnOrderOf, nativeBackend, nativeReady } from './conformance-harness.js';
import { graphFromNdjson } from './graph.js';

// A fixture with BRANCHING, so row multiplicity is not 1 and a walk that loses a copy is visible —
// and deliberately NOT the functional `(a*k+b) % N` shape CLAUDE.md warns about (items 1516/1518),
// whose fanout collapses onto one target and makes a k-hop count right by construction.
//
// Four levels deep so a FOUR-segment chain has somewhere to go: item 1814's own test fixture was
// three deep and its four-segment case silently compared two EMPTY results.
//
// ⚠️ Edge ids are `r*` and vertex ids `v*` with no overlap: an edge sharing a vertex's id SILENTLY
// DESTROYS that vertex's labels and properties (item 1588, WON'T FIX — one id-keyed map across two
// id spaces), which cost item 1814 nine tests before the ids were separated.
const NDJSON = [
  '{"type":"node","id":"v1","labels":["P"],"properties":{"k":1,"s":"a"}}',
  '{"type":"node","id":"v2","labels":["P"],"properties":{"k":2,"s":"b"}}',
  '{"type":"node","id":"v3","labels":["P","Q"],"properties":{"k":3,"s":"a"}}',
  '{"type":"node","id":"v4","labels":["P"],"properties":{"k":4,"s":"c"}}',
  '{"type":"node","id":"v5","labels":["P"],"properties":{"k":5,"s":"b"}}',
  '{"type":"node","id":"v6","labels":["P","Q"],"properties":{"k":6,"s":"a"}}',
  '{"type":"node","id":"v7","labels":["P"],"properties":{"k":7,"s":"c"}}',
  '{"type":"node","id":"v8","labels":["P"],"properties":{"k":8,"s":"b"}}',
  // A vertex with NO `k` at all, so a predicate over it is UNKNOWN and the row must DROP like
  // FALSE rather than survive — the three-valued arm, which both walks evaluate at the deepest
  // level and which a walk testing truthiness instead of `=== true` would get wrong.
  '{"type":"node","id":"v9","labels":["P"],"properties":{"s":"d"}}',
  '{"type":"edge","id":"r1","labels":["E"],"from":"v1","to":"v2","properties":{}}',
  '{"type":"edge","id":"r2","labels":["E"],"from":"v1","to":"v3","properties":{}}',
  '{"type":"edge","id":"r3","labels":["E"],"from":"v2","to":"v4","properties":{}}',
  '{"type":"edge","id":"r4","labels":["E"],"from":"v2","to":"v5","properties":{}}',
  '{"type":"edge","id":"r5","labels":["E"],"from":"v3","to":"v5","properties":{}}',
  '{"type":"edge","id":"r6","labels":["E"],"from":"v4","to":"v6","properties":{}}',
  '{"type":"edge","id":"r7","labels":["E"],"from":"v4","to":"v7","properties":{}}',
  '{"type":"edge","id":"r8","labels":["E"],"from":"v5","to":"v7","properties":{}}',
  '{"type":"edge","id":"r9","labels":["E"],"from":"v5","to":"v8","properties":{}}',
  '{"type":"edge","id":"r10","labels":["E"],"from":"v6","to":"v9","properties":{}}',
  '{"type":"edge","id":"r11","labels":["E"],"from":"v7","to":"v9","properties":{}}',
  // A SECOND edge type, so a chain over `F` exercises a leg whose bucket is a different map entry
  // and a type UNION declines the rung to the general matcher.
  '{"type":"edge","id":"r12","labels":["F"],"from":"v1","to":"v4","properties":{}}',
  '{"type":"edge","id":"r13","labels":["F"],"from":"v4","to":"v8","properties":{}}',
  '{"type":"edge","id":"r14","labels":["F"],"from":"v8","to":"v9","properties":{}}',
  // A SELF-LOOP at depth, which is where path mode stops being academic: the default walk mode
  // admits a repeated vertex and `-[:E]-` would visit this from both ends.
  '{"type":"edge","id":"r15","labels":["E"],"from":"v9","to":"v9","properties":{}}',
].join('\n');

const suite = nativeReady ? describe : describe.skip;

suite('row-projecting chain: TS vs native', () => {
  const backend = nativeBackend();
  const nativeGraph = graphFromNdjson(backend, NDJSON);
  const tsGraph = tsDeserialize(NDJSON, 'ndjson', new Graph());

  const QUERIES = [
    // ---- FAR-END-ONLY: the blocked level-synchronous sweep ----
    'MATCH (a:P)-[:E]->(b:P)-[:E]->(c:P)-[:E]->(d:P) RETURN d.k AS k',
    'MATCH (a:P)-[:E]->(b:P)-[:E]->(c:P)-[:E]->(d:P) RETURN d.k AS k, d.s AS s',
    // The whole ELEMENT rather than a property, so the row carries a vertex and not a scalar.
    'MATCH (a:P)-[:E]->(b:P)-[:E]->(c:P)-[:E]->(d:P) RETURN d AS d',
    // A carried WHERE over the far end, which both walks evaluate at the DEEPEST level.
    'MATCH (a:P)-[:E]->(b:P)-[:E]->(c:P)-[:E]->(d:P) WHERE d.k > 5 RETURN d.k AS k',
    // ⚠️ The UNKNOWN arm: `v9` has no `k`, so this comparison is UNKNOWN and the row must drop.
    'MATCH (a:P)-[:E]->(b:P)-[:E]->(c:P)-[:E]->(d:P) WHERE d.k > 0 RETURN d.s AS s',
    // FOUR segments, so the recursion and the block loop both run one level deeper.
    'MATCH (a:P)-[:E]->(b:P)-[:E]->(c:P)-[:E]->(d:P)-[:E]->(e:P) RETURN e.k AS k',
    // An INWARD chain, so the walk reads `adjTo` and resolves `e.from` at every level.
    'MATCH (a:P)<-[:E]-(b:P)<-[:E]-(c:P)<-[:E]-(d:P) RETURN d.k AS k',
    // A MIXED chain, which no single-direction fast path can answer by symmetry.
    'MATCH (a:P)-[:E]->(b:P)<-[:E]-(c:P)-[:E]->(d:P) RETURN d.k AS k',
    // A LABEL at an interior position that only some vertices carry, so levels prune.
    'MATCH (a:P)-[:E]->(b:Q)-[:E]->(c:P)-[:E]->(d:P) RETURN d.k AS k',
    // The far end labelled where the label is selective.
    'MATCH (a:P)-[:E]->(b:P)-[:E]->(c:P)-[:E]->(d:Q) RETURN d.k AS k',
    // The SECOND edge type, a different bucket entirely.
    'MATCH (a:P)-[:F]->(b:P)-[:F]->(c:P)-[:F]->(d:P) RETURN d.k AS k',
    // A leg type NO edge carries, so every level is empty and the answer is no rows.
    'MATCH (a:P)-[:ABSENT]->(b:P)-[:E]->(c:P)-[:E]->(d:P) RETURN d.k AS k',
    // UNLABELLED nodes, so the scan is every vertex and no level prunes.
    'MATCH (a)-[:E]->(b)-[:E]->(c)-[:E]->(d) RETURN d.k AS k',

    // ---- INTERIOR READS: the depth-first descent ----
    // ⚠️ THE CASE THE SWEEP CANNOT ANSWER. Batching a level discards the path, so these MUST route
    // to the descent; if the gate ever admitted them the rows would be WRONG rather than slow, and
    // that is a byte-identity failure rather than a perf one.
    'MATCH (a:P)-[:E]->(b:P)-[:E]->(c:P)-[:E]->(d:P) RETURN b.k AS bk, d.k AS k',
    'MATCH (a:P)-[:E]->(b:P)-[:E]->(c:P)-[:E]->(d:P) RETURN a.k AS ak, d.k AS k',
    'MATCH (a:P)-[:E]->(b:P)-[:E]->(c:P)-[:E]->(d:P) RETURN c.k AS ck',
    'MATCH (a:P)-[:E]->(b:P)-[:E]->(c:P)-[:E]->(d:P) RETURN a.k AS ak, b.k AS bk, c.k AS ck, d.k AS k',
    // A carried WHERE over an INTERIOR position, which is the other half of the same boundary.
    'MATCH (a:P)-[:E]->(b:P)-[:E]->(c:P)-[:E]->(d:P) WHERE c.k > 4 RETURN d.k AS k',
    'MATCH (a:P)-[:E]->(b:P)-[:E]->(c:P)-[:E]->(d:P) WHERE b.k = 2 RETURN d.k AS k',
    // Interior WHERE and interior projection together.
    'MATCH (a:P)-[:E]->(b:P)-[:E]->(c:P)-[:E]->(d:P) WHERE b.k = 2 RETURN b.k AS bk, d.k AS k',

    // ---- SHAPES THE RUNG DECLINES, pinned because declining has to mean agreeing anyway ----
    // An UNDIRECTED leg: `both` visits a self-loop from both ends, so it declines in every design.
    'MATCH (a:P)-[:E]-(b:P)-[:E]-(c:P)-[:E]-(d:P) RETURN d.k AS k',
    // A relationship VARIABLE, which is also this family's in-engine differential oracle: with `r*`
    // unread it means exactly what the elided spelling means, and it declines to the general matcher.
    'MATCH (a:P)-[r1:E]->(b:P)-[r2:E]->(c:P)-[r3:E]->(d:P) RETURN d.k AS k',
    // A type UNION, refused because the rung takes one named type per leg.
    'MATCH (a:P)-[:E|F]->(b:P)-[:E|F]->(c:P)-[:E|F]->(d:P) RETURN d.k AS k',
    // PAGING and ORDER BY, which `plainRowProjection` declines — and a bare LIMIT is the one case
    // where row order decides WHICH rows survive, so the general path must answer it.
    'MATCH (a:P)-[:E]->(b:P)-[:E]->(c:P)-[:E]->(d:P) RETURN d.k AS k ORDER BY k',
    'MATCH (a:P)-[:E]->(b:P)-[:E]->(c:P)-[:E]->(d:P) RETURN d.k AS k ORDER BY k LIMIT 3',
    'MATCH (a:P)-[:E]->(b:P)-[:E]->(c:P)-[:E]->(d:P) RETURN DISTINCT d.k AS k',
    // An AGGREGATE, the shape the fuzzer's `chain3` counter was actually measuring all along.
    'MATCH (a:P)-[:E]->(b:P)-[:E]->(c:P)-[:E]->(d:P) RETURN count(*) AS c',
    // A PATH VARIABLE that is READ, which declines; the unread twin is elided before any detector
    // runs and is admitted, so both are here.
    'MATCH p = (a:P)-[:E]->(b:P)-[:E]->(c:P)-[:E]->(d:P) RETURN nodes(p) AS ns',
    'MATCH p = (a:P)-[:E]->(b:P)-[:E]->(c:P)-[:E]->(d:P) RETURN d.k AS k',
  ];

  for (const q of QUERIES) {
    test(q, () => {
      const ts = tsQuery(tsGraph, q) as Array<Record<string, unknown>>;
      const nat = nativeGraph.query(q) as Array<Record<string, unknown>>;

      // ⚠️ Rows as MULTISETS, because unordered row order is unspecified here and deliberately so
      // (item 198) — but COLUMN order is bytes, so it is asserted exactly.
      expect(columnOrderOf(JSON.stringify(ts))).toEqual(columnOrderOf(JSON.stringify(nat)));
      expect([...ts].map((r) => JSON.stringify(r)).sort()).toEqual(
        [...nat].map((r) => JSON.stringify(r)).sort(),
      );
      // And the row COUNT, so a walk that dropped or duplicated a copy cannot pass by having the
      // same DISTINCT rows — which is exactly what a block-boundary bug would look like.
      expect(ts.length).toBe(nat.length);
    });
  }

  // ⚠️ A NON-EMPTY FLOOR FOR THE CORPUS. Two empty results agree trivially and would pass every
  // assertion above, so at least the headline shape has to actually produce rows for any of this
  // to have asked a question. Item 1814's four-segment test passed for a whole session while
  // comparing nothing.
  test('the corpus is not vacuous', () => {
    const rows = tsQuery(
      tsGraph,
      'MATCH (a:P)-[:E]->(b:P)-[:E]->(c:P)-[:E]->(d:P) RETURN d.k AS k',
    ) as unknown[];

    expect(rows.length).toBeGreaterThan(0);
  });
});

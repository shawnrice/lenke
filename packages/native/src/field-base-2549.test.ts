import { describe as suite, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

import { nativeBackend, nativeReady } from './conformance-harness.js';

/*
 * Item 2549: the two engines' raise classifiers NO LONGER AGREE on a dotted access, and that is
 * deliberate — so something has to watch the shapes the disagreement can reach.
 *
 * Item 2548 made the Rust optimizer's `can_raise` recurse into containers, `Field`'s base included,
 * because not doing so was a wrong answer. The TS engine's `valueCannotRaise` still treats a dotted
 * access as non-raising UNCONDITIONALLY, and its comment used to justify that by "it is exactly
 * what the engine does" — a claim 2548 falsified.
 *
 * Leaving the TS arm alone is the owner policy in `conjunct-order-chosen-for-speed`: each engine
 * orders conjuncts for its own speed, and an error one raises where the other short-circuits is
 * ACCEPTED. But "accepted" is not "unmeasured". These rows are the shapes the difference can reach;
 * all of them agree today, and this test is what will say so if one stops.
 *
 * TWO INSTRUMENT BUGS WERE CAUGHT BY THE CONTROLS HERE, which is why both controls stay:
 *   - the NDJSON discriminator is `node`, not `vertex`, and an edge's type lives in `labels` — and
 *     spreading the edge object AFTER `type: 'edge'` silently overwrote the discriminator, so the
 *     Rust graph ingested NOTHING;
 *   - `queryJson` returns `{columns, rows}`, NOT a bare array, so counting `Array.isArray` reported
 *     0 rows for every native answer and made both controls look like divergences.
 * The ingested counts are asserted for the first reason and the row shape is read for the second.
 */
const FIXTURE = [
  // `x = 0` makes `2 % x` fault; this node has NO outgoing edge, so a hop removes it — the item 69
  // condition, and the whole reason a relocated predicate can fault where the raw one cannot.
  { id: 'a', labels: ['T'], properties: { x: 2, rec: { k: 1 } } },
  { id: 'b', labels: ['T'], properties: { x: 4, rec: { k: 1 } } },
  { id: 'z', labels: ['T'], properties: { x: 0, rec: { k: 1 } } },
];
const EDGES = [{ id: 'e1', type: 'E', from: 'a', to: 'b' }];

const QUERIES: readonly (readonly [string, string])[] = [
  ['CONTROL item 69 shape', 'MATCH (n:T)-[:E]->(m) WHERE ((2 % n.x) IS NOT TRUE) RETURN m.x'],
  ['CONTROL dotted on a prop', 'MATCH (n:T)-[:E]->(m) WHERE n.rec.k = 1 RETURN m.x'],
  ['dotted on arithmetic', 'MATCH (n:T)-[:E]->(m) WHERE (2 % n.x).k = 1 RETURN m.x'],
  [
    'raising sibling + dotted-on-arith',
    'MATCH (n:T)-[:E]->(m) WHERE ((2 % n.x) IS NOT TRUE) AND ((2 % n.x).k = 1) RETURN m.x',
  ],
  ['subscript on arithmetic', 'MATCH (n:T)-[:E]->(m) WHERE (2 % n.x)[0] = 1 RETURN m.x'],
];

/** The answer, or the error — the DIFFERENCE is the question, so a raise must be visible. */
const describe = (fn: () => unknown): string => {
  try {
    const out = fn();
    const rows = Array.isArray(out) ? out : ((out as { rows?: readonly unknown[] }).rows ?? null);

    if (rows === null) {
      return `UNREADABLE ${JSON.stringify(out).slice(0, 40)}`;
    }

    return `${rows.length} rows`;
  } catch (e) {
    const err = e as { code?: string; message?: string };

    return `RAISED ${err.code ?? ''} ${(err.message ?? String(e)).slice(0, 44)}`;
  }
};

const run = (): { ts: readonly string[]; rust: readonly string[]; counts: string } => {
  const graph = new Graph();
  const added = new Map<string, ReturnType<Graph['addVertex']>>();

  for (const v of FIXTURE) {
    added.set(v.id, graph.addVertex(v));
  }

  for (const e of EDGES) {
    const from = added.get(e.from);
    const to = added.get(e.to);

    if (!from || !to) {
      throw new Error(`fixture edge ${e.id} names a vertex that was not added`);
    }

    graph.addEdge({ id: e.id, from, to, labels: [e.type] });
  }

  const backend = nativeBackend();
  const ndjson = [
    ...FIXTURE.map((v) =>
      JSON.stringify({ type: 'node', id: v.id, labels: v.labels, properties: v.properties }),
    ),
    ...EDGES.map((e) =>
      JSON.stringify({ type: 'edge', id: e.id, from: e.from, to: e.to, labels: [e.type] }),
    ),
  ].join('\n');
  const handle = backend.graphFromNdjson(new TextEncoder().encode(ndjson));

  const counts = `ts ${graph.vertexCount}v/${graph.edgeCount}e rust ${backend.vertexCount(handle)}v/${backend.edgeCount(handle)}e`;
  const ts = QUERIES.map(([, q]) => describe(() => [...query(graph, q)]));
  const rust = QUERIES.map(([, q]) =>
    describe(() => JSON.parse(backend.queryJson(handle, q)) as unknown),
  );

  backend.graphFree(handle);

  return { ts, rust, counts };
};

(nativeReady ? suite : suite.skip)('item 2549: the dotted-access raise classifiers', () => {
  test('both engines ingest the same fixture', () => {
    // Without this the whole table can pass against an EMPTY native graph.
    expect(run().counts).toBe('ts 3v/1e rust 3v/1e');
  });

  test('every shape the classifier disagreement can reach still agrees', () => {
    const { ts, rust } = run();

    for (const [i, [tag]] of QUERIES.entries()) {
      expect(`${tag}: ${ts[i]}`).toBe(`${tag}: ${rust[i]}`);
    }
  });

  test('the controls are productive — the fixture does not answer everything the same way', () => {
    const { ts } = run();

    // A table of all-zeroes would pass the row above while testing nothing.
    expect(ts[0]).toBe('1 rows');
    expect(ts[1]).toBe('1 rows');
  });
});

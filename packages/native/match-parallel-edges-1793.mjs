/**
 * ⚠️ DOES `match()` DROP A SOLUTION WHEN TWO PARALLEL EDGES GIVE THE SAME BINDING PAIR?
 *
 * TinkerPop 3.7.3, asked directly (`podman run -i docker.io/tinkerpop/gremlin-console:3.7.3`), on a
 * graph with two `a -> b` edges, one `a -> c` and a `b -> b` self loop:
 *
 *     edges=4   bareHopCount=4   matchCount=4
 *     matchPairs=[[a:1, b:2], [a:1, b:2], [a:1, b:3], [a:2, b:2]]
 *
 * — the `[a:1, b:2]` pair appears TWICE. `match()` emits one traverser per TRAVERSAL RESULT, not
 * per distinct binding assignment, so parallel edges are two solutions.
 *
 * This runs the same question through both of this repo's engines. Byte-identity between them is
 * the hard invariant, so the three possible outcomes mean different things:
 *
 *   - both 4  — conformant, and the question is only about speed
 *   - both 3  — a shared conformance deviation: the fuzzers cannot see it, since they compare the
 *               engines to each other and not to TinkerPop
 *   - 3 vs 4  — a cross-engine divergence the gremlin fuzzer is blind to, which would mean its
 *               generator never builds a multigraph
 */

import { Graph } from '@lenke/core';
import { V, as_, count, match, out, pipe, run, select, toArray, traversal } from '@lenke/gremlin';

import { nativeBackend, NATIVE_LIB } from './src/conformance-harness.js';

const NDJSON = [
  '{"type":"node","id":"1","labels":["P"],"properties":{"n":1}}',
  '{"type":"node","id":"2","labels":["P"],"properties":{"n":2}}',
  '{"type":"node","id":"3","labels":["P"],"properties":{"n":3}}',
  '{"type":"edge","id":"e1","labels":["E"],"from":"1","to":"2","properties":{}}',
  '{"type":"edge","id":"e2","labels":["E"],"from":"1","to":"2","properties":{}}',
  '{"type":"edge","id":"e3","labels":["E"],"from":"1","to":"3","properties":{}}',
  '{"type":"edge","id":"e4","labels":["E"],"from":"2","to":"2","properties":{}}',
].join('\n');

const tsGraph = () => {
  const g = new Graph();
  const vs = {};

  for (const n of [1, 2, 3]) {
    vs[n] = g.addVertex({ id: String(n), labels: ['P'], properties: { n } });
  }

  const e = (id, from, to) =>
    g.addEdge({ id, from: vs[from], to: vs[to], labels: ['E'], properties: {} });

  e('e1', 1, 2);
  e('e2', 1, 2);
  e('e3', 1, 3);
  e('e4', 2, 2);

  return g;
};

const PATTERN = pipe(as_('a'), out('E'), as_('b'));
const PLANS = {
  bareHopCount: traversal(V(), out('E'), count()),
  matchCount: traversal(V(), match(PATTERN), count()),
  matchPairs: traversal(V(), match(PATTERN), select('a', 'b')),
};

const g = tsGraph();
const tsOut = {};

for (const [name, plan] of Object.entries(PLANS)) {
  tsOut[name] = name === 'matchPairs' ? toArray(plan, g).length : [...run(plan, g)][0];
}

let nativeOut = 'NO LIB';

if (NATIVE_LIB !== undefined) {
  const backend = nativeBackend();
  const handle = backend.graphFromNdjson(new TextEncoder().encode(NDJSON));
  const dec = new TextDecoder();

  try {
    nativeOut = {
      bareHopCount: JSON.parse(
        dec.decode(backend.gremlinJson(handle, "g.V().out('E').count()")),
      )[0],
      matchCount: JSON.parse(
        dec.decode(backend.gremlinJson(handle, "g.V().match(__.as('a').out('E').as('b')).count()")),
      )[0],
      matchPairs: JSON.parse(
        dec.decode(
          backend.gremlinJson(handle, "g.V().match(__.as('a').out('E').as('b')).select('a','b')"),
        ),
      ).length,
    };
  } finally {
    backend.graphFree(handle);
  }
}

console.log(
  JSON.stringify(
    { tinkerpop: { bareHopCount: 4, matchCount: 4, matchPairs: 4 }, ts: tsOut, native: nativeOut },
    null,
    2,
  ),
);

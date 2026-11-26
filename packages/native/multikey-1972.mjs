// Item 1972 — the last `ded:` row worth pricing: `V().out(T).values(k, w).dedupe()`.
//
// Item 1970 left three `ded:` rows explicitly UNPRICED rather than dismissed, because no comparable
// sibling exists in the route screen and inventing one is what produced its 5.00x artefact. Two of
// the three answer themselves:
//
//   `deduped then limit`   `values(k).dedupe().limit(3)` — item 1970 measured ~0 ms: the pipeline is
//                          LAZY and a `limit` short-circuits. Nothing to take.
//   `labelled dedupe`      `dedupe('x')` with NO step tagged `x` collapses the whole stream to its
//                          first element (the rung's own test asserts one row). A query whose answer
//                          is "the first element" is degenerate, and optimizing it would be a
//                          benchmark special rather than a workload.
//
// SO THIS PRICES THE ONE REALISTIC SHAPE, against a HAND CEILING rather than a sibling — the
// fused rung takes ONE key and declines two, and the question is what that refusal costs.
//
// THE DENOMINATOR IS VALUES PRODUCED, NOT ELEMENTS VISITED. `values(k, w)` emits TWO values per
// element where `values(k)` emits one, so a per-element figure flatters the single-key arm by 2x for
// free — the mistake item 1858 declined a target over and item 1970 caught in its own control.
//
//     bun multikey-1972.mjs
import { Graph } from '@lenke/core';
import { dedupe, out, toArray, traversal, V, values } from '@lenke/gremlin';

const NODES = Number(process.env.NODES ?? 200000);
const FANOUT = Number(process.env.FANOUT ?? 5);
const REPS = Number(process.env.REPS ?? 9);
const g = new Graph();

for (let i = 0; i < NODES; i += 1) {
  // `k` and `w` have DISJOINT value spaces, so the multi-key dedupe's answer is the union of two
  // distinct sets rather than one of them — a fixture where they overlapped could not tell a walk
  // that dropped a key from one that kept both.
  g.addVertex({
    id: String(i + 1),
    labels: ['T'],
    properties: { k: `k${String(i % 97)}`, w: `w${String(i % 31)}` },
  });
}

for (let e = 0; e < NODES * FANOUT; e += 1) {
  const i = e % NODES;
  // Split on the REPEAT INDEX — the generator trap CLAUDE.md records.
  const hop = Math.floor(e / NODES);

  g.addEdge({
    id: `e${String(e)}`,
    from: g.getVertexById(String(i + 1)),
    to: g.getVertexById(String(((i * 7 + 3 + hop * 2_654_435_761) % NODES) + 1)),
    labels: ['E'],
    properties: {},
  });
}

const EDGES = NODES * FANOUT;

/** THE CEILING for the multi-key shape: one pass, both keys into one Set, first-seen order. */
const handMulti = () => {
  const seen = new Set();
  const out_ = [];

  for (const v of g.vertices) {
    const bucket = v.adjFrom?.get('E');

    if (bucket === undefined) {
      continue;
    }

    for (const edge of bucket) {
      const far = edge.to;

      for (const key of ['k', 'w']) {
        const value = far.properties[key];

        if (value !== undefined && !seen.has(value)) {
          seen.add(value);
          out_.push(value);
        }
      }
    }
  }

  return out_;
};

/** The same by hand with ONE key, so the ceiling's own per-value cost is readable. */
const handSingle = () => {
  const seen = new Set();
  const out_ = [];

  for (const v of g.vertices) {
    const bucket = v.adjFrom?.get('E');

    if (bucket === undefined) {
      continue;
    }

    for (const edge of bucket) {
      const value = edge.to.properties.k;

      if (value !== undefined && !seen.has(value)) {
        seen.add(value);
        out_.push(value);
      }
    }
  }

  return out_;
};

const SHAPES = {
  'engine multi-key (generic)': [
    () => toArray(traversal(V(), out('E'), values('k', 'w'), dedupe()), g),
    2,
  ],
  'engine single-key (fused)': [
    () => toArray(traversal(V(), out('E'), values('k'), dedupe()), g),
    1,
  ],
  'HAND multi-key (ceiling)': [handMulti, 2],
  'HAND single-key (ceiling)': [handSingle, 1],
};

const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

console.log(
  `NODES=${String(NODES)} FANOUT=${String(FANOUT)} |E|=${String(EDGES)} REPS=${String(REPS)} median`,
);
console.log('# ns/value is per VALUE PRODUCED (edges x keys), never per element\n');
console.log('arm                             ms    ns/value   rows   first');

for (const [name, [fn, keys]] of Object.entries(SHAPES)) {
  const ts = [];
  let rows = 0;
  let first;

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();
    const got = fn();

    ts.push(performance.now() - t0);
    rows = got.length;
    [first] = got;
  }

  console.log(
    `${name.padEnd(28)} ${med(ts).toFixed(1).padStart(7)} ${((med(ts) * 1e6) / (EDGES * keys)).toFixed(0).padStart(9)}  ${String(rows).padStart(5)}   ${String(first)}`,
  );
}

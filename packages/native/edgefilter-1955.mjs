// Item 1955 — `V().outE('E').has('w', gt(3)).inV().values('n')`: the Gremlin screen's largest
// REALISTIC cost, and a shape real traversals are full of ("neighbours via an edge matching X").
//
//     101.61 ms   457142 rows   edge: outE.has(w).inV      223 ns/row
//
// Item 1307 fused `outE(T).inV()` into `out(T)`, so the long spelling of a plain hop reaches every
// rung the short one has. With a `has()` BETWEEN them there is no short spelling to fuse to, so
// this shape keeps the edge in the stream — and the question is what that costs against a hand
// loop that never materializes an edge traverser.
//
// 🔑 THE HAND CEILING IS ONE EDGE-BUCKET PASS: test the property, take the target, read `n`. The
// engine cannot beat that, and the gap is what a fused arm could claim.
//
// ⚠️ THE ANSWER IS GUARDED, not just the row count: a multiset checksum, because an arm that
// visits the right edges in the wrong nesting still has to produce the same values.
//
//     bun edgefilter-1955.mjs
import { Graph } from '@lenke/core';
import { gt, has, inV, outE, toArray, traversal, V, values } from '@lenke/gremlin';

const NODES = Number(process.env.NODES ?? 200000);
const FANOUT = Number(process.env.FANOUT ?? 5);
const REPS = Number(process.env.REPS ?? 9);
const THRESH = 3;

const g = new Graph();

for (let i = 0; i < NODES; i += 1) {
  g.addVertex({ id: String(i + 1), labels: ['T'], properties: { n: i % 12 } });
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
    // `w` spans 0-6, so `gt(3)` keeps 3 of every 7 — the screen's own selectivity.
    properties: { w: e % 7 },
  });
}

const engine = () =>
  toArray(traversal(V(), outE('E'), has('w', gt(THRESH)), inV(), values('n')), g);

/** THE CEILING: one pass over the edge bucket, the property test, the target's `n`. */
const hand = () => {
  const out = [];
  const bucket = g.edgesByLabel.get('E');

  if (bucket !== undefined) {
    for (const edge of bucket) {
      if (!(edge.properties.w > THRESH)) {
        continue;
      }

      out.push(edge.to.properties.n ?? null);
    }
  }

  return out;
};

/**
 * A SECOND hand arm, start-driven like the engine's own traversal: iterate vertices, then each
 * one's `E` bucket. If the engine is far off the edge-bucket ceiling but close to THIS, the cost is
 * the access pattern rather than the stream machinery — the distinction item 1951 needed.
 */
const handStartDriven = () => {
  const out = [];

  for (const v of g.verticesByLabel.get('T') ?? []) {
    const bucket = v.adjFrom?.get('E');

    if (bucket === undefined) {
      continue;
    }

    for (const edge of bucket) {
      if (!(edge.properties.w > THRESH)) {
        continue;
      }

      out.push(edge.to.properties.n ?? null);
    }
  }

  return out;
};

const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

const time = (fn) => {
  const ts = [];
  let rows = 0;
  let sum = 0;

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();
    const got = fn();

    ts.push(performance.now() - t0);

    if (r === 0) {
      rows = got.length;

      for (const x of got) {
        sum += Number(x);
      }
    }
  }

  return { ms: med(ts), rows, sum };
};

const e = time(engine);
const h = time(hand);
const s = time(handStartDriven);

console.log(
  `NODES=${String(NODES)} FANOUT=${String(FANOUT)} |E|=${String(NODES * FANOUT)} REPS=${String(REPS)} median\n`,
);
console.log('arm                    ms      ns/row     rows     checksum');

for (const [name, r] of [
  ['engine', e],
  ['hand, edge bucket', h],
  ['hand, start-driven', s],
]) {
  console.log(
    `${name.padEnd(20)} ${r.ms.toFixed(1).padStart(7)}  ${((r.ms * 1e6) / r.rows).toFixed(0).padStart(7)}  ${String(r.rows).padStart(8)}  ${String(r.sum)}`,
  );
}

console.log(
  `\nagree (multiset)? ${String(e.rows === h.rows && h.rows === s.rows && e.sum === h.sum && h.sum === s.sum)}   engine/bucket ${(e.ms / h.ms).toFixed(2)}x   engine/start ${(e.ms / s.ms).toFixed(2)}x`,
);

/*
 * ⚠️ AND NOW THE QUESTION THAT DECIDES WHETHER THE EDGE-BUCKET ARM IS EVEN LEGAL. The Gremlin
 * differential fuzzer compares this shape STRICTLY ORDERED — a single-type `outE('E')` is not in
 * its unordered set (that needs two or more labels, or a bare `both`/`bothE`) — so the TS engine's
 * stream order for it is a cross-engine contract, not a free choice. A checksum cannot see an order
 * change, so compare POSITIONALLY: if the engine already emits edge-insertion order, driving the
 * edge bucket costs nothing in order and the 2.28x is free; if it emits per-vertex order, the arm
 * would change a pinned answer.
 */
const positional = (a, b) => {
  if (a.length !== b.length) {
    return `length ${String(a.length)} vs ${String(b.length)}`;
  }

  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return `first differs at ${String(i)}: ${String(a[i])} vs ${String(b[i])}`;
    }
  }

  return 'IDENTICAL';
};

const eng = engine();

console.log(`\nengine vs hand edge-bucket  : ${positional(eng, hand())}`);
console.log(`engine vs hand start-driven : ${positional(eng, handStartDriven())}`);

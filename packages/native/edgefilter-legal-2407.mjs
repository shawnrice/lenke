/**
 * Item 2407 — IS ITEM 1955's REMAINING GAP ACTUALLY AVAILABLE?
 *
 * `edgefilter-1955.mjs` prices `V().outE('E').has('w',gt(3)).inV().values('n')` against a hand
 * "ceiling" that iterates `graph.edgesByLabel` — 31.7 ms against the engine's 62.0, which item 1955
 * called a 2.28x-beyond-start-driven prize and blamed stream order for blocking. Item 2400 freed
 * stream order, so the prize should now be claimable.
 *
 * ⚠️⚠️ **EXCEPT THAT CEILING READS `edge.properties.w` AND `edge.to.properties.n` AS LITERALS, AND
 * THE ENGINE CANNOT.** The keys are plan data (`proj.keys[0]`), so the engine's access is
 * `properties[key]` with a variable, and [[no-runtime-codegen]] is FIRM — there is no legal route
 * from one to the other. Item 2016 already priced exactly this term inside
 * `edge-filtered-hop-values.ts`: a flat edge array with a DYNAMIC key is 79 ns/edge where the same
 * walk with a LITERAL key is 56, "⬅ 1.41x is the KEYED LOAD", recorded there as unreachable.
 *
 * So item 1955's ceiling is the trap [[floor-arm-must-take-same-route]] names: a floor that takes a
 * route the subject is not allowed to take. This probe settles whether ANY of that 1.96x survives
 * once the arm is held to the engine's own constraint.
 *
 * THE ARMS. All four produce the same multiset (checksum-guarded):
 *
 *   engine            what ships today — a MEMOIZED flat edge array (`edgeFlatFor`, cached on
 *                     `topologyVersion`) walked with two closures and dynamic keys.
 *   bucket LITERAL    item 1955's ceiling, reproduced: `edgesByLabel` + literal keys. ILLEGAL.
 *   bucket DYNAMIC    the same walk, keys from a variable. THE LEGAL EDGE-BUCKET CEILING.
 *   flat DYNAMIC      a pre-built contiguous array + dynamic keys — the engine's own shape by hand,
 *                     which says how much of any gap is the walk rather than the access.
 *
 * ⚠️ The flat array is built OUTSIDE the timed loop on purpose: `edgeFlatFor` memoizes per
 * `topologyVersion`, so a read-only workload pays that build once and the probe must too, or it
 * would charge the engine's arm for work the engine amortizes.
 *
 * ⚠️ A NULL CONTROL runs alongside — a vertex-only count no arm here touches. If it moves between
 * rounds, the machine moved and no ratio below is evidence.
 *
 *   bun edgefilter-legal-2407.mjs
 */
import { Graph } from '@lenke/core';
import { count, gt, has, inV, outE, toArray, traversal, V, values } from '@lenke/gremlin';

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
  // Split on the REPEAT INDEX — the generator trap CLAUDE.md records (items 1516/1518).
  const hop = Math.floor(e / NODES);

  g.addEdge({
    id: `e${String(e)}`,
    from: g.getVertexById(String(i + 1)),
    to: g.getVertexById(String(((i * 7 + 3 + hop * 2_654_435_761) % NODES) + 1)),
    labels: ['E'],
    properties: { w: e % 7 },
  });
}

/*
 * ⚠️ THE KEYS COME FROM THE ENVIRONMENT so no arm can constant-fold them. The engine reads
 * `proj.keys[0]` off a plan, which is the same situation: a string known only at run time.
 */
const WKEY = process.env.WKEY ?? 'w';
const NKEY = process.env.NKEY ?? 'n';

const engine = () =>
  toArray(traversal(V(), outE('E'), has('w', gt(THRESH)), inV(), values('n')), g);

const bucketLiteral = () => {
  const out = [];
  const bucket = g.edgesByLabel.get('E');

  for (const edge of bucket) {
    if (!(edge.properties.w > THRESH)) {
      continue;
    }

    out.push(edge.to.properties.n ?? null);
  }

  return out;
};

const bucketDynamic = () => {
  const out = [];
  const bucket = g.edgesByLabel.get('E');

  for (const edge of bucket) {
    if (!(edge.properties[WKEY] > THRESH)) {
      continue;
    }

    out.push(edge.to.properties[NKEY] ?? null);
  }

  return out;
};

// Built once, exactly as `edgeFlatFor` memoizes it.
const flat = [...g.edgesByLabel.get('E')];

const flatDynamic = () => {
  const out = [];

  for (const edge of flat) {
    if (!(edge.properties[WKEY] > THRESH)) {
      continue;
    }

    out.push(edge.to.properties[NKEY] ?? null);
  }

  return out;
};

const control = () => toArray(traversal(V(), count()), g);

/** Order-insensitive: every arm must agree on the MULTISET, which is all item 2400 contracts. */
const checksum = (rows) => {
  let h = 0;
  let n = 0;

  for (const r of rows) {
    h = (h + Number(r ?? 0) * 2_654_435_761) % 4_294_967_296;
    n += 1;
  }

  return `${String(n)}:${String(h)}`;
};

const timed = (fn) => {
  const xs = [];

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();
    const rows = fn();

    xs.push(performance.now() - t0);

    if (rows.length === 0) {
      throw new Error('no rows: the arm is not doing what the probe assumes');
    }
  }

  // Median of the post-warmup reps — a min hides a bimodal arm (items 2365-2368).
  const post = xs.slice(3).sort((a, b) => a - b);

  return post[Math.floor(post.length / 2)];
};

console.log(
  `NODES=${String(NODES)} FANOUT=${String(FANOUT)} |E|=${String(NODES * FANOUT)} REPS=${String(REPS)} median`,
);
console.log(`keys from env so nothing folds: w=${WKEY} n=${NKEY}\n`);

const ARMS = [
  ['engine', engine],
  ['bucket LITERAL  (illegal)', bucketLiteral],
  ['bucket DYNAMIC  (legal)', bucketDynamic],
  ['flat   DYNAMIC  (engine shape)', flatDynamic],
];

const sums = new Map();
const times = new Map();

for (const [name, fn] of ARMS) {
  const ms = timed(fn);
  const rows = fn();

  times.set(name, ms);
  sums.set(name, checksum(rows));
  /*
   * ⚠️ ns PER EDGE VISITED, not per row. Every arm visits all |E| edges and keeps 3 in 7, so a
   * per-ROW figure divides by the kept rows and flatters each arm by the same ~2.33x — item 1858's
   * recorded mistake, and `edgecount-1955.mjs` prints per-visit for exactly this reason.
   */
  console.log(
    `${name.padEnd(32)} ${ms.toFixed(1).padStart(7)} ms   ${((1e6 * ms) / (NODES * FANOUT)).toFixed(0).padStart(4)} ns/edge-visit   rows ${String(rows.length)}`,
  );
}

const base = times.get('engine');

console.log('');

for (const [name] of ARMS.slice(1)) {
  console.log(`engine / ${name.padEnd(32)} ${(base / times.get(name)).toFixed(2)}x`);
}

const distinct = new Set(sums.values());

console.log(
  `\nall arms agree (multiset)? ${distinct.size === 1 ? 'true' : `FALSE -> ${[...distinct].join(' | ')}`}`,
);
console.log(`NULL CONTROL (vertex count) ${timed(control).toFixed(1)} ms`);

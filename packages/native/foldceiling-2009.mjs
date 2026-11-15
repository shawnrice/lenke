/**
 * WHAT IS THE REAL CEILING FOR A DEPTH-3/4 ORDER-INDEPENDENT FOLD? (item 2009)
 *
 * ⚠️⚠️ **`count(*)` IS THE WRONG CEILING AND I ALMOST USED IT.** At depth 3 `count(*)` reads 0.09 ms
 * against `min(c.n)`'s 9.63 — a tempting 107x — but `count(*)` is answered by a closed-form DEGREE
 * PRODUCT that visits no endpoint at all, while `min` must see them. Item 1951's rule: **a cheaper
 * sibling is only a ceiling if it does the same work.** 9.63 ms over 625,000 path endpoints is 15 ns
 * each, which is not obviously bad, and quoting 107x would have been the `choose` mistake of item
 * 1999 in reverse.
 *
 * 🔑 **THE REAL QUESTION IS WHETHER THESE FOLDS NEED PER-PATH WORK AT ALL.** `min`, `max` and
 * `count(DISTINCT x)` are SET functions: the answer depends on the SET of reachable endpoints, not on
 * how many paths reach each. So they are computable in O(k·(|V| + |E|)) by a level-wise frontier,
 * not O(paths).
 *
 * ⚠️ `count(x)` IS NOT A SET FUNCTION — it counts one per PATH whose endpoint has a non-null `x`, so
 * it needs multiplicity. But the level recurrence `varLengthDegreeCount` already runs COMPUTES
 * exactly that: `u_k(v)` is the number of length-k walks ending at `v`. So `count(c.n)` is
 * `sum over v with non-null n of u_3(v)` — also O(k·(|V| + |E|)).
 *
 * ⚠️ AND `sum` IS NOT IN THIS FAMILY: it needs the per-path VALUES summed in a defined ORDER, and
 * f64 addition is not associative, which is the byte-identity refusal items 1829/1830 record. A
 * multiplicity-weighted sum would be a DIFFERENT arithmetic from the general path's, so it is
 * excluded here by contract rather than by difficulty.
 *
 *     bun foldceiling-2009.mjs
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const NODES = Number(process.env.NODES ?? 5000);
const FANOUT = Number(process.env.FANOUT ?? 5);
const REPS = Number(process.env.REPS ?? 5);
const DEPTH = Number(process.env.DEPTH ?? 3);

const g = new Graph();

for (let i = 0; i < NODES; i += 1) {
  g.addVertex({ id: String(i + 1), labels: ['T'], properties: { n: i % 97 } });
}

for (let e = 0; e < NODES * FANOUT; e += 1) {
  const i = e % NODES;
  const hop = Math.floor(e / NODES);

  g.addEdge({
    id: `e${String(e)}`,
    from: g.getVertexById(String(i + 1)),
    to: g.getVertexById(String(((i * 7 + 3 + hop * 2_654_435_761) % NODES) + 1)),
    labels: ['E'],
    properties: {},
  });
}

const csr = (() => {
  const order = [...g.vertices];
  const idx = new Map();

  for (let i = 0; i < order.length; i += 1) {
    idx.set(order[i], i);
  }

  const off = new Int32Array(order.length + 1);
  const nbr = new Int32Array(g.edgeCount);
  let at = 0;

  for (let i = 0; i < order.length; i += 1) {
    off[i] = at;

    const box = order[i].adjFrom?.get('E');

    if (box !== undefined) {
      for (const e of box) {
        nbr[at] = idx.get(e.to);
        at += 1;
      }
    }
  }

  off[order.length] = at;

  return { order, off, nbr };
})();

/**
 * The ceiling: a LEVEL-WISE multiplicity recurrence, which is what `varLengthDegreeCount` already
 * does for `count(*)` — then one pass over the final level.
 *
 * `u[v]` is the number of length-d walks ending at `v`. `min`/`max` read only which entries are
 * non-zero (a SET question); `count(x)` sums the multiplicities of entries whose `n` is non-null.
 */
const levelFold = (depth, which) => {
  const { order, off, nbr } = csr;
  let u = new Float64Array(order.length).fill(1);
  let next = new Float64Array(order.length);

  for (let d = 0; d < depth; d += 1) {
    next.fill(0);

    for (let v = 0; v < order.length; v += 1) {
      const m = u[v];

      if (m === 0) {
        continue;
      }

      const end = off[v + 1];

      for (let k = off[v]; k < end; k += 1) {
        next[nbr[k]] += m;
      }
    }

    const t = u;

    u = next;
    next = t;
  }

  if (which === 'count') {
    let n = 0;

    for (let v = 0; v < order.length; v += 1) {
      if (u[v] !== 0 && order[v].properties.n !== undefined && order[v].properties.n !== null) {
        n += u[v];
      }
    }

    return n;
  }

  let best;

  for (let v = 0; v < order.length; v += 1) {
    if (u[v] === 0) {
      continue;
    }

    const val = order[v].properties.n;

    if (val === undefined || val === null) {
      continue;
    }

    if (best === undefined || (which === 'min' ? val < best : val > best)) {
      best = val;
    }
  }

  return best;
};

const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const time = (fn) => {
  const ts = [];
  let out;

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();

    out = fn();
    ts.push(performance.now() - t0);
  }

  return { ms: med(ts), out };
};

const chain = (d) => {
  const vars = ['a', 'b', 'c', 'd', 'e'].slice(0, d + 1);

  return vars.map((v, i) => (i === 0 ? `(${v}:T)` : `-[:E]->(${v}:T)`)).join('');
};
const far = ['a', 'b', 'c', 'd', 'e'][DEPTH];

console.log(
  `|V|=${String(NODES)} fanout=${String(FANOUT)} depth=${String(DEPTH)} median of ${String(REPS)}\n`,
);
console.log('fold          engine ms   ceiling ms    ratio   engine      ceiling    agree');

for (const which of ['min', 'max', 'count']) {
  const expr = which === 'count' ? `count(${far}.n)` : `${which}(${far}.n)`;
  /*
   * ⚠️ The reason, here rather than on the disable line, because `disable-next-line` must sit
   * immediately above the code it guards — a multi-line comment makes its own second line the "next
   * line" and the suppression misses (item 2007 hit this too). `chain(DEPTH)`, `far` and `which`
   * are built from this file's own DEPTH number and a fixed list; nothing is caller- or
   * data-derived, and a PATTERN SHAPE cannot be a `$param` — a parameter binds a value.
   */
  // eslint-disable-next-line lenke/no-raw-interpolation -- trusted literals; see above
  const eng = time(() => [...query(g, `MATCH ${chain(DEPTH)} RETURN ${expr} AS x`, {})]);
  const hand = time(() => levelFold(DEPTH, which));
  const ev = eng.out[0].x;

  /*
   * ⚠️ EVERY FIELD HOISTED, because an inline `… + ev === hand.out ? 'YES' : 'NO'` PARSES AS
   * `(string) === hand.out` and the agreement column would have read NO on every row — a probe
   * reporting its own verdict wrongly. `prefer-template` flagged the concatenation that hid it.
   */
  const agree = ev === hand.out ? 'YES' : 'NO ⚠️';
  const ratio = `${(eng.ms / hand.ms).toFixed(1)}x`;
  const cells = [
    expr.padEnd(13),
    eng.ms.toFixed(2).padStart(9),
    hand.ms.toFixed(2).padStart(12),
    ratio.padStart(9),
    String(ev).padStart(8),
    String(hand.out).padStart(12),
    agree.padStart(8),
  ];

  console.log(cells.join(' '));
}

console.log(
  '\n# ⚠️ The ceiling includes the level recurrence from scratch each rep — no cached CSR, no cached\n' +
    '#    levels — so it is the honest cost of the work, not a warm-cache figure.\n' +
    '# ⚠️ `sum` is deliberately absent: it needs per-path values in a defined ORDER (f64 addition is\n' +
    '#    not associative), which is the byte-identity refusal items 1829/1830 record.',
);

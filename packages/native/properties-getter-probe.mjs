/**
 * WHAT DOES `Vertex.properties` COST, CALLED DIRECTLY? (item 1772)
 *
 * Item 1772's in-engine split found the keyed load free and the GETTER to be essentially all of item
 * 1770's 60 ns/row: with `pick` reduced to `far.properties === undefined ? … : 1772` the walk still
 * measured 73-94 ms against the real 80-84, while removing the getter too dropped it to 19.5-22.2.
 *
 * But item 1771 priced a shared-prototype getter at 6.6 ns, 9x less. So either the getter is
 * genuinely slow for a reason its three lines do not show, or the cost belongs to the walk's CALL
 * SITE rather than to the getter. Those call for different work, so this measures the getter on its
 * own, on real `Vertex` objects from a real `Graph`, with the walk removed entirely.
 *
 * Arms bisect the getter's body:
 *
 *     properties     the real accessor                        getter + box + bag
 *     labels         the sibling accessor, same box pattern    a control for "is it accessors?"
 *     id            a plain field                             the floor
 *
 * ⚠️ RANDOM ORDER over the canonical instances, because item 1770 measured locality at 2.4x here and
 * the walk reaches vertices in adjacency order, not allocation order.
 *
 * ⚠️ AND THE SINK IS ASSERTED. Reading a property and discarding it invites V8 to drop the load; each
 * arm accumulates something derived from the value and the total is checked.
 */
import { Graph } from '@lenke/core';

const NODES = Number(process.env.NODES ?? 200_000);
const N = Number(process.env.N ?? 2_000_000);
const REPS = Number(process.env.REPS ?? 9);

const g = new Graph();
const verts = [];

for (let i = 0; i < NODES; i += 1) {
  verts.push(g.addVertex({ id: `v${i}`, labels: ['Person'], properties: { age: 20 + (i % 60) } }));
}

// Warm every box the way the walk does, so no arm pays the one-time `elementProperties.get`.
let warm = 0;

for (const v of verts) {
  warm += Object.keys(v.properties).length;
}

if (warm !== NODES) {
  throw new Error(`warm-up read ${warm} keys, expected ${NODES}`);
}

const idx = new Int32Array(NODES);

for (let i = 0; i < NODES; i += 1) {
  idx[i] = i;
}

let seed = 2_246_822_519;

for (let i = NODES - 1; i > 0; i -= 1) {
  seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;

  const j = seed % (i + 1);
  const t = idx[i];

  idx[i] = idx[j];
  idx[j] = t;
}

const keyBox = ['age'];

const ARMS = {
  'v.properties[k]': () => {
    const a = verts;
    const [k] = keyBox;
    let s = 0;

    for (let i = 0; i < N; i += 1) {
      s += a[idx[i % NODES]].properties[k];
    }

    return s;
  },
  'v.properties (getter only)': () => {
    const a = verts;
    let s = 0;

    for (let i = 0; i < N; i += 1) {
      s += a[idx[i % NODES]].properties === undefined ? 0 : 1;
    }

    return s;
  },
  'v.labels (sibling accessor)': () => {
    const a = verts;
    let s = 0;

    for (let i = 0; i < N; i += 1) {
      s += a[idx[i % NODES]].labels.size;
    }

    return s;
  },
  'v.id (plain field)': () => {
    const a = verts;
    let s = 0;

    for (let i = 0; i < N; i += 1) {
      s += a[idx[i % NODES]].id.length;
    }

    return s;
  },
};

const out = {};

for (const [name, fn] of Object.entries(ARMS)) {
  const series = [];
  let got = 0;

  for (let r = 0; r < REPS; r += 1) {
    const t = performance.now();

    got = fn();

    series.push(performance.now() - t);

    if (got === 0) {
      throw new Error(`${name}: empty sink — the read did not happen`);
    }
  }

  const kept = series.slice(3).sort((a, b) => a - b);

  out[name] = {
    nsPerRead: Number(((kept[Math.floor(kept.length / 2)] * 1e6) / N).toFixed(2)),
    sink: got,
    series: series.map((x) => Number(x.toFixed(1))),
  };
}

console.log(JSON.stringify({ nodes: NODES, n: N, arms: out }, null, 2));

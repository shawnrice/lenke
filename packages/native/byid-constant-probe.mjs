/**
 * WHERE DOES `getVertexById`'s 1.26x OVER A BARE `Map.get` GO? (item 1737)
 *
 * "Keep good O(1) access to get a vertex or edge by id" is a standing requirement, and item 1729
 * verified the COMPLEXITY (the engine grows 1.04x relative to a raw Map over 100x the elements).
 * But it also measured a CONSTANT -- 112.4 ns against a raw Map's 89.2 ns at 1,000,000 elements,
 * 1.26x -- and nothing has ever explained or ablated it. It is the engine's most-used primitive:
 * item 1731 measured decode spending ~14% of its time in `getVertexById` / `getEdgeById` /
 * `requireVertex`, two lookups per edge.
 *
 * The accessor is `public getVertexById = (id) => this.verticesById.get(id) ?? null;` -- an ARROW
 * ASSIGNED AS A CLASS FIELD, so a call is a property load on the instance plus an indirect call,
 * which V8 inlines less readily than a prototype method. `verticesById` is a plain field (checked),
 * so the only candidates are that call shape and the `?? null`.
 *
 * ⚠️ THE RAW-MAP ROW IS THE CONTROL, AND IT IS IN THE SAME PROCESS AS THE ARM. A parallel `Map`
 * holding the same keys is untouched by any source change, so if it moves between arms the reading
 * is the build or the machine. It also makes the ratio directly comparable to item 1729's.
 *
 * ⚠️ IDS ARE LOOKED UP IN A SCRAMBLED ORDER, not insertion order: a sequential sweep of a Map's own
 * key order measures a best case the engine never sees.
 *
 *     ARM=base node byid-constant-probe.mjs
 */
import { Graph } from '@lenke/core';

const VERTS = Number(process.env.VERTS ?? 1_000_000);
const REPS = Number(process.env.REPS ?? 9);
const DROP = Number(process.env.DROP ?? 3);
const ARM = process.env.ARM ?? 'base';

const g = new Graph();
const raw = new Map();

for (let i = 0; i < VERTS; i += 1) {
  g.addVertex({ id: `v${i}`, labels: ['P'], properties: { n: i } });
  raw.set(`v${i}`, i);
}

// Scrambled probe order, built once. A multiplier coprime with VERTS visits every id exactly once.
const order = new Array(VERTS);

for (let i = 0; i < VERTS; i += 1) {
  order[i] = `v${(i * 7919 + 13) % VERTS}`;
}

const rows = {
  engine: () => {
    let hits = 0;

    for (let i = 0; i < VERTS; i += 1) {
      if (g.getVertexById(order[i]) !== null) {
        hits += 1;
      }
    }

    return hits;
  },
  rawmap: () => {
    let hits = 0;

    for (let i = 0; i < VERTS; i += 1) {
      if (raw.get(order[i]) !== undefined) {
        hits += 1;
      }
    }

    return hits;
  },
};

const timeRow = (name) => {
  const fn = rows[name];
  const series = [];
  let hits;

  for (let r = 0; r < REPS; r += 1) {
    const t = performance.now();

    hits = fn();
    series.push(performance.now() - t);
  }

  const kept = series.slice(DROP).sort((a, b) => a - b);
  const median = kept[Math.floor(kept.length / 2)];

  // Every id exists, so a row that does not hit VERTS times is measuring the wrong thing.
  if (hits !== VERTS) {
    throw new Error(`${name} hit ${hits} of ${VERTS} -- the probe order or the arm is wrong`);
  }

  return {
    ns: Number(((median * 1e6) / VERTS).toFixed(1)),
    series: series.map((x) => Number(x.toFixed(0))),
  };
};

// ⚠️ ROW ORDER IS ALTERNATED BY ARGV so the first-measured row is not always the engine's: the row
// that runs first gets a monomorphic dispatch site (item 762's redistribution trap, from the other
// side).
const first = process.env.FIRST ?? 'engine';
const engine = first === 'engine' ? timeRow('engine') : undefined;
const rawmap = timeRow('rawmap');
const engine2 = engine ?? timeRow('engine');

console.log(
  JSON.stringify({
    arm: ARM,
    first,
    verts: VERTS,
    engineNs: engine2.ns,
    rawMapNs: rawmap.ns,
    ratio: Number((engine2.ns / rawmap.ns).toFixed(3)),
    engineSeries: engine2.series,
    rawSeries: rawmap.series,
  }),
);

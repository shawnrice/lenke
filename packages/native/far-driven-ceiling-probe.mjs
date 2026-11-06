/**
 * What does `walkFarSide`'s per-vertex adjacency check actually cost, and what is the floor?
 * (item 1587)
 *
 * `MATCH (a:P)-[:E]->(b) RETURN count(DISTINCT b)` is the largest remaining cross-surface flag:
 * GQL ~6.6 ms against Gremlin's 0.527 over 50,000 vertices / 150,000 edges. The GQL walk is already
 * the optimal SHAPE — `walkFarSide` does one adjacency lookup per far vertex and never touches an
 * edge — so the gap is a per-vertex constant factor. The profile puts 50.5% in `walkFarSide` and
 * 22.5% in the dedup `add`, which works out at ~104 ns per vertex for what should be a getter plus
 * a `Map.get`.
 *
 * So this prices each mechanism separately, the way item 1586's ladder did, instead of guessing
 * which one is the 104 ns:
 *
 *     iterate      iterate the vertex map, touch nothing          the floor
 *     getter       + read the cached `adjTo` getter
 *     bucket       + `.get(type)` and the size test               = walkFarSide's own work
 *     dirbranch    + the per-vertex `direct.forward ?` branch     is the branch free?
 *     idset        + add the id to a Set<string>                  = the dedup `add`
 *     gql          the real query                                 the thing being explained
 *
 *     for a in iterate getter bucket dirbranch idset gql; do ARM=$a node far-driven-ceiling-probe.mjs; done
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const NODES = Number(process.env.NODES ?? 50_000);
const FANOUT = Number(process.env.FANOUT ?? 3);
const REPS = Number(process.env.REPS ?? 40);
const ARM = process.env.ARM ?? 'iterate';

const g = new Graph();
const vs = [];

for (let i = 0; i < NODES; i += 1) {
  vs.push(g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i % 97, n: i } }));
}

// Split on the REPEAT INDEX so one vertex's edges do not all land on the same target.
for (let rep = 0; rep < FANOUT; rep += 1) {
  for (let i = 0; i < NODES; i += 1) {
    g.addEdge({
      id: `e${rep}_${i}`,
      from: vs[i],
      to: vs[(i * 7919 + rep * 104_729 + 1) % NODES],
      labels: ['E'],
    });
  }
}

{
  const seen = new Set();

  for (const e of g.edges) {
    seen.add(e.to.id);
  }

  if (seen.size < NODES * 0.5) {
    throw new Error(`fixture is degenerate: ${seen.size} distinct targets of ${NODES}`);
  }
}

const verts = g.verticesById;
// Warm every `adjTo` so the cached-getter steady state is what gets measured, not the first-touch
// `edgesToByLabel.get(id)` — the real query is run many times over one graph, so steady state is
// the honest comparison.

for (const v of verts.values()) {
  void v.adjTo;
}

const direct = { forward: true, type: 'E' };

const ARMS = {
  iterate: () => {
    let n = 0;

    for (const v of verts.values()) {
      if (v !== undefined) {
        n += 1;
      }
    }

    return n;
  },
  getter: () => {
    let n = 0;

    for (const v of verts.values()) {
      if (v.adjTo !== undefined) {
        n += 1;
      }
    }

    return n;
  },
  bucket: () => {
    let n = 0;

    for (const v of verts.values()) {
      const bucket = v.adjTo?.get('E');

      if (bucket !== undefined && bucket.size !== 0) {
        n += 1;
      }
    }

    return n;
  },
  dirbranch: () => {
    let n = 0;

    for (const v of verts.values()) {
      const bucket = (direct.forward ? v.adjTo : v.adjFrom)?.get(direct.type);

      if (bucket !== undefined && bucket.size !== 0) {
        n += 1;
      }
    }

    return n;
  },
  /**
   * ⚠️ THE HYPOTHESIS. `dirbranch` reads ~28 ns/vertex more than `bucket`, and the only difference
   * is the `direct.forward ? v.adjTo : v.adjFrom` ternary — which puts TWO different getters at
   * ONE property-access site and defeats its inline cache. Splitting the loop in two makes each
   * access monomorphic again. If this arm lands back at `bucket`'s cost, the ternary is the whole
   * difference; if it does not, the branch is not the mechanism and the idea is dead.
   */
  splitloop: () => {
    let n = 0;

    if (direct.forward) {
      for (const v of verts.values()) {
        const bucket = v.adjTo?.get(direct.type);

        if (bucket !== undefined && bucket.size !== 0) {
          n += 1;
        }
      }
    } else {
      for (const v of verts.values()) {
        const bucket = v.adjFrom?.get(direct.type);

        if (bucket !== undefined && bucket.size !== 0) {
          n += 1;
        }
      }
    }

    return n;
  },
  idset: () => {
    const seen = new Set();

    for (const v of verts.values()) {
      const bucket = (direct.forward ? v.adjTo : v.adjFrom)?.get(direct.type);

      if (bucket === undefined || bucket.size === 0) {
        continue;
      }

      const id = typeof v.id === 'string' ? v.id : String(v.id);

      seen.add(id);
    }

    return seen.size;
  },
  gql: () => {
    const rows = query(g, 'MATCH (a:P)-[:E]->(b) RETURN count(DISTINCT b) AS c');

    return Array.isArray(rows) ? Object.values(rows[0] ?? {})[0] : null;
  },
};

const run = ARMS[ARM];

if (run === undefined) {
  throw new Error(`unknown arm ${ARM}; have ${Object.keys(ARMS).join(',')}`);
}

const answer = run();
const s = [];

for (let i = 0; i < REPS; i += 1) {
  const t0 = performance.now();

  run();
  s.push(performance.now() - t0);
}

const kept = s.slice(3).sort((a, b) => a - b);
const ms = kept[Math.floor(kept.length / 2)] ?? 0;

console.log(
  JSON.stringify({
    arm: ARM,
    answer,
    ms: Number(ms.toFixed(3)),
    nsPerVertex: Number(((ms * 1e6) / NODES).toFixed(1)),
  }),
);

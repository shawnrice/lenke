/**
 * WHERE DOES `V().out(T)` SPEND ITS ~111 ns AN EDGE?
 *
 * `hopbare` is the largest row in the Gremlin corpus that nothing has decomposed: 44.5 ms for
 * 400,000 rows at 200,000 vertices. Its profile says `drain` 73.9% and `get to` 24.6% — and item
 * 1493 is why that is not taken at face value: a frame's share can be an inlining artifact, so the
 * share has to be checked against a floor before anything is built.
 *
 * `get to` is the interesting one. It is MEMOIZED (item 595: `#toV ??= getVertexById(...)`), so
 * after the first read per edge it is a private-field read and a null check — and 24.6% of this run
 * is 27.5 ns a call, which is a lot for that. Unlike item 1493's `degreeOfTypes` it has no callees
 * to absorb once warm, so the share is at least arithmetically possible. This probe decides it.
 *
 * ⚠️ EVERY ARM PRODUCES THE SAME 400,000-ELEMENT ARRAY the engine produces, so the comparison is
 * like with like — a floor that skips the materialization would price a different question, which
 * is the error four items in this corpus have made (1479, 1480/1483, 1485, 1488).
 *
 *     NODES=200000 FANOUT=2 REPS=40 node hop-rows-floor-probe.mjs
 *     ARM=engine node hop-rows-floor-probe.mjs      # one arm per process — see item 1492
 */
import { Graph } from '@lenke/core';
import { V, out, toArray, traversal } from '@lenke/gremlin';

import { profileWindow } from './windowed-profile.mjs';

const NODES = Number(process.env.NODES ?? 200_000);
const FANOUT = Number(process.env.FANOUT ?? 2);
const REPS = Number(process.env.REPS ?? 40);
const DROP = Number(process.env.DROP ?? 5);
const ONLY = process.env.ARM;

const build = () => {
  const g = new Graph();
  const ids = [];

  for (let i = 0; i < NODES; i += 1) {
    ids.push(`v${i}`);
    g.addVertex({ id: `v${i}`, labels: ['P'], properties: { num: i % 4000 } });
  }

  // Scattered, per item 1486: a sequential stride makes the adjacency read unrealistically warm.
  for (let e = 0; e < NODES * FANOUT; e += 1) {
    g.addEdge({
      id: `e${e}`,
      labels: ['E'],
      from: g.getVertexById(ids[(e * 7919) % NODES]),
      // ⚠️ THE REPEAT INDEX IS LOAD-BEARING (item 1518). Any linear `(a*k + b) % N` is invariant
      // under `k -> k + N`, and the FANOUT edges leaving one vertex are exactly k0, k0+N, k0+2N, …
      // — so the old `(k * 104_729) % NODES` sent EVERY one of them to the SAME target. Degrees
      // looked perfect and the graph was functional: one distinct out-neighbour per vertex at any
      // fanout. Item 1516 found the same defect in the GQL bench's own fixture, and `small` arms
      // elsewhere in this corpus already carry this `hop` term for exactly this reason.
      // Both products stay far inside 2^53.
      to: g.getVertexById(
        ids[((e % NODES) * 104_729 + Math.floor(e / NODES) * 2_654_435_761) % NODES],
      ),
    });
  }

  return g;
};

const graph = build();

// Stash the endpoint id as a PLAIN own property for the `rowsplain` arm, once, outside any timed
// loop. Probe-only: nothing in the engine reads this.
// ⚠️ ONLY for that arm, and the reason is the arm's own finding: adding an own property to every
// Edge transitions their hidden class, which slows EVERY access on them. Applied unconditionally
// (as the first version did) it taxes every other arm in the run and the whole ladder reads wrong.
if (process.env.ARM === 'rowsplain') {
  for (const e of graph.edgesById.values()) {
    e.__probeTo = e.toId;
  }
}

const plan = traversal(V(), out('E'));

/**
 * The flat adjacency the `flatceiling` arm walks: `off` indexes into `nbr`, counted then filled,
 * exactly as `algorithms/shortest-path.ts`'s `buildCsr` does (item 1470).
 *
 * ⚠️ Built in a LOCAL structure, not stashed on the vertices — item 1494's `rowsplain` arm measured
 * that adding an own property to the elements transitions their hidden class and slows every access
 * on all of them by 1.19x, which would tax this arm by the very mechanism it is trying to avoid.
 */
const buildFlat = () => {
  const order = [...graph.verticesById.values()];
  const off = new Int32Array(order.length + 1);

  for (let i = 0; i < order.length; i += 1) {
    off[i + 1] = off[i] + (order[i].adjFrom?.get('E')?.size ?? 0);
  }

  const nbr = new Array(off[order.length]);
  let c = 0;

  for (const v of order) {
    const bucket = v.adjFrom?.get('E');

    if (bucket === undefined) {
      continue;
    }

    for (const e of bucket) {
      nbr[c] = e.to;
      c += 1;
    }
  }

  return { off, nbr };
};

let churnCounter = 0;

const tBuild = performance.now();
const NEEDS_FLAT = new Set(['flatceiling', 'flatchurn']);

/** Nested per-vertex arrays for the `arrayadj` arm — the incrementally maintainable shape. */
const buildPerVertex = () => {
  const rows = [];

  for (const v of graph.verticesById.values()) {
    const bucket = v.adjFrom?.get('E');

    rows.push(bucket === undefined ? [] : [...bucket].map((e) => e.to));
  }

  return rows;
};

const perVertex =
  process.env.ARM === undefined || process.env.ARM === 'arrayadj' ? buildPerVertex() : [];

/** The same, holding EDGES — what a real adjacency box must hold. For the `arrayedge` arm. */
const buildPerVertexEdges = () => {
  const rows = [];

  for (const v of graph.verticesById.values()) {
    const bucket = v.adjFrom?.get('E');

    rows.push(bucket === undefined ? [] : [...bucket]);
  }

  return rows;
};

const perVertexEdges =
  process.env.ARM === undefined || process.env.ARM === 'arrayedge' ? buildPerVertexEdges() : [];

/** The same per-vertex rows as SETS, for the `setedge` locality control. */
const buildPerVertexSets = () => {
  const rows = [];

  for (const v of graph.verticesById.values()) {
    const bucket = v.adjFrom?.get('E');

    rows.push(bucket === undefined ? new Set() : new Set(bucket));
  }

  return rows;
};

const perVertexSets =
  process.env.ARM === undefined || process.env.ARM === 'setedge' ? buildPerVertexSets() : [];
const flat =
  process.env.ARM === undefined || NEEDS_FLAT.has(process.env.ARM)
    ? buildFlat()
    : { off: new Int32Array(1), nbr: [] };
const buildMs = performance.now() - tBuild;
const EDGES = NODES * FANOUT;

const ARMS = {
  // 0a. Walk the id map only. Every arm below pays this.
  //     ⚠️ These three arms answer the VERTEX count, not the edge count, so they are excluded from
  //     the agreement check — they are a cost ladder for `reach`, not answers to its question.
  vonly: () => {
    let n = 0;

    for (const _v of graph.verticesById.values()) {
      n += 1;
    }

    return n;
  },

  // 0b. + the `adjFrom` box getter per vertex.
  vbox: () => {
    let n = 0;

    for (const v of graph.verticesById.values()) {
      if (v.adjFrom !== undefined) {
        n += 1;
      }
    }

    return n;
  },

  // 0c. + the string-keyed `Map.get('E')` per vertex, which is the type lookup the walk does.
  vget: () => {
    let n = 0;

    for (const v of graph.verticesById.values()) {
      if (v.adjFrom?.get('E') !== undefined) {
        n += 1;
      }
    }

    return n;
  },

  // 1. Walk the adjacency and count the edges. No endpoint touched, nothing materialized. This is
  //    the cost of REACHING every edge, which every arm below pays.
  reach: () => {
    let n = 0;

    for (const v of graph.verticesById.values()) {
      const byType = v.adjFrom;

      if (byType === undefined) {
        continue;
      }

      const bucket = byType.get('E');

      if (bucket === undefined) {
        continue;
      }

      for (const _e of bucket) {
        n += 1;
      }
    }

    return n;
  },

  // 2. + materialize an array of that size, so the allocation is in the floor rather than only in
  //    the engine. Pushes the EDGE, which costs no endpoint read.
  rowsedge: () => {
    const out_ = [];

    for (const v of graph.verticesById.values()) {
      const bucket = v.adjFrom?.get('E');

      if (bucket === undefined) {
        continue;
      }

      for (const e of bucket) {
        out_.push(e);
      }
    }

    return out_.length;
  },

  // 3. + read the endpoint ID instead of the vertex — a string the edge already holds, no `Map`
  //    and no getter cache. Isolates "resolve the far end" from "touch the edge at all".
  rowstoid: () => {
    const out_ = [];

    for (const v of graph.verticesById.values()) {
      const bucket = v.adjFrom?.get('E');

      if (bucket === undefined) {
        continue;
      }

      for (const e of bucket) {
        out_.push(e.toId);
      }
    }

    return out_.length;
  },

  // 4. + read the endpoint VERTEX through the memoized getter — what the engine does.
  rowsto: () => {
    const out_ = [];

    for (const v of graph.verticesById.values()) {
      const bucket = v.adjFrom?.get('E');

      if (bucket === undefined) {
        continue;
      }

      for (const e of bucket) {
        out_.push(e.to);
      }
    }

    return out_.length;
  },

  // 5. The same, reading the getter TWICE per edge. The marginal cost of the second read is the
  //    per-call cost of a WARM getter with the first-resolution cost removed — which is the number
  //    the profile's 24.6% is a claim about.
  rowstotwice: () => {
    const out_ = [];

    for (const v of graph.verticesById.values()) {
      const bucket = v.adjFrom?.get('E');

      if (bucket === undefined) {
        continue;
      }

      for (const e of bucket) {
        const a = e.to;
        const b = e.to;

        // Two reads, one push, and no ternary — the first version wrote
        // `push(e.to === undefined ? e.to : e.to)`, which conflated a comparison with the reads
        // and is why its 177 ns reading is not quoted anywhere.
        if (a === b) {
          out_.push(a);
        }
      }
    }

    return out_.length;
  },

  // 5b. ⚠️ A PROBE-ONLY HACK, and the decisive one. `rowstoid` pays 33 ns an edge over `rowsedge`
  //     for reading `e.toId`, which is a getter returning a private string field — implausibly
  //     dear for that, so either the getter is not being inlined or the 33 ns is the `push` of a
  //     string rather than the read. This arm stashes the SAME string as a plain own property once
  //     (outside the timed loop) and reads that instead, so the only difference from `rowstoid` is
  //     getter-versus-plain-property. If it lands at `rowsedge`, the getter is the cost and a
  //     layout change could recover it; if it lands at `rowstoid`, the getter is free and the cost
  //     is the push.
  rowsplain: () => {
    const out_ = [];

    for (const v of graph.verticesById.values()) {
      const bucket = v.adjFrom?.get('E');

      if (bucket === undefined) {
        continue;
      }

      for (const e of bucket) {
        out_.push(e.__probeTo);
      }
    }

    return out_.length;
  },

  // 7. ⚠️ THE CEILING FOR A FLAT ADJACENCY, which item 1494 priced at ~1.6x from arithmetic rather
  //    than measurement. This arm measures it instead: parallel dense arrays built ONCE outside the
  //    timed loop, so the walk pays no per-vertex `Map.get`, no `Set` iteration and no endpoint
  //    getter — the three shares that item 1494's decomposition left as the only levers.
  //
  //    It is deliberately the OPTIMISTIC bound and it is not a design:
  //      - it assumes the structure is already built and valid, so it excludes ALL maintenance
  //        cost, which is precisely what disqualified the global dense ordinal at items
  //        1369-1372/1397 (deletes 6.18x/11.34x under churn) and what item 680 records on the Rust
  //        side (one `add_edge` demotes every later read for the session);
  //      - it holds ONE type's neighbours, where a real structure needs per-type offsets.
  //    So read it as "what is the most this lever could ever be worth", and nothing more. The
  //    build cost is reported separately below, because whether it can be maintained incrementally
  //    or must be rebuilt is the question that decides the design.
  flatceiling: () => {
    const out_ = [];
    const { off, nbr } = flat;

    for (let i = 0; i < off.length - 1; i += 1) {
      const end = off[i + 1];

      for (let k = off[i]; k < end; k += 1) {
        out_.push(nbr[k]);
      }
    }

    return out_.length;
  },

  // 8. ⚠️ THE SAME STRUCTURE UNDER CHURN, which is the number that decides the design rather than
  //    the ceiling above. One edge added per rep, then the structure rebuilt, then walked — the
  //    naive invalidation policy (drop on any adjacency write, rebuild on the next read). This is
  //    item 680's failure mode priced on the TS side: there, `rebuild_csr` runs only at LOAD and
  //    every adjacency write clears `csr_fresh` with nothing to re-arm it, so ONE `add_edge`
  //    demotes every later read for the whole session.
  //
  //    If this lands above the engine's reading, a rebuild-on-read-after-write cache is WORSE than
  //    today for any write-interleaved workload, and the lever needs incremental maintenance of a
  //    packed array — which is the hard part, not the walk.
  flatchurn: () => {
    const n = churnCounter;

    churnCounter += 1;
    graph.addEdge({
      id: `churn${n}`,
      labels: ['E'],
      from: graph.getVertexById(`v${n % NODES}`),
      to: graph.getVertexById(`v${(n * 7919 + 1) % NODES}`),
    });

    const rebuilt = buildFlat();
    const out_ = [];
    const { off, nbr } = rebuilt;

    for (let i = 0; i < off.length - 1; i += 1) {
      const end = off[i + 1];

      for (let k = off[i]; k < end; k += 1) {
        out_.push(nbr[k]);
      }
    }

    // One edge more than the baseline per rep, so this arm is excluded from the agreement check.
    return out_.length;
  },

  // 9. ⚠️ THE MAINTAINABLE MIDDLE, and the most decision-relevant arm of the nine. `flatceiling`
  //    wins 30x and `flatchurn` loses 1.47x, so the lever's whole problem is that a GLOBAL packed
  //    array cannot absorb an insert — it has to be rebuilt. A per-vertex ARRAY can: appending is
  //    O(1) amortized and touches one vertex, so there is nothing to invalidate and no rebuild.
  //
  //    This arm models exactly that — nested arrays in place of `Map<string, Set<Edge>>` — so it
  //    keeps a per-vertex indirection and the endpoint resolution, and only replaces the `Set`
  //    iteration (38% of the row per item 1494) with an array walk. It is mildly optimistic about
  //    the type lookup, since a real box still needs to select the type.
  arrayadj: () => {
    const out_ = [];

    for (const nbrs of perVertex) {
      for (const n of nbrs) {
        out_.push(n);
      }
    }

    return out_.length;
  },

  // 9b. ⚠️ THE SAME, HOLDING EDGES RATHER THAN PRE-RESOLVED ENDPOINTS. `arrayadj` stores `e.to`,
  //     which a real adjacency box cannot do on its own: `outE`, edge properties and edge labels
  //     all need the edge. This arm holds `Edge[]` and reads `.to` during the walk, so it re-adds
  //     the ~10 ns an edge item 1494 measured for a warm endpoint read. It is the honest version
  //     of the maintainable design.
  arrayedge: () => {
    const out_ = [];

    for (const es of perVertexEdges) {
      for (const e of es) {
        out_.push(e.to);
      }
    }

    return out_.length;
  },

  // 9c. ⚠️ THE CONTROL THAT INVALIDATES arrayadj/arrayedge AS A PREDICTION (item 1498). Those arms
  //     build their nested arrays in ONE tight loop, so the buckets land contiguously and the walk
  //     has near-perfect locality — which the engine's buckets never have, being allocated
  //     interleaved with vertices and edges across 400,000 `addEdge` calls. This arm builds nested
  //     SETS the same way. If it lands with `arrayedge` rather than with `engine`, then the gap
  //     those arms measured was LOCALITY, not the container, and item 1495's 4.1x was never a
  //     prediction about changing the storage type.
  setedge: () => {
    const out_ = [];

    for (const es of perVertexSets) {
      for (const e of es) {
        out_.push(e.to);
      }
    }

    return out_.length;
  },

  // 6. The engine.
  engine: () => toArray(plan, graph).length,
};

const names = ONLY === undefined ? Object.keys(ARMS) : [ONLY];

for (const n of names) {
  if (ARMS[n] === undefined) {
    throw new Error(`unknown ARM ${n}; have ${Object.keys(ARMS).join(',')}`);
  }
}

const med = (xs) => {
  const s = [...xs].sort((a, b) => a - b);

  return s[(s.length - 1) >> 1];
};

const results = [];

for (const name of names) {
  const r = await profileWindow(process.env.PROF_OUT, () => {
    const reps = [];
    let answer = 0;

    for (let i = 0; i < REPS; i += 1) {
      const t0 = performance.now();

      answer = ARMS[name]();
      reps.push(performance.now() - t0);
    }

    return { ms: med(reps.slice(DROP)), answer };
  });

  results.push({ name, ...r });
}

// ⚠️ EVERY arm answers 400,000 here — including `reach`, which counts rather than materializing.
// So this is a real agreement check, not a decoration.
/** The `v*` ladder counts VERTICES; everything else counts edges. */
const VERTEX_ARMS = new Set(['vonly', 'vbox', 'vget']);
const UNCHECKED_ARMS = new Set(['flatchurn']);

for (const r of results) {
  if (UNCHECKED_ARMS.has(r.name)) {
    continue;
  }

  if (VERTEX_ARMS.has(r.name)) {
    if (r.answer !== NODES) {
      throw new Error(`ARM ${r.name} answered ${r.answer}, expected ${NODES} vertices.`);
    }

    continue;
  }

  if (r.answer !== EDGES) {
    throw new Error(
      `ARM ${r.name} answered ${r.answer}, expected ${EDGES} — it is not walking the same edges.`,
    );
  }
}

console.log(`\nHOP ROWS FLOOR — NODES=${NODES} FANOUT=${FANOUT} EDGES=${EDGES} REPS=${REPS}\n`);

if (buildMs > 0.01) {
  console.log(`flat adjacency BUILD: ${buildMs.toFixed(2)} ms (excluded from every arm below)\n`);
}

console.log(
  `${'arm'.padEnd(13)}${'ms'.padStart(9)}${'ns/edge'.padStart(10)}${'vs reach'.padStart(10)}`,
);

const base = results.find((r) => r.name === 'reach')?.ms;

for (const r of results) {
  const ns = ((r.ms * 1e6) / EDGES).toFixed(2);
  const rel = base === undefined ? '' : `${(r.ms / base).toFixed(2)}x`;

  console.log(
    `${r.name.padEnd(13)}${r.ms.toFixed(2).padStart(9)}${ns.padStart(10)}${rel.padStart(10)}`,
  );
}

console.log();

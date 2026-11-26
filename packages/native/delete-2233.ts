/**
 * ITEM 2233 — DELETES, the last write-path shape with no floored measurement.
 *
 * What IS recorded: deletes at 6.18x/11.34x under churn were the reason the DENSE VERTEX ORDINAL design
 * was disqualified (items 1369-1372/1397) — a statement about a REJECTED design, not about this engine. And
 * item 2200 showed by-id lookup is unharmed by churn. The delete path's own cost has never been floored.
 *
 * The floor must cascade: `removeVertex` has to drop the vertex's incident edges, so a floor that only
 * deletes a map entry would be measuring a different operation (item 698's error, mirrored).
 *
 * ONE ARM PER PROCESS, a cheap sink, and a fresh graph per rep.
 */
import { Graph } from '@lenke/core';

const NODES = Number(process.env.NODES ?? 40_000);
const FANOUT = Number(process.env.FANOUT ?? 2);
const DELETES = Number(process.env.DELETES ?? 10_000);
const REPS = Number(process.env.REPS ?? 5);

const build = (): Graph => {
  const g = new Graph();

  for (let i = 0; i < NODES; i += 1) {
    g.addVertex({ id: `u${i}`, labels: ['P'], properties: { k: i % 100 } });
  }

  for (let k = 0; k < NODES * FANOUT; k += 1) {
    const from = k % NODES;
    const to = (from * 7 + Math.floor(k / NODES) * 2657 + 1) % NODES;

    if (to === from) {
      continue;
    }

    g.addEdge({
      id: `e${k}`,
      from: g.getVertexById(`u${from}`)!,
      to: g.getVertexById(`u${to}`)!,
      labels: ['E'],
      properties: {},
    });
  }

  return g;
};

/** Delete every Nth vertex, cascading its edges — the engine's own path. */
const removeVertices = (g: Graph): number => {
  const step = Math.max(1, Math.floor(NODES / DELETES));

  for (let i = 0; i < NODES; i += step) {
    const v = g.getVertexById(`u${i}`);

    if (v != null) {
      g.removeVertex(v);
    }
  }

  return g.vertexCount;
};

/** Delete edges only — isolates the cascade from the vertex removal. */
const removeEdges = (g: Graph): number => {
  const step = Math.max(1, Math.floor((NODES * FANOUT) / DELETES));

  for (let k = 0; k < NODES * FANOUT; k += step) {
    const e = g.getEdgeById(`e${k}`);

    if (e != null) {
      g.removeEdge(e);
    }
  }

  return g.edgeCount;
};

/**
 * The FLOOR: the same deletions done by hand against plain maps that mirror the engine's indexes —
 * by-id, by-label, and both adjacency directions. It cascades, because `removeVertex` must.
 */
const handRolledBuild = (): {
  byId: Map<string, { id: string; k: number }>;
  byLabel: Set<string>;
  outAdj: Map<string, Set<string>>;
  inAdj: Map<string, Set<string>>;
  edgeEnds: Map<string, { from: string; to: string }>;
} => {
  const byId = new Map<string, { id: string; k: number }>();
  const byLabel = new Set<string>();
  const outAdj = new Map<string, Set<string>>();
  const inAdj = new Map<string, Set<string>>();
  const edgeEnds = new Map<string, { from: string; to: string }>();

  for (let i = 0; i < NODES; i += 1) {
    byId.set(`u${i}`, { id: `u${i}`, k: i % 100 });
    byLabel.add(`u${i}`);
  }

  for (let k = 0; k < NODES * FANOUT; k += 1) {
    const from = `u${k % NODES}`;
    const to = `u${((k % NODES) * 7 + Math.floor(k / NODES) * 2657 + 1) % NODES}`;

    if (from === to) {
      continue;
    }

    edgeEnds.set(`e${k}`, { from, to });

    let o = outAdj.get(from);

    if (o === undefined) {
      o = new Set<string>();
      outAdj.set(from, o);
    }

    o.add(`e${k}`);

    let n = inAdj.get(to);

    if (n === undefined) {
      n = new Set<string>();
      inAdj.set(to, n);
    }

    n.add(`e${k}`);
  }

  return { byId, byLabel, outAdj, inAdj, edgeEnds };
};

/**
 * **THE FIXTURE BUILD IS ~75% OF EVERY ARM, SO IT MUST BE SUBTRACTABLE.** The first version of this
 * probe measured `build` at 17,994 ns/delete while doing NO deletes — a large cost shared by every arm,
 * which is item 2227's dilution in a different coat (there it was the sink, here it is the setup). Both
 * halves therefore get their own arm: `build`/`floorbuild` measure setup, `vertices`/`floor` measure
 * setup + work, and the DIFFERENCE is the per-delete cost.
 */
const handRolledDelete = (): number => {
  const { byId, byLabel, outAdj, inAdj, edgeEnds } = handRolledBuild();
  const step = Math.max(1, Math.floor(NODES / DELETES));

  for (let i = 0; i < NODES; i += step) {
    const id = `u${i}`;

    /* Cascade: drop every incident edge from both adjacency maps and the edge table. */
    for (const eid of [...(outAdj.get(id) ?? []), ...(inAdj.get(id) ?? [])]) {
      const ends = edgeEnds.get(eid);

      if (ends !== undefined) {
        outAdj.get(ends.from)?.delete(eid);
        inAdj.get(ends.to)?.delete(eid);
        edgeEnds.delete(eid);
      }
    }

    outAdj.delete(id);
    inAdj.delete(id);
    byLabel.delete(id);
    byId.delete(id);
  }

  return byId.size;
};

const arm = process.env.ARM ?? 'vertices';

const run = (): number => {
  if (arm === 'floor') {
    return handRolledDelete();
  }

  if (arm === 'edges') {
    return removeEdges(build());
  }

  if (arm === 'build') {
    return build().vertexCount;
  }

  if (arm === 'floorbuild') {
    return handRolledBuild().byId.size;
  }

  return removeVertices(build());
};

let sink = 0;

for (let w = 0; w < 2; w += 1) {
  sink += run();
}

const t0 = performance.now();

for (let i = 0; i < REPS; i += 1) {
  sink += run();
}

const perDelete = ((performance.now() - t0) * 1e6) / REPS / DELETES;

console.log(
  `  ${arm.padEnd(9)} ${perDelete.toFixed(0).padStart(7)} ns/delete  (sink ${sink > 0 ? 'ok' : 'ZERO'})`,
);

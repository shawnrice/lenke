/**
 * WHY IS `MATCH ACYCLIC` 348x `MATCH TRAIL`? (item 2001)
 *
 * Item 2000 priced it: at 40,000 vertices, fanout 5, bound `{1,2}`, `count(*)` over the same pattern
 * reads **1.58 ms plain, 2.36 ms TRAIL, 821.13 ms ACYCLIC** — linear+ in |V|, so the gap grows. This
 * probe asks what the 821 ms is DOING.
 *
 * **THE PROFILE IS WINDOWED, AND THAT IS NOT OPTIONAL HERE.** `PROBES.md`'s closed-frames table
 * exists because every profile in this package surfaces the same construction frames
 * (`indexEdgeLabel`, `commitElementLabels`, `#commitNormalized`, `addVertex`, GC), all of them closed
 * targets, and "a profile whose top frames are these has measured the FIXTURE, not the thing you
 * asked about". The fixture here is 40,000 vertices and 200,000 edges, so unwindowed it would
 * dominate. `profileWindow` starts the profiler AFTER the build.
 *
 * **AND IT PROFILES BOTH SIBLINGS, NOT JUST THE SLOW ONE.** A profile of ACYCLIC alone names its
 * own hot frames, which is not the same question — the question is what ACYCLIC does that TRAIL does
 * not. A frame that is 40% of both is not the gap however large it looks, and this is the shape of
 * mistake items 1993-1997 made four times in a row (four mechanism hypotheses, all refuted, settled
 * only when a counter compared the two SIDES rather than inspecting one).
 *
 * TRAIL's window is given MORE REPS so both windows hold a comparable number of samples: at 348x,
 * equal reps would give the TRAIL profile ~0.3% of the samples and its frame shares would be noise.
 *
 *     PROF_OUT=/tmp/x bun acyclic-prof-2001.mjs          # writes <PROF_OUT>-{acyclic,trail}.cpuprofile
 *     NODES=20000 bun acyclic-prof-2001.mjs              # smaller, faster
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

import { profileWindow } from './windowed-profile.mjs';

const NODES = Number(process.env.NODES ?? 40_000);
const FANOUT = Number(process.env.FANOUT ?? 5);
const BOUND = process.env.BOUND ?? '{1,2}';
const OUT = process.env.PROF_OUT;

/*
 * THE GENERATOR SPLITS ON THE REPEAT INDEX — CLAUDE.md's hard rule. `to = (a*k + b) % N` is
 * invariant under `k -> k + N`, so a flat loop over `k < N*FANOUT` sends one vertex's whole fanout to
 * the SAME target: out-degree, in-degree and isolated-vertex counts all look perfect, the graph is
 * FUNCTIONAL, and a k-hop count is `F^k * N` by construction. That defect made items 1516/1518's
 * fixtures return correct answers 14x fast.
 *
 * AND IT MATTERS MORE HERE THAN ANYWHERE: a collapsed generator makes every path a REPEATED
 * VERTEX, so ACYCLIC would reject nearly everything and this probe would measure an empty answer.
 */
const build = () => {
  const g = new Graph();

  for (let i = 0; i < NODES; i += 1) {
    g.addVertex({ id: String(i + 1), labels: ['T'], properties: { n: i % 97, d: i } });
  }

  for (let e = 0; e < NODES * FANOUT; e += 1) {
    const i = e % NODES;
    const hop = Math.floor(e / NODES);

    g.addEdge({
      id: `e${String(e)}`,
      from: g.getVertexById(String(i + 1)),
      to: g.getVertexById(String(((i * 7 + 3 + hop * 2_654_435_761) % NODES) + 1)),
      labels: ['E'],
      properties: { w: i % 13 },
    });
  }

  return g;
};

const g = build();

// FIXTURE CHECK: distinct targets per source must be FANOUT, or the generator collapsed.
const degrees = new Set();

for (const v of g.vertices) {
  const box = v.adjFrom?.get('E');

  if (box !== undefined) {
    const tos = new Set();

    for (const edge of box) {
      tos.add(edge.to.id);
    }

    degrees.add(tos.size);
  }
}

/*
 * `PROJ` SWITCHES THE PROJECTION, which is the whole axis (item 2003). `count(*)` and
 * `RETURN DISTINCT b.n` ask the same pattern of the same graph and take DIFFERENT rungs — item 2002
 * routed the count and left the DISTINCT at 1405 ms against its plain twin's 60, so the two have to
 * be profiled separately or the count's cure masks the DISTINCT's cost.
 * [[vary-only-the-projection]].
 */
const PROJ = process.env.PROJ === 'distinct' ? 'RETURN DISTINCT b.n AS x' : 'RETURN count(*) AS x';
const ACYCLIC = `MATCH ACYCLIC (a:T)-[:E]->${BOUND}(b:T) ${PROJ}`;
const TRAIL = `MATCH TRAIL (a:T)-[:E]->${BOUND}(b:T) ${PROJ}`;
const PLAIN = `MATCH (a:T)-[:E]->${BOUND}(b:T) ${PROJ}`;

const once = (text) => [...query(g, text, { p0: 3 })];
const time = (text, reps) => {
  const ts = [];
  let rows;

  for (let r = 0; r < reps; r += 1) {
    const t0 = performance.now();

    rows = once(text);
    ts.push(performance.now() - t0);
  }

  return { ms: [...ts].sort((a, b) => a - b)[Math.floor(ts.length / 2)], rows };
};

console.log(
  `|V|=${String(g.vertexCount)} |E|=${String(g.edgeCount)} bound=${BOUND} distinct-targets-per-source=${JSON.stringify([...degrees])}`,
);

/*
 * THE ANSWERS ARE PRINTED SIDE BY SIDE FIRST. ACYCLIC and TRAIL are DIFFERENT questions — one
 * forbids a repeated vertex, the other a repeated edge — so they need not agree, and a probe that
 * assumed they would could "fix" ACYCLIC by making it answer TRAIL's question. Printing both counts
 * is the guard: any cure must leave the ACYCLIC number exactly where it is here.
 */
for (const [name, text, reps] of [
  ['plain  ', PLAIN, 5],
  ['TRAIL  ', TRAIL, 5],
  ['ACYCLIC', ACYCLIC, 3],
]) {
  const { ms, rows } = time(text, reps);

  console.log(`${name}  ${ms.toFixed(2).padStart(9)} ms   count=${JSON.stringify(rows)}`);
}

if (OUT !== undefined) {
  // MORE REPS FOR THE FAST SIBLING so both profiles hold comparable sample counts. At 348x, equal
  // reps would leave the TRAIL window with ~0.3% of the samples and its shares would be noise.
  await profileWindow(`${OUT}-acyclic.cpuprofile`, () => {
    for (let r = 0; r < 3; r += 1) {
      once(ACYCLIC);
    }
  });
  await profileWindow(`${OUT}-trail.cpuprofile`, () => {
    for (let r = 0; r < 300; r += 1) {
      once(TRAIL);
    }
  });
  console.log(`\nwrote ${OUT}-acyclic.cpuprofile and ${OUT}-trail.cpuprofile`);
}

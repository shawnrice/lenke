/**
 * WHAT DOES REACHING AN ALGORITHM THROUGH A SURFACE COST, over calling it directly?
 *
 * Items 1467-1470 optimized the twelve procedures themselves, measured through `runAlgorithmSync` —
 * which is the entry point both engines dispatch through, but is NOT how a user reaches them. A user
 * writes `CALL pagerank() YIELD node, score` in ISO-GQL or `g.pageRank()` in Gremlin, and each
 * surface wraps the result before handing it back. That wrapper has never been measured.
 *
 * ⚠️ THERE IS A SPECIFIC REASON TO SUSPECT IT. The GQL `CALL` handler materializes the outer stream
 * and then, for every outer binding, maps over EVERY result row building `new Map(binding)` — a
 * Map clone per row. A whole-graph procedure returns one row per vertex, so at 160,000 vertices that
 * is 160,000 Map allocations layered on top of the algorithm. Whether that is visible against the
 * algorithm's own cost is the question; it is not obvious either way, which is why it is measured
 * rather than assumed.
 *
 * Arms (one per process — item 762):
 *
 *   direct    runAlgorithmSync(name, cfg, graph)              the floor: no surface at all
 *   gql       query(g, 'CALL <name>() YIELD node, <col> RETURN count(*)')
 *   gqlbare   query(g, 'CALL <name>() RETURN count(*)')        YIELD-less, same procedure
 *   gremlin   the Gremlin OLAP step for the same procedure
 *
 * ⚠️ `count(*)` IS DELIBERATE, and it is the control for its own trap: every arm must consume the
 * same number of rows without the COMPARISON being about how they are rendered. A `RETURN node.name`
 * arm would additionally pay property reads per row and confound the wrapper question with a
 * projection question.
 *
 *   ARM=gql ALGO=pagerank NODES=40000 REPS=7 node algo-surface-overhead-probe.mjs
 *
 * The fixture is built ONCE and shared by every rep, and only one is ever built per process —
 * a mutated `Graph` is retained in full until the microtask queue drains, which a synchronous body
 * cannot do (see `graph-retention-probe.mjs`).
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

import { profileWindow } from './windowed-profile.mjs';

const ARM = process.env.ARM ?? 'direct';
const ALGO = process.env.ALGO ?? 'pagerank';
const NODES = Number(process.env.NODES ?? 40_000);
const FANOUT = Number(process.env.FANOUT ?? 2);
const REPS = Number(process.env.REPS ?? 7);
const DROP = Number(process.env.DROP ?? 2);

const ARMS = ['direct', 'gql', 'gqlbare', 'gremlin'];

if (!ARMS.includes(ARM)) {
  throw new Error(`unknown ARM ${ARM}; have ${ARMS.join(',')}`);
}

/** The result column each procedure exposes, which `YIELD` has to name exactly. */
const COLUMN = {
  pagerank: 'score',
  degree: 'degree',
  connectedComponents: 'componentId',
  labelPropagation: 'label',
  shortestPath: 'distance',
};

if (COLUMN[ALGO] === undefined) {
  throw new Error(`unknown ALGO ${ALGO}; have ${Object.keys(COLUMN).join(',')}`);
}

/**
 * ⚠️ `WRITE=1` IS THE CONTROL FOR A FALSE COMPARISON. The `gremlin` arm looked like it had the
 * highest surface overhead (30.86 against `direct`'s 21.09 on pagerank at 40,000), but a Gremlin
 * OLAP step is SPECIFIED to write its result to a vertex property and pass the traversers through,
 * which `CALL` and the direct call do not do. Its profile shows `setProperty` + `#commitNormalized`
 * at ~15% — real work, not wrapper cost.
 *
 * So `direct` on its own is the wrong floor for that arm. `WRITE=1` adds `writeProperty` to the
 * direct and GQL arms, making them do the same work, and the remaining gap is the actual wrapper.
 */
const WRITE = process.env.WRITE === '1';
const CONFIG = {
  ...(ALGO === 'shortestPath' ? { source: 'v0' } : {}),
  ...(WRITE ? { writeProperty: 'algoOut' } : {}),
};

const build = () => {
  const g = new Graph();
  const vs = [];

  for (let i = 0; i < NODES; i += 1) {
    vs.push(g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i % 97 } }));
  }

  for (let e = 0; e < NODES * FANOUT; e += 1) {
    const i = e % NODES;
    const hop = Math.floor(e / NODES);

    g.addEdge({
      id: `e${e}`,
      from: vs[i],
      to: vs[(i * 7 + 3 + hop * 2_654_435_761) % NODES],
      labels: ['E'],
      properties: { w: (e % 13) + 1 },
    });
  }

  return g;
};

const graph = build();

/** Each arm returns a number the caller prints, so an arm that silently did nothing is visible. */
const run = async () => {
  if (ARM === 'direct') {
    const { runAlgorithmSync } = await import('@lenke/core');

    return () => runAlgorithmSync(ALGO, CONFIG, graph).length;
  }

  if (ARM === 'gql' || ARM === 'gqlbare') {
    const args = ALGO === 'shortestPath' ? "source => 'v0'" : '';
    const yielded = ARM === 'gql' ? ` YIELD node, ${COLUMN[ALGO]}` : '';
    const text = `CALL ${ALGO}(${args})${yielded} RETURN count(*) AS n`;

    return () => Number(query(graph, text)[0].n);
  }

  // ⚠️ GREMLIN'S OLAP MODEL IS NOT GQL'S, and the arm reflects that rather than papering over it.
  // `CALL` YIELDs rows; a Gremlin OLAP step WRITES a property and passes the traversers through, so
  // the comparable shape is `V() -> step() -> count()`. The two numbers are therefore "what each
  // surface costs to reach the same procedure", not two renderings of one operation.
  //
  // ⚠️ `toArray(plan, graph)` IN THAT ORDER — the reverse throws, and the Gremlin bench records
  // losing a round to it (item 1349).
  const gremlin = await import('@lenke/gremlin');
  const step = {
    pagerank: 'pageRank',
    degree: 'degree',
    connectedComponents: 'connectedComponent',
    labelPropagation: 'labelPropagation',
    shortestPath: 'shortestPath',
  }[ALGO];

  if (typeof gremlin[step] !== 'function') {
    throw new Error(`@lenke/gremlin exports no step ${step} for ALGO=${ALGO}`);
  }

  const plan = gremlin.traversal(gremlin.V(), gremlin[step](), gremlin.count());

  return () => Number(gremlin.toArray(plan, graph)[0]);
};

const once = await run();
const reps = [];
let answer;

const measure = () => {
  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();

    answer = once();
    reps.push(performance.now() - t0);
  }
};

await profileWindow(process.env.PROF_OUT, measure);

const kept = reps.slice(DROP).sort((a, b) => a - b);
const median =
  kept.length % 2 === 1
    ? kept[(kept.length - 1) / 2]
    : (kept[kept.length / 2 - 1] + kept[kept.length / 2]) / 2;

console.log(
  `ARM=${ARM} ALGO=${ALGO} V=${NODES} answer=${answer} median=${median.toFixed(2)} ms  series=[${reps.map((x) => x.toFixed(1)).join(' ')}]`,
);

/**
 * THE SAME LOGICAL QUERY, WRITTEN IN BOTH SURFACES, OVER ONE FIXTURE.
 *
 * Every instrument in this corpus measures one surface. `runtime-profile-probe.mjs` is ISO-GQL,
 * `runtime-profile-gremlin-probe.mjs` is Gremlin, and they do not even share a fixture — the GQL one
 * builds one edge per vertex, the Gremlin one has a `FANOUT` knob defaulting to 5. So "is one surface
 * paying more than the other for the same question?" has never been askable, let alone asked.
 *
 * ⚠️ `cross-engine` IN THIS REPO MEANS TS vs RUST. This is cross-SURFACE: both arms are the pure-TS
 * engine, and a gap is a gap between two front ends lowering to the same data, not between
 * implementations of the same front end. A large one is a target on the slower surface; a small one
 * says the shared layers dominate and neither front end is the problem.
 *
 * ⚠️ EVERY PAIR ASSERTS ITS TWO ANSWERS AGREE, and that is not a formality — it is the only thing
 * standing between a real finding and a mistranslated query. A pair whose arms answer differently is
 * measuring two different questions, and the ratio would be meaningless. The probe refuses rather
 * than printing it.
 *
 * ⚠️ NO BARE `count()` TAIL WHERE IT CAN BE AVOIDED. Item 1479 lost a measurement to this: a chain
 * count answers `V().out('E').count()` WITHOUT walking (0.07 ms), so a pair ending in a bare count
 * can compare a shortcut against a walk. Where both surfaces have the shortcut it is a fair
 * comparison of shortcuts; where only one does, the pair says so in its note.
 *
 *     NODES=50000 FANOUT=5 REPS=9 node cross-surface-probe.mjs
 *     PAIR=hopcount node cross-surface-probe.mjs
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';
import {
  V,
  count,
  groupCount,
  has,
  hasLabel,
  out,
  toArray,
  traversal,
  values,
  where,
} from '@lenke/gremlin';

const NODES = Number(process.env.NODES ?? 50_000);
const FANOUT = Number(process.env.FANOUT ?? 5);
const REPS = Number(process.env.REPS ?? 9);
const DROP = Number(process.env.DROP ?? 3);
const ONLY = process.env.PAIR;

const build = () => {
  const g = new Graph();
  const vs = [];

  for (let i = 0; i < NODES; i += 1) {
    vs.push(g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i % 97, n: i } }));
  }

  for (let e = 0; e < NODES * FANOUT; e += 1) {
    const i = e % NODES;
    const hop = Math.floor(e / NODES);

    g.addEdge({
      id: `e${e}`,
      from: vs[i],
      to: vs[(i * 7 + 3 + hop * 2_654_435_761) % NODES],
      labels: ['E'],
      properties: { w: e % 13 },
    });
  }

  return g;
};

/**
 * Each pair's two arms must produce a COMPARABLE answer, so each supplies a `norm` that reduces its
 * surface's result shape to one value. GQL returns rows of objects; Gremlin returns a bare stream.
 */
const PAIRS = {
  hopcount: {
    note: 'one typed hop, counted — both surfaces have a chain-count shortcut here',
    gql: 'MATCH (a:P)-[:E]->(b:P) RETURN count(*) AS c',
    gremlin: () => traversal(V(), hasLabel('P'), out('E'), count()),
  },
  hopfiltered: {
    note: 'a hop behind a property filter on the SOURCE',
    gql: 'MATCH (a:P)-[:E]->(b:P) WHERE a.k = 5 RETURN count(*) AS c',
    gremlin: () => traversal(V(), hasLabel('P'), has('k', 5), out('E'), count()),
  },
  project: {
    note: 'a bare property read per vertex — no aggregation to hide it behind',
    gql: 'MATCH (n:P) RETURN n.k AS k',
    gremlin: () => traversal(V(), hasLabel('P'), values('k')),
    norm: (rows) => rows.length,
  },
  exists: {
    note: 'existence of a hop: GQL EXISTS subquery against Gremlin where(out)',
    gql: 'MATCH (a:P) WHERE a.k = 5 AND EXISTS { MATCH (a)-[:E]->(b:P) } RETURN count(*) AS c',
    gremlin: () => traversal(V(), hasLabel('P'), has('k', 5), where(out('E')), count()),
  },
  grouped: {
    note: 'a grouped count over a low-cardinality key (97 groups)',
    gql: 'MATCH (n:P) RETURN n.k AS k, count(*) AS c',
    gremlin: () => traversal(V(), hasLabel('P'), groupCount({ by: 'k' })),
    // GQL yields one row per group; Gremlin yields one Map. Compare the group COUNT.
    norm: (r) => (Array.isArray(r) && r.length > 0 && r[0] instanceof Map ? r[0].size : r.length),
  },
};

const names = ONLY === undefined ? Object.keys(PAIRS) : [ONLY];

for (const n of names) {
  if (PAIRS[n] === undefined) {
    throw new Error(`unknown PAIR ${n}; have ${Object.keys(PAIRS).join(',')}`);
  }
}

const med = (xs) => {
  const s = [...xs].sort((a, b) => a - b);

  return s[(s.length - 1) >> 1];
};

/** Default normalizer: a single scalar out of a one-row/one-value answer. */
const defaultNorm = (r) => {
  if (!Array.isArray(r) || r.length === 0) {
    return 0;
  }

  const [first] = r;

  return typeof first === 'object' && first !== null && !(first instanceof Map)
    ? Number(Object.values(first)[0])
    : Number(first);
};

const graph = build();

console.log(
  `\nCROSS-SURFACE — NODES=${NODES} FANOUT=${FANOUT} REPS=${REPS} DROP=${DROP}  (both arms are the pure-TS engine)\n`,
);
console.log(
  `${'pair'.padEnd(13)}${'gql ms'.padStart(10)}${'gremlin ms'.padStart(12)}${'ratio'.padStart(10)}  answer`,
);

for (const name of names) {
  const pair = PAIRS[name];
  const norm = pair.norm ?? defaultNorm;
  const plan = pair.gremlin();
  const timed = (fn) => {
    const reps = [];
    let answer;

    for (let r = 0; r < REPS; r += 1) {
      const t0 = performance.now();

      answer = fn();
      reps.push(performance.now() - t0);
    }

    return { ms: med(reps.slice(DROP)), answer };
  };

  const g = timed(() => norm(query(graph, pair.gql)));
  const m = timed(() => norm(toArray(plan, graph)));

  // ⚠️ THE GUARD, not a formality: different answers mean two different questions.
  if (g.answer !== m.answer) {
    throw new Error(
      `PAIR ${name} ARMS DISAGREE — gql=${g.answer} gremlin=${m.answer}. ` +
        `The queries are not the same question, so the ratio would be meaningless.`,
    );
  }

  const ratio = g.ms === 0 ? Number.NaN : m.ms / g.ms;
  const faster = ratio > 1 ? 'gql faster' : 'gremlin faster';

  console.log(
    `${name.padEnd(13)}${g.ms.toFixed(2).padStart(10)}${m.ms.toFixed(2).padStart(12)}` +
      `${`${ratio.toFixed(2)}x`.padStart(10)}  ${g.answer}  (${faster}; ${pair.note})`,
  );
}

console.log();

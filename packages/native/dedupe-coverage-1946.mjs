// Item 1946 — DOES THE SHORT-CIRCUIT STILL PAY AT LOW START-LABEL COVERAGE?
//
// Item 1945 priced the deduped hop at 234.4 ms against a 73.2 ceiling (3.2x) and named the
// mechanism: a `DISTINCT` needs EXISTENCE, not a count, so a far-vertex pass can `break` on the
// first qualifying in-edge. It also flagged the prerequisite this probe answers rather than
// assuming item 1940's band transfers:
//
//   "a SELECTIVE start label makes the short-circuit useless — most far vertices have NO qualifying
//    in-edge, so every in-edge is scanned and nothing is saved"
//
// So the short-circuit's value is a function of coverage in a way the per-element arms' is not.
// At coverage 1.0 the first in-edge always qualifies (one check a vertex); at 0.05 almost none do
// (every in-edge checked, i.e. a full edge pass PLUS the per-vertex overhead — worse than just
// walking the edges). The crossover is what the gate needs, and it may differ from 0.4.
//
// Arms, all answering the same 8 values: the engine, a full edge pass, and the short-circuiting far
// pass. `|E|` is held CONSTANT as coverage varies (item 1938's fixture lesson).
//
//     bun dedupe-coverage-1946.mjs
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const NODES = Number(process.env.NODES ?? 100000);
const FANOUT = Number(process.env.FANOUT ?? 5);
const REPS = Number(process.env.REPS ?? 9);
const FRACS = (process.env.FRACS ?? '1,0.6,0.4,0.25,0.12,0.05').split(',').map(Number);

const Q = 'MATCH (a:T)-[:E]->(b:T) RETURN DISTINCT b.n AS x';

/** Every vertex is an edge source AND carries `T` as the far label; `tFrac` carry it as START. */
const build = (tFrac) => {
  const g = new Graph();
  const tCount = Math.max(1, Math.round(NODES * tFrac));

  for (let i = 0; i < NODES; i += 1) {
    // `T` on everything would be VACUOUS. `S` marks the start-eligible prefix and `T` is on all,
    // so the FAR label never moves and only the START label's coverage does — which is the variable
    // the short-circuit depends on.
    g.addVertex({
      id: String(i + 1),
      labels: i < tCount ? ['T', 'S'] : ['T'],
      properties: { n: i % 8 },
    });
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

  return g;
};

const QS = 'MATCH (a:S)-[:E]->(b:T) RETURN DISTINCT b.n AS x';

const handEdge = (g) => () => {
  const bucket = g.edgesByLabel.get('E');
  const seen = new Set();

  if (bucket !== undefined) {
    for (const edge of bucket) {
      if (edge.from.labels.has('S') && edge.to.labels.has('T')) {
        seen.add(edge.to.properties.n);
      }
    }
  }

  return seen.size;
};

const handFarFirst = (g) => () => {
  const seen = new Set();

  for (const far of g.vertices) {
    if (!far.labels.has('T')) {
      continue;
    }

    const bucket = far.adjTo?.get('E');

    if (bucket === undefined) {
      continue;
    }

    for (const edge of bucket) {
      if (edge.from.labels.has('S')) {
        seen.add(far.properties.n);
        break;
      }
    }
  }

  return seen.size;
};

const time = (fn) => {
  const ser = [];
  let got = 0;

  for (let r = 0; r < REPS + 2; r += 1) {
    const t0 = performance.now();

    got = fn();

    const ms = performance.now() - t0;

    if (r >= 2) {
      ser.push(ms);
    }
  }

  ser.sort((a, b) => a - b);

  return [ser[ser.length >> 1], got];
};

console.log(
  `${NODES} vertices / ${NODES * FANOUT} edges, median of ${REPS}. START label coverage varies;\n` +
    'the FAR label is on every vertex. `agree` must be true.\n',
);
console.log('S frac   engine   HAND-edge   HAND-far-first   eng/far   far/edge   agree');
console.log('-'.repeat(76));

for (const frac of FRACS) {
  const g = build(frac);
  const [eng, a] = time(() => query(g, QS, {}).length);
  const [edge, b] = time(handEdge(g));
  const [far, c] = time(handFarFirst(g));

  console.log(
    [
      frac.toFixed(2).padStart(6),
      eng.toFixed(1).padStart(8),
      edge.toFixed(1).padStart(11),
      far.toFixed(1).padStart(16),
      `${(eng / far).toFixed(2).padStart(8)}x`,
      `${(far / edge).toFixed(2).padStart(9)}x`,
      String(a === b && a === c).padStart(7),
    ].join(' '),
  );

  await new Promise((resolve) => setTimeout(resolve, 0));
}

console.log(
  `\nfar/edge ABOVE 1 means the short-circuit has stopped paying and a plain edge pass is better\n` +
    '   at that coverage — which is where the gate has to decline it.',
);
console.log(`(reference, T vacuous and no S filter: ${Q})`);

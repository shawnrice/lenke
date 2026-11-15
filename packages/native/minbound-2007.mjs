/**
 * IS A PER-LEVEL BFS EXACT FOR `{min>=2}` IN EVERY MODE? (item 2007)
 *
 * ⚠️⚠️ `{2,3}` DISTINCT costs **674x** its `{1,3}` twin (640.28 ms against 0.95 at 5,000 vertices)
 * because `reachQuantifierIsExact` refuses `min > 1` and the shape falls to path enumeration. The
 * refusal is CORRECT for the shortest-distance BFS it guards: a vertex found at `d = 1` may ALSO be
 * reachable at length 2, which that search cannot see.
 *
 * 🔑 A PER-LEVEL BFS could answer it — the union over `d` in `[min, max]` of "reachable in EXACTLY
 * `d` steps", one O(|V| + |E|) pass per level. But "exactly d steps" is a WALK notion, and the rung
 * also serves TRAIL, SIMPLE and the default (= trail). **On one vertex with one self-loop there is a
 * WALK of length 2 (`a->a->a`, reusing the edge) and no TRAIL of length 2** — so the modes can
 * diverge at `min >= 2` where they agree at `min <= 1`.
 *
 * ⚠️ MEASURED, NOT REASONED — items 2001/2003 each derived an acyclic fact wrong, and item 2003's
 * cheap cure died on a fixture it had not been shown. This asks the engine.
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const build = (n, edges) => {
  const g = new Graph();

  for (let i = 0; i < n; i += 1) {
    g.addVertex({ id: `v${String(i)}`, labels: ['T'], properties: { n: i } });
  }

  let e = 0;

  for (const [a, b] of edges) {
    g.addEdge({
      id: `e${String(e)}`,
      from: g.getVertexById(`v${String(a)}`),
      to: g.getVertexById(`v${String(b)}`),
      labels: ['E'],
      properties: {},
    });
    e += 1;
  }

  return g;
};

const FIXTURES = {
  'self-loop': [1, [[0, 0]]],
  'self-loop + chain': [
    3,
    [
      [0, 0],
      [0, 1],
      [1, 2],
    ],
  ],
  '2-cycle': [
    2,
    [
      [0, 1],
      [1, 0],
    ],
  ],
  '3-cycle': [
    3,
    [
      [0, 1],
      [1, 2],
      [2, 0],
    ],
  ],
  chain: [
    5,
    [
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 4],
    ],
  ],
  diamond: [
    4,
    [
      [0, 1],
      [0, 2],
      [1, 3],
      [2, 3],
    ],
  ],
  'parallel pair': [
    2,
    [
      [0, 1],
      [0, 1],
    ],
  ],
  'two self-loops': [
    1,
    [
      [0, 0],
      [0, 0],
    ],
  ],
  lollipop: [
    5,
    [
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 1],
      [1, 4],
    ],
  ],
};

const MODES = {
  WALK: 'MATCH WALK',
  TRAIL: 'MATCH TRAIL',
  SIMPLE: 'MATCH SIMPLE',
  default: 'MATCH',
};

/*
 * ⚠️ `no-raw-interpolation` IS SUPPRESSED ON THE CALL BELOW, with the reason here because the rule's
 * `disable-next-line` has to sit on the line it guards. `kw` and `bound` are literals from `MODES`
 * and the bound list in this file — nothing is caller- or data-derived — and the whole point of the
 * probe is to vary the MODE KEYWORD, which no `$param` can express: a parameter binds a VALUE, and
 * `MATCH TRAIL` is syntax. A tagged template would bind these as values and produce a syntax error.
 */
const setOf = (g, kw, bound) => {
  try {
    return JSON.stringify(
      // eslint-disable-next-line lenke/no-raw-interpolation -- trusted literals; see above
      [...query(g, `${kw} (x:T)-[:E]->${bound}(y:T) RETURN DISTINCT y.n AS v`, {})]
        .map((r) => r.v)
        .sort((a, b) => Number(a) - Number(b)),
    );
  } catch (err) {
    return `ERR ${String(err.code ?? err.message).slice(0, 12)}`;
  }
};

let diffs = 0;

console.log(
  'fixture             bound    WALK          TRAIL         SIMPLE        default   verdict',
);

for (const [name, [n, edges]] of Object.entries(FIXTURES)) {
  const g = build(n, edges);

  for (const bound of ['{2,2}', '{2,3}', '{3,3}']) {
    const w = setOf(g, MODES.WALK, bound);
    const t = setOf(g, MODES.TRAIL, bound);
    const s = setOf(g, MODES.SIMPLE, bound);
    const d = setOf(g, MODES.default, bound);
    const same = w === t && t === s && s === d;

    if (!same) {
      diffs += 1;
    }

    console.log(
      `${name.padEnd(19)} ${bound.padEnd(8)} ${w.padEnd(13)} ${t.padEnd(13)} ${s.padEnd(13)} ${d.padEnd(9)} ${same ? 'agree' : '⚠️ DIVERGE'}`,
    );
  }
}

console.log(
  `\n${String(diffs)} mode divergence(s) at min >= 2.\n` +
    `# ${diffs === 0 ? 'A per-level WALK BFS would answer every mode here — not refuted by these fixtures.' : 'The modes DIVERGE: a per-level WALK BFS cannot serve TRAIL/SIMPLE/default at min >= 2.'}`,
);

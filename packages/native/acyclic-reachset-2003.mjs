/**
 * DOES `ACYCLIC`'s REACHED SET DIFFER FROM `SIMPLE`'s ANYWHERE BUT THE CLOSED CASE? (item 2003)
 *
 * **THIS DECIDES WHICH CURE TO BUILD, AND IT IS A MEASUREMENT RATHER THAN A DERIVATION —
 * because deriving acyclic facts has gone wrong twice in two items.** Item 2001 wrote two wrong
 * closed-form corrections; item 2002 succeeded only by abandoning derivation for a DFS that is
 * correct by construction. So this asks the engine instead of reasoning about it.
 *
 * `DISTINCT ACYCLIC` costs 629.47 ms against `DISTINCT TRAIL`'s 28.61 at 20,000 vertices (22x), and
 * the profile says why: it runs the general matcher (`(anon)` 30.4%, `generatorResume` 20.3%,
 * `rowKey` 7.9%, `projectBinding` 4.8%) where TRAIL takes `reachability.ts`'s BFS over the reached
 * set. `needsGeneralMatcher` refuses `acyclic` — measured, not cautious: on one node with one
 * self-loop `MATCH ACYCLIC (x)-[:R]->+(y)` is 0 where SIMPLE and a BFS answer 1.
 *
 * TWO CURES ARE POSSIBLE AND THEY HAVE DIFFERENT COSTS:
 *
 *   (a) A DFS that collects the reached set — correct by construction (item 2002's mechanism), but
 *       it ENUMERATES paths, so it is exponential in the bound.
 *   (b) The existing BFS plus a correction for the closed case — O(|V| + |E|) at ANY bound, strictly
 *       better IF sound.
 *
 * (b) is only available if ACYCLIC and SIMPLE agree except where the witness is the source itself.
 * `reachability.ts` records SIMPLE's own soundness argument — "strip the cycles from any walk and
 * what remains visits each node at most once … a closed walk decomposes into simple cycles, at least
 * one through the source — so reaching the source itself at `min = 1` agrees as well". If the ONLY
 * divergence is that closed case, (b) is a small, cheap correction. This probe looks for a
 * counterexample on the fixtures `reachability.ts`'s own oracle used, which were chosen for the
 * hazard.
 *
 * IT COMPARES SETS, NOT COUNTS. `DISTINCT b.n` projects a PROPERTY, so two different vertices can
 * collapse to one row and a count would hide a divergence. These fixtures give every vertex a
 * distinct `n`.
 *
 *     bun acyclic-reachset-2003.mjs
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

/** `edges` as `[from, to]` pairs over vertices `0..n-1`, each with a DISTINCT `n`. */
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

/*
 * THE FIXTURES ARE `reachability.ts`'s OWN HAZARD LIST, which item 1257 used to admit SIMPLE:
 * self-loop, 2-cycle, 3-cycle, chain, chain with a back-edge, lollipop, two joined cycles, in-tree,
 * diamond. Reusing them means a divergence found here is one that list was already meant to expose.
 */
const FIXTURES = {
  'self-loop': [1, [[0, 0]]],
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
    4,
    [
      [0, 1],
      [1, 2],
      [2, 3],
    ],
  ],
  'chain + back-edge': [
    4,
    [
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 1],
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
  'two joined cycles': [
    5,
    [
      [0, 1],
      [1, 0],
      [1, 2],
      [2, 3],
      [3, 1],
      [3, 4],
    ],
  ],
  'in-tree': [
    4,
    [
      [1, 0],
      [2, 0],
      [3, 1],
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
  'self-loop + out-edge': [
    2,
    [
      [0, 0],
      [0, 1],
    ],
  ],
  'self-loop only in-edge': [
    2,
    [
      [1, 1],
      [1, 0],
    ],
  ],
  'double self-loop': [
    1,
    [
      [0, 0],
      [0, 0],
    ],
  ],
};

const BOUNDS = ['{1,1}', '{1,2}', '{1,3}', '{1,4}', '+', '*'];
const MODES = { SIMPLE: 'MATCH SIMPLE', ACYCLIC: 'MATCH ACYCLIC', TRAIL: 'MATCH TRAIL' };

/*
 * **THE SEED AXIS, AND LEAVING IT OUT MADE THE FIRST RUN'S CONCLUSION WRONG.** Without a start
 * predicate every vertex is a source, and then every divergence found reduces to a self-loop — which
 * made "cure (b) is a small closed-case correction" look established. It is not: with the sources
 * RESTRICTED, a 2-cycle diverges too. Sources `{b}` over `b->x, x->b`: ACYCLIC from `b` reaches
 * `{x}` only, while SIMPLE also reaches `b` by the closed path `b->x->b` — and `b`'s in-neighbour is
 * `x`, NOT itself, so a correction keyed on "only self-loop in-neighbours" misses it.
 *
 * This is item 2000's own lesson one level in: vary the SEED, because a conclusion drawn on one
 * value of an axis is a conclusion about that value.
 */
const SEED = process.env.SEED_N;

const setOf = (g, keyword, bound) => {
  const where = SEED === undefined ? '' : ` WHERE x.n = ${SEED}`;
  const text = `${keyword} (x:T)-[:E]->${bound}(y:T)${where} RETURN DISTINCT y.n AS v`;

  try {
    return JSON.stringify(
      [...query(g, text, {})].map((r) => r.v).sort((a, b) => Number(a) - Number(b)),
    );
  } catch (err) {
    return `ERR ${String(err.code ?? err.message).slice(0, 14)}`;
  }
};

let diffs = 0;
let closedOnly = 0;

console.log(`# seed: ${SEED === undefined ? 'NONE (every vertex is a source)' : `x.n = ${SEED}`}`);
console.log(
  'fixture                  bound    SIMPLE                ACYCLIC               verdict',
);

for (const [name, [n, edges]] of Object.entries(FIXTURES)) {
  const g = build(n, edges);

  for (const bound of BOUNDS) {
    const s = setOf(g, MODES.SIMPLE, bound);
    const a = setOf(g, MODES.ACYCLIC, bound);

    if (s === a) {
      continue;
    }

    diffs += 1;

    /*
     * IS THE DIVERGENCE ONLY THE CLOSED CASE? If every value SIMPLE has and ACYCLIC lacks is a
     * vertex that can only be reached from ITSELF, cure (b) is a correction over the BFS. Any other
     * difference refutes (b) outright and leaves the DFS.
     */
    const sv = new Set(JSON.parse(s));
    const av = new Set(JSON.parse(a));
    const lost = [...sv].filter((v) => !av.has(v));
    const gained = [...av].filter((v) => !sv.has(v));
    // A vertex is "closed-only" when its ONLY in-neighbour is itself.
    const inNbrs = (v) => edges.filter(([, t]) => t === v).map(([f]) => f);
    const closed = lost.every((v) => inNbrs(Number(v)).every((f) => f === Number(v)));

    if (gained.length === 0 && closed) {
      closedOnly += 1;
    }

    const verdict =
      gained.length === 0 && closed
        ? 'closed-case only'
        : `OTHER (lost=${JSON.stringify(lost)} gained=${JSON.stringify(gained)})`;

    console.log(`${name.padEnd(24)} ${bound.padEnd(8)} ${s.padEnd(21)} ${a.padEnd(21)} ${verdict}`);
  }
}

console.log(
  `\n${String(diffs)} divergence(s), ${String(closedOnly)} of them closed-case only.\n` +
    `# ${diffs === closedOnly ? 'Cure (b) — BFS + a closed-case correction — is NOT refuted by these fixtures.' : 'Cure (b) is REFUTED: a divergence exists that is not the closed case.'}`,
);

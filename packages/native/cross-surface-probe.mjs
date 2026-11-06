/**
 * ONE QUESTION, BOTH SURFACES: where do ISO-GQL and Gremlin disagree on cost? (item 1581)
 *
 * Each surface already has a spelling probe that checks EQUIVALENT SPELLINGS WITHIN it
 * (`bun run spelling`, `bun run spelling:gremlin`). Nothing checks the same question ACROSS them,
 * and that is where this session's largest gaps were: item 1573 found paging 10.0x apart by asking
 * one question two ways, and items 1574/1576 closed it to ~3x. That was found by hand. This makes it
 * systematic.
 *
 * ⚠️ A GAP HERE IS NOT AUTOMATICALLY A DEFECT. The two languages are intentionally different — ISO
 * `-[:T]-` emits a self-loop ONCE where Gremlin `both()` yields it TWICE (item 1086), row ORDER is
 * unspecified in GQL but a TinkerPop contract in Gremlin, and some questions have no faithful twin
 * at all. Every pair here answers the SAME value, which is asserted, and a pair that cannot is left
 * out rather than fudged.
 *
 * ⚠️ TWO PASSES IN OPPOSITE ORDER, keeping the better reading per surface. Items 1578 and 1579 each
 * produced an IMPOSSIBLE in-process reading because whichever arm ran first paid — item 182's
 * finding. The two engines are different call sites so they do not pollute each other's dispatch,
 * but position still matters, and this is the harness the GQL spelling probe already uses for it.
 *
 *     node cross-surface-probe.mjs                 # every question
 *     ONLY=paging node cross-surface-probe.mjs     # one, by substring
 *     NODES=200000 TOL=1.5 node cross-surface-probe.mjs
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';
import * as G from '@lenke/gremlin';

const NODES = Number(process.env.NODES ?? 50_000);
const FANOUT = Number(process.env.FANOUT ?? 3);
const REPS = Number(process.env.REPS ?? 9);
const TOL = Number(process.env.TOL ?? 2);
const { ONLY } = process.env;
/** Below this, a ratio is clock resolution rather than a cost. See the use site. */
const FLOOR_MS = Number(process.env.FLOOR_MS ?? 0.05);

const g = new Graph();
const vs = [];

for (let i = 0; i < NODES; i += 1) {
  vs.push(
    g.addVertex({
      id: `v${i}`,
      labels: i % 2 === 0 ? ['P', 'Q'] : ['P'],
      properties: { k: i % 97, n: i, s: `s${i % 50}` },
    }),
  );
}

// Split the target on the REPEAT INDEX, not on `i` alone: `(i * a + b) % N` is invariant under
// `i -> i + N`, so a flat loop points all of one vertex's edges at the SAME target and the graph
// comes out functional — out-degree looks perfect and every k-hop count is `F^k * N` by
// construction (CLAUDE.md, items 1516/1518).
for (let rep = 0; rep < FANOUT; rep += 1) {
  for (let i = 0; i < NODES; i += 1) {
    g.addEdge({
      id: `e${rep}_${i}`,
      from: vs[i],
      to: vs[(i * 7919 + rep * 104_729 + 1) % NODES],
      labels: ['E'],
      properties: { w: i % 13 },
    });
  }
}

{
  const seen = new Set();

  for (const e of g.edges) {
    seen.add(e.to.id);
  }

  console.log(
    `fixture: ${NODES} vertices, ${g.edgeCount} edges, ${seen.size} distinct targets ` +
      `(${((seen.size / NODES) * 100).toFixed(1)}%)  tol=${TOL}x reps=${REPS}\n`,
  );
}

g.createIndex({ on: 'vertex', kind: 'hash', keys: ['n'] });

/** `{ name, gql, gremlin, norm }` — `norm` reduces each surface's answer to one comparable. */
/**
 * The first scalar of a result, from EITHER surface.
 *
 * ⚠️ THE TWO SURFACES RETURN DIFFERENT SHAPES, and my first version only handled one: `query`
 * yields ROW OBJECTS (`[{c: 50000}]`) while `toArray` yields bare VALUES (`[50000]`). Taking
 * `Object.values(row)[0]` on a number gives `undefined`, so EVERY pair reported "ANSWERS DISAGREE"
 * and the timings beside them were comparing a real answer against nothing.
 */
const first = (rows) => {
  if (!Array.isArray(rows)) {
    return rows ?? null;
  }

  const [row] = rows;

  if (row === null || row === undefined) {
    return null;
  }

  if (row instanceof Map) {
    return row.size;
  }

  return typeof row === 'object' ? (Object.values(row)[0] ?? null) : row;
};
const QUESTIONS = [
  {
    name: 'count all',
    gql: 'MATCH (n) RETURN count(*) AS c',
    gremlin: G.traversal(G.V(), G.count()),
    norm: first,
  },
  {
    name: 'count label',
    gql: 'MATCH (n:Q) RETURN count(*) AS c',
    gremlin: G.traversal(G.V(), G.hasLabel('Q'), G.count()),
    norm: first,
  },
  {
    name: 'hop count',
    gql: 'MATCH (a:P)-[:E]->(b) RETURN count(*) AS c',
    gremlin: G.traversal(G.V(), G.hasLabel('P'), G.out('E'), G.count()),
    norm: first,
  },
  {
    name: 'hop distinct',
    gql: 'MATCH (a:P)-[:E]->(b) RETURN count(DISTINCT b) AS c',
    gremlin: G.traversal(G.V(), G.hasLabel('P'), G.out('E'), G.dedupe(), G.count()),
    norm: first,
  },
  {
    name: 'point by key',
    gql: 'MATCH (n) WHERE n.n = 7 RETURN n.n AS x',
    gremlin: G.traversal(G.V(), G.has('n', 7), G.values('n')),
    norm: first,
  },
  {
    name: 'filtered count',
    gql: 'MATCH (n:P) WHERE n.k > 44 RETURN count(*) AS c',
    gremlin: G.traversal(G.V(), G.hasLabel('P'), G.has('k', G.gt(44)), G.count()),
    norm: first,
  },
  {
    name: 'sum',
    gql: 'MATCH (n) RETURN sum(n.k) AS s',
    gremlin: G.traversal(G.V(), G.values('k'), G.sum()),
    norm: first,
  },
  {
    name: 'max',
    gql: 'MATCH (n) RETURN max(n.k) AS m',
    gremlin: G.traversal(G.V(), G.values('k'), G.max()),
    norm: first,
  },
  {
    name: 'group count',
    gql: 'MATCH (n) LET grp = n.k RETURN count(*) AS c GROUP BY grp',
    gremlin: G.traversal(G.V(), G.groupCount({ by: 'k' })),
    norm:
      // GQL returns one ROW PER GROUP; Gremlin returns ONE Map whose size is the group count. Both
      // reduce to "how many groups", which is the comparable quantity.
      (r) => {
        const [row] = Array.isArray(r) ? r : [r];

        if (row instanceof Map) {
          return row.size;
        }

        return Array.isArray(r) ? r.length : null;
      },
  },
  {
    name: 'paging',
    gql: 'MATCH (n) RETURN n.k AS k ORDER BY k LIMIT 10',
    gremlin: G.traversal(G.V(), G.values('k'), G.order(), G.limit(10)),
    norm: (r) =>
      JSON.stringify(
        Array.isArray(r)
          ? r.map((x) => (typeof x === 'object' && x !== null ? Object.values(x)[0] : x))
          : r,
      ),
  },
];

const timeOne = (fn) => {
  const s = [];

  for (let i = 0; i < REPS; i += 1) {
    const t0 = performance.now();

    fn();
    s.push(performance.now() - t0);
  }

  // Drop the first three as warm-up (visibly the JIT tiering up) and take the MEDIAN of the rest —
  // the estimator `ts-spelling-probe` prescribes for this engine, because `min` reports a rare fast
  // rep on the general scalar path.
  const kept = s.slice(3).sort((a, b) => a - b);

  return kept[Math.floor(kept.length / 2)];
};
const flagged = [];

for (const { name, gql: text, gremlin: plan, norm } of QUESTIONS) {
  if (ONLY !== undefined && !name.includes(ONLY)) {
    continue;
  }

  const gql = () => query(g, text);
  const grem = () => G.toArray(plan, g);
  const gqlAnswer = JSON.stringify(norm(gql()));
  const gremAnswer = JSON.stringify(norm(grem()));

  // Forward pass, then reversed, keeping the better reading per surface: a genuinely slower surface
  // is slower from either position.
  const q1 = timeOne(gql);
  const r1 = timeOne(grem);
  const r2 = timeOne(grem);
  const q2 = timeOne(gql);
  const q = Math.min(q1, q2);
  const r = Math.min(r1, r2);
  const ratio = q === 0 || r === 0 ? 1 : Math.max(q, r) / Math.min(q, r);
  const slower = q > r ? 'GQL' : 'gremlin';
  const agree = gqlAnswer === gremAnswer;

  // ⚠️ A FLOOR, for the reason the GQL spelling probe has one (its `SPELL_FLOOR`, item 127): a pair
  // whose members both read 0.001-0.006 ms is comparing CLOCK RESOLUTION, and the first run of this
  // probe duly flagged `count label` at 2.06x and `hop count` at 2.87x on readings of 0.00 ms. Both
  // are closed-form answers on both surfaces. A pair under the floor is reported as too fast to
  // compare, never as a ratio.
  const tooFast = Math.max(q, r) < FLOOR_MS;
  let note = '';

  if (tooFast) {
    note = 'under floor';
  } else if (ratio > TOL) {
    note = `${slower} SLOWER`;
  }

  if (!agree) {
    flagged.push(`${name}: ANSWERS DISAGREE — gql ${gqlAnswer} vs gremlin ${gremAnswer}`);
  } else if (tooFast) {
    flagged.push(`${name}: too fast to compare (both under ${FLOOR_MS}ms) — raise NODES`);
  } else if (ratio > TOL) {
    flagged.push(
      `${name}: ${ratio.toFixed(2)}x, ${slower} slower (gql ${q.toFixed(2)}ms, gremlin ${r.toFixed(2)}ms)`,
    );
  }

  console.log(
    `${name.padEnd(16)} gql ${q.toFixed(3).padStart(9)}ms   gremlin ${r.toFixed(3).padStart(9)}ms   ` +
      `${ratio.toFixed(2)}x ${note.padEnd(14)} ${agree ? '' : '⚠ ANSWERS DIFFER'}`,
  );
}

console.log(`\n${flagged.length} flagged (tol ${TOL}x):`);

for (const f of flagged) {
  console.log(`  ${f}`);
}

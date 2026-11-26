/*
 * Item 2053 — WHAT IS THE FLOOR FOR A CORRELATED `CALL` SUBQUERY?
 *
 * The 200k ranking (item 2052) puts `callscoped` at **95.7 ms** — and it returns ONE row:
 *
 *     MATCH (n:P) CALL (n) { MATCH (n)-[:E]->(x) RETURN count(*) AS c } RETURN count(*) AS t
 *
 * Per outer row that is ~478 ns, for a subquery whose whole body is "count this vertex's out-edges".
 *
 * **TWO FLOORS, AND THEY ASK DIFFERENT QUESTIONS.** Stating both keeps the second from being
 * smuggled in as if it were the first:
 *
 *   FAITHFUL  — per vertex, actually count the out-edges, then count the rows. This is the work the
 *               query asks for, so the gap to it is pure engine overhead.
 *   SEMANTIC  — notice that `c` is never read by the outer query, so the subquery's count is DEAD and
 *               only its ROW COUNT matters (one row per `n`, even at zero edges, since `count(*)`
 *               over an empty group still yields a row). That is dead-column elimination across a
 *               CALL boundary — a real optimisation, but a different and much larger claim.
 *
 * BOTH FLOORS MUST ANSWER `t = |P|`. A floor that answers something else prices a different query.
 *
 *     bun call-floor-2053.mjs
 *     NODES=200000 REPS=5 bun call-floor-2053.mjs
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const NODES = Number(process.env.NODES ?? 200_000);
const REPS = Number(process.env.REPS ?? 7);

const g = new Graph();

for (let i = 0; i < NODES; i += 1) {
  g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i % 97, s: `s${i % 1000}`, n: i } });
}

/*
 * FANOUT EXISTS TO TEST ONE CLAIM: that `PLAIN` is NOT a floor for the CALL forms. At FANOUT=1 they
 * agree numerically (each `n` has one out-edge, so "count all (n,x) pairs" equals "count one row per
 * n"), and that coincidence makes the plain count LOOK like a floor. At FANOUT>1 it must diverge —
 * plain goes to n*FANOUT while the CALL forms stay at n. Checked rather than asserted.
 */
const FANOUT = Number(process.env.FANOUT ?? 1);

for (let e = 0; e < NODES * FANOUT; e += 1) {
  const i = e % NODES;
  const hop = Math.floor(e / NODES);

  g.addEdge({
    id: `e${e}`,
    from: g.getVertexById(`v${i}`),
    to: g.getVertexById(`v${(i * 7 + 3 + hop * 2_654_435_761) % NODES}`),
    labels: ['E'],
    properties: { w: e % 13 },
  });
}

const SCOPED =
  'MATCH (n:P) CALL (n) { MATCH (n)-[:E]->(x) RETURN count(*) AS c } RETURN count(*) AS t';
const INLINE = 'MATCH (n:P) CALL { MATCH (n)-[:E]->(x) RETURN count(*) AS c } RETURN count(*) AS t';
/** The same per-vertex work with no CALL at all — what the subquery is "worth" as a plain hop count. */
const PLAIN = 'MATCH (n:P)-[:E]->(x) RETURN count(*) AS t';

/** FAITHFUL: do the per-vertex adjacency count the subquery body asks for. */
const handFaithful = () => {
  let rows = 0;

  for (const v of g.vertices) {
    if (!v.labels.has('P')) {
      continue;
    }

    // The subquery's own work: count this vertex's out-`E` edges. The value is computed and then
    // discarded, exactly as the outer query discards `c`.
    const bucket = v.adjFrom?.get('E');
    const c = bucket === undefined ? 0 : bucket.size;

    if (c >= 0) {
      rows += 1;
    }
  }

  return rows;
};

/** SEMANTIC: `c` is dead, so only the subquery's row count matters — one per `n`. */
const handSemantic = () => {
  let rows = 0;

  for (const v of g.vertices) {
    if (v.labels.has('P')) {
      rows += 1;
    }
  }

  return rows;
};

const engine = (text) => Number([...query(g, text)][0].t);

const want = engine(SCOPED);
const plainAnswer = engine(PLAIN);

if (want !== NODES || handFaithful() !== want || handSemantic() !== want) {
  throw new Error(
    `answers disagree: engine ${want}, faithful ${handFaithful()}, semantic ${handSemantic()}, |P| ${NODES}`,
  );
}

const coincidence =
  plainAnswer === want
    ? '(equal at FANOUT=1 by coincidence — NOT a floor)'
    : '<- DIFFERENT QUERY, so PLAIN is not a floor';

console.log(`\n  CALL answers ${want}; the PLAIN hop count answers ${plainAnswer}  ${coincidence}`);

const time = (label, fn) => {
  const series = [];

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();

    fn();
    series.push(performance.now() - t0);
  }

  // Median of the plateau — the first reps are V8 tiering up (items 2043-2045).
  const plateau = series.slice(2).sort((a, b) => a - b);
  const ms = plateau[Math.floor(plateau.length / 2)];

  console.log(
    `  ${label.padEnd(26)} ${ms.toFixed(2).padStart(9)} ms   ${((ms * 1000) / NODES).toFixed(3)} us/row`,
  );

  return ms;
};

console.log(`\n  ${NODES} vertices, ${NODES} edges; every arm answers t = ${want}\n`);

const scoped = time('engine CALL (n) scoped', () => engine(SCOPED));
const inline = time('engine CALL inline', () => engine(INLINE));
const plain = time('engine plain hop count', () => engine(PLAIN));
const faithful = time('HAND faithful floor', handFaithful);
const semantic = time('HAND semantic floor', handSemantic);

console.log(
  `\n  scoped CALL / HAND faithful    ${(scoped / faithful).toFixed(2)}x   <- engine overhead on the work asked` +
    `\n  scoped CALL / HAND semantic    ${(scoped / semantic).toFixed(2)}x   <- plus the dead-column opportunity` +
    `\n  scoped CALL / inline CALL      ${(scoped / inline).toFixed(2)}x   <- the explicit-scope plumbing` +
    `\n  scoped CALL vs plain hop count ${(scoped / plain).toFixed(0)}x   NOT A FLOOR — a different` +
    ` query whose answer only coincides at FANOUT=1\n`,
);

/**
 * Is an UNCORRELATED inline `CALL` body re-executed once per outer row, or evaluated once and
 * reused? (item 1818)
 *
 * WHY THE QUESTION IS NOT ANSWERABLE FROM A TOTAL. `correlated-call-probe.mjs` prices
 * `MATCH (n:P) CALL { MATCH (n)-[:E]->(x:P) RETURN count(*) AS d } RETURN count(*) AS c` at 11.4 ms
 * for 20,000 outer rows — 570 ns an outer row — but that single number is consistent with TWO
 * completely different mechanisms:
 *
 *   (a) the body runs ONCE and the 570 ns is per-row plumbing over a memoized 1-row side, or
 *   (b) the body runs PER OUTER ROW and 570 ns is a whole re-scan amortized by a fast rung.
 *
 * AND THE PROFILE CANNOT SETTLE IT EITHER, which is the trap worth naming: `callinline`'s
 * profile shows `matchPattern` 9.2%, `seedVertices` 2.2% and `hoistedMatch` 5.1%, which LOOK like
 * per-row matching — but a body run once still shows those frames, just with a small share of a
 * large total. A share is not a count.
 *
 * THE INSTRUMENT IS TO SCALE THE TWO SIDES INDEPENDENTLY. The body is held fixed while the OUTER
 * row count varies by a filter, and then the body is made more expensive while the outer count is
 * held fixed:
 *
 *   - Under (a), time tracks the BODY and is flat in the outer row count.
 *   - Under (b), time tracks OUTER x BODY, so cutting the outer rows ~100x cuts the time ~100x.
 *
 * The outer filter must not change the BODY — `n` is not in scope inside a bare `CALL { }` (which
 * is what item 1818 established: the bare form's answer is `outer x bodyRows`, so ISO's variable
 * scope clause really is the only way to import), so the body is byte-identical across every row
 * below and the only thing moving is how many times it could run.
 *
 *     node uncorrelated-call-reuse-probe.mjs
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const NODES = Number(process.env.NODES ?? 20_000);
const FANOUT = Number(process.env.FANOUT ?? 5);
const REPS = Number(process.env.REPS ?? 7);

const build = () => {
  const g = new Graph();

  for (let i = 0; i < NODES; i += 1) {
    g.addVertex({
      id: `v${i}`,
      labels: ['P'],
      properties: { k: i % 97, s: `s${i % 1000}`, n: i },
    });
  }

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

  return g;
};

const BODY_HOP = 'MATCH (a:P)-[:E]->(x:P) RETURN count(*) AS d';
const BODY_NODE = 'MATCH (a:P) RETURN count(*) AS d';

const CASES = {
  /** 20,000 outer rows, one-hop body. The baseline. */
  'outer=20000 body=hop': `MATCH (n:P) CALL { ${BODY_HOP} } RETURN count(*) AS c`,
  /** ~207 outer rows, SAME body. Under (b) this is ~100x cheaper; under (a) it is flat. */
  'outer=207   body=hop': `MATCH (n:P) WHERE n.k = 5 CALL { ${BODY_HOP} } RETURN count(*) AS c`,
  /** 1 outer row, SAME body: the body's own cost, with the per-row term removed. */
  'outer=1     body=hop': `MATCH (n:P) WHERE n.n = 12345 CALL { ${BODY_HOP} } RETURN count(*) AS c`,
  /** 20,000 outer rows, CHEAPER body — separates the per-row term from the body term. */
  'outer=20000 body=node': `MATCH (n:P) CALL { ${BODY_NODE} } RETURN count(*) AS c`,
  /** The CALL removed entirely: the outer pattern's own cost. */
  'outer=20000 no call': 'MATCH (n:P) RETURN count(*) AS c',
};

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;

  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const g = build();

console.log(`# uncorrelated-call-reuse-probe NODES=${NODES} FANOUT=${FANOUT} reps=${REPS}`);
console.log(`# vertices=${g.vertexCount} edges=${g.edgeCount}\n`);

for (const [name, q] of Object.entries(CASES)) {
  const series = [];
  let answer;

  for (let r = 0; r < REPS; r += 1) {
    const t0 = performance.now();
    const rows = query(g, q);

    series.push(performance.now() - t0);
    answer = JSON.stringify(rows);
  }

  const kept = series.slice(2);

  console.log(
    `${name.padEnd(24)} median ${median(kept).toFixed(2).padStart(9)} ms   ` +
      `answer ${answer.padEnd(22)} [${kept.map((x) => x.toFixed(1)).join(' ')}]`,
  );
}

/**
 * WHERE ARE THE `var-length` FAMILY'S MILLISECONDS? (item 1879)
 *
 * FLOOR FIRST, FRAMES LATER — item 1878's lesson. That item spent a whole tick confirming a 4.7x
 * that was 2 microseconds, because it started from a ratio. This starts from the workload screen's
 * ABSOLUTES: after `multi-pattern` (closed at item 1864 as a genuine product), `chain-rows` 583 ms
 * and `var-length` 543 ms are 54% of the addressable screen time, and `chain-rows` is already at its
 * layout ceiling (item 1859). So `var-length`'s 543 ms is the biggest unexamined number there is.
 *
 * AND THE FAMILY IS SEVEN SHAPES, NOT ONE. It draws four row-returning bodies and three counting
 * ones, crossed with four bounds and three selectors (none / `TRAIL` / `ACYCLIC`). A profile of "the
 * family" would be a profile of whichever shape happens to dominate, so this splits the 543 ms
 * BEFORE anything is profiled.
 *
 * THE SELECTOR MATTERS AND IS THE POINT. Item 1848's bounded-reach rung records `ACYCLIC {1,3}`
 * at 1.00x — REFUSED on purpose, because the rung counts trails and cannot answer acyclic paths. So
 * the acyclic arms go to path ENUMERATION in the general matcher. If they own most of the 543 ms,
 * the family's cost is a deliberate refusal rather than a gap.
 *
 * ONE SHAPE PER PROCESS, at the screen's own size.
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const NODES = Number(process.env.NODES ?? 1500);
const FANOUT = Number(process.env.FANOUT ?? 4);
const REPS = Number(process.env.REPS ?? 9);
const SHAPE = process.env.SHAPE ?? '';

const N_POOL = [3, 5, 7, 11, 13, 17, 1, 99];

const g = new Graph();

for (let i = 0; i < NODES; i += 1) {
  g.addVertex({
    id: String(i + 1),
    labels: i % 6 === 2 ? ['T', 'U'] : ['T'],
    properties: { n: N_POOL[i % N_POOL.length] },
  });
}

for (let e = 0; e < NODES * FANOUT; e += 1) {
  const i = e % NODES;
  const hop = Math.floor(e / NODES);

  g.addEdge({
    id: `e${e}`,
    from: g.getVertexById(String(i + 1)),
    to: g.getVertexById(String(((i * 7 + 3 + hop * 2_654_435_761) % NODES) + 1)),
    labels: hop % 4 === 3 ? ['F'] : ['E'],
  });
}

/** The family's own shapes, with the selector and the bound as the axes that matter. */
const SHAPES = {};

for (const bound of ['{1,1}', '{1,2}', '{1,3}', '{2,3}']) {
  SHAPES[`rows        ${bound}`] = `MATCH (a:T)-[:E]->${bound}(b:T) RETURN DISTINCT b.n AS x`;
  SHAPES[`rows TRAIL  ${bound}`] = `MATCH TRAIL (a:T)-[:E]->${bound}(b:T) RETURN DISTINCT b.n AS x`;
  SHAPES[`rows ACYCL  ${bound}`] =
    `MATCH ACYCLIC (a:T)-[:E]->${bound}(b:T) WHERE a.n = $p0 RETURN DISTINCT b.n AS x`;
  SHAPES[`count       ${bound}`] = `MATCH (a:T)-[:E]->${bound}(b:T) RETURN count(*) AS x`;
  SHAPES[`count TRAIL ${bound}`] = `MATCH TRAIL (a:T)-[:E]->${bound}(b:T) RETURN count(*) AS x`;
  SHAPES[`count ACYCL ${bound}`] =
    `MATCH ACYCLIC (a:T)-[:E]->${bound}(b:T) WHERE a.n = $p0 RETURN count(*) AS x`;
}

const params = { p0: 5 };
const names =
  SHAPE === '' ? Object.keys(SHAPES) : Object.keys(SHAPES).filter((k) => k.includes(SHAPE));

if (SHAPE === '') {
  console.log(`${NODES} vertices / ${NODES * FANOUT} edges, median of ${REPS}`);
  console.log('');
  console.log('shape                 ms      rows   | the screen draws each of these');
  console.log('--------------------------------------------------------------------');
}

for (const name of names) {
  const text = SHAPES[name];
  const s = [];
  let rows = 0;

  for (let r = 0; r < REPS + 2; r += 1) {
    const t0 = performance.now();

    try {
      const got = query(g, text, params);

      rows = got.length;
    } catch {
      // A shape may legitimately raise (enumeration hitting a budget); -1 marks it rather than
      // dropping the row, because a shape that THROWS is a finding too.
      rows = -1;
    }

    const ms = performance.now() - t0;

    if (r >= 2) {
      s.push(ms);
    }
  }

  s.sort((a, b) => a - b);

  console.log(
    `${name.padEnd(20)} ${s[s.length >> 1].toFixed(1).padStart(7)} ${String(rows).padStart(8)}`,
  );
}

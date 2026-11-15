/**
 * THE SORT-SHAPE MATRIX: one fixture and one shape list, shared by the probe and the test
 * (item 1904).
 *
 * ⚠️ ONE COPY, because `ordered-rows.ts` records item 606's reason for exactly this split — "two
 * copies of this list is how one of them falls behind the other". `sort-matrix-1904.ts` adds the
 * rung census; `sort-matrix.test.ts` is the guard that actually runs on every `bun run test`.
 *
 * ⚠️⚠️ AND IT IS A TEST RATHER THAN ONLY A PROBE FOR A REASON THIS SESSION MEASURED: item 1901
 * found `rung-precedence-census.mjs` had been DARK for ~15 items because nobody ran it. A probe
 * guards nothing between the days somebody remembers it.
 *
 * ⚠️ THE FIXTURE IS BUILT SO THAT EVERY ORDER DIFFERS FROM EVERY OTHER, which is what item 1903
 * paid to learn: on the perf screen's tie-heavy graph the broken arm's ARRIVAL order and the
 * correct order share their first ten rows, so a wrong answer measured 7.6x faster and read as a
 * clean win.
 *
 *   - `n` is DISTINCT, so arrival order is never a plausible answer;
 *   - each edge points at the vertex that REVERSES it, so near and far order oppositely;
 *   - the rel's `w` ascends with neither, so a rel key is a third order;
 *   - `t` is a four-way TIE group, so tie order is exercised — observable between engines (605);
 *   - `nu` is null on a third and `sp` ABSENT on two thirds, so null placement is too.
 */

/** The NDJSON fixture. `n` defaults to 48 vertices and as many edges. */
export const sortMatrixNdjson = (n = 48): string => {
  const lines: string[] = [];

  for (let i = 0; i < n; i += 1) {
    const props: Record<string, unknown> = { n: i, t: i % 4, nu: i % 3 === 1 ? null : i };

    if (i % 3 === 0) {
      props.sp = i * 2;
    }

    lines.push(
      `{"type":"node","id":"${String(i + 1)}","labels":["T"],"properties":${JSON.stringify(props)}}`,
    );
  }

  for (let i = 0; i < n; i += 1) {
    lines.push(
      `{"type":"edge","id":"e${String(i)}","from":"${String(i + 1)}","to":"${String(n - i)}","labels":["E"],"properties":{"w":${String((i * 7) % n)}}}`,
    );
  }

  return lines.join('\n');
};

/**
 * The axes, held fixed by every other store in this repo and varied here:
 *
 *   - which end the PROJECTION reads (the corpus always projects the far end on a hop),
 *   - which end the KEY reads (the corpus only ever orders by the projection's alias),
 *   - how the key is SPELLED (alias / bare prop / expression — items 642, 1901, 1902),
 *   - which WINDOW is on it (the spelling probe's ordered groups all carried a `LIMIT`).
 */
const NODE_PROJ = ['n.n AS x', 'n.n AS x, n.t AS tt', 'n.t AS x'];
const NODE_KEYS = ['x', 'n.n', 'n.n + 1', 'n.t', 'n.t, n.n', 'n.nu + 1', 'n.sp + 1', 'n.n DESC'];
const HOP_PROJ = ['a.n AS x', 'b.n AS x', 'a.n AS x, b.n AS y', 'e.w AS x'];
const HOP_KEYS = [
  'x',
  'a.n',
  'a.n + 1',
  'b.n',
  'b.n + 1',
  'e.w',
  'e.w + 1',
  'b.t, a.n',
  'b.n DESC',
  'b.nu + 1',
];
const WINDOWS = ['', ' LIMIT 5', ' OFFSET 3', ' OFFSET 3 LIMIT 5', ' LIMIT 0'];

/** Every shape, as query text. */
export const sortMatrixShapes = (): string[] => {
  const out: string[] = [];

  for (const proj of NODE_PROJ) {
    for (const key of NODE_KEYS) {
      for (const win of WINDOWS) {
        out.push(`MATCH (n:T) RETURN ${proj} ORDER BY ${key}${win}`);
      }
    }
  }

  for (const proj of HOP_PROJ) {
    for (const key of HOP_KEYS) {
      for (const win of WINDOWS) {
        out.push(`MATCH (a:T)-[e:E]->(b:T) RETURN ${proj} ORDER BY ${key}${win}`);
      }
    }
  }

  return out;
};

// `ORDER BY` over an UNBOUNDED reachability pattern (item 1250).
//
// ⚠️ THESE ARE NOT PERFORMANCE TESTS, they are "does it answer at all" tests. Before this item,
// `detectReachableShortcut` refused every `ORDER BY`, so an ordered query fell to the general path,
// which ENUMERATES TRAILS over an unbounded pattern and threw `E_RESOURCE_EXHAUSTED` — telling the
// user to "add a tighter bound" for a query whose unordered spelling answered in 29 ms. Each case
// below fails by THROWING if the rung stops claiming the shape, which is why none of them needs a
// timing assertion.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';
import { deserialize } from '@lenke/serialization';

import { query } from './index.js';

/**
 * Dense enough that trail enumeration cannot finish: 400 nodes, 2,000 edges, every node reachable
 * from every start. The unordered spellings answer instantly; the ordered ones used to throw.
 */
const NDJSON = (() => {
  const n = 400;
  const lines: string[] = [];

  for (let i = 0; i < n; i++) {
    lines.push(`{"type":"node","id":"v${i}","labels":["P"],"properties":{"n":${i}}}`);
  }

  for (let k = 0; k < n * 5; k++) {
    lines.push(
      `{"type":"edge","id":"e${k}","labels":["T"],"from":"v${(k * 7919) % n}","to":"v${(k * 104_729) % n}","properties":{}}`,
    );
  }

  return lines.join('\n');
})();

const graph = (): Graph => deserialize(NDJSON, 'ndjson', new Graph());

describe('ORDER BY over unbounded reachability (item 1250)', () => {
  test('the COUNT form accepts an ORDER BY, where it is a no-op on one row', () => {
    const plain = query(graph(), 'MATCH (a:P)-[:T]->*(x) RETURN count(DISTINCT x) AS c');

    // Threw E_RESOURCE_EXHAUSTED before this item.
    expect(
      query(graph(), 'MATCH (a:P)-[:T]->*(x) RETURN count(DISTINCT x) AS c ORDER BY c'),
    ).toEqual(plain);
  });

  test('the ROWS form is actually SORTED, not merely accepted', () => {
    const asc = query(graph(), 'MATCH (a:P)-[:T]->*(x) RETURN DISTINCT x.n AS n ORDER BY n') as {
      n: number;
    }[];

    expect(asc.length).toBe(400);
    // ⚠️ THE ORDER IS THE ASSERTION. The unordered spelling returns BFS order, which is not
    // ascending — so a sort that silently did not apply would fail here rather than pass.
    expect(asc.map((r) => r.n)).toEqual(Array.from({ length: 400 }, (_, i) => i));

    const desc = query(
      graph(),
      'MATCH (a:P)-[:T]->*(x) RETURN DISTINCT x.n AS n ORDER BY n DESC',
    ) as { n: number }[];

    expect(desc.map((r) => r.n)).toEqual(Array.from({ length: 400 }, (_, i) => 399 - i));
  });

  test('the unordered spelling is unchanged, and is NOT already sorted', () => {
    const rows = query(graph(), 'MATCH (a:P)-[:T]->*(x) RETURN DISTINCT x.n AS n') as {
      n: number;
    }[];

    expect(rows.length).toBe(400);
    // The control for the test above: if BFS order happened to BE ascending, that test would pass
    // with no sort at all and prove nothing.
    expect(rows.map((r) => r.n)).not.toEqual(Array.from({ length: 400 }, (_, i) => i));
  });

  test('BOTH SPELLINGS of the key resolve — the alias and the expression', () => {
    // `outputColumnSorts` matches an output NAME only, and item 1062 measured the asymmetry that
    // creates at 3.8x. Here it would be answer-versus-error, so the expression spelling resolves
    // too and must agree exactly.
    const byAlias = query(graph(), 'MATCH (a:P)-[:T]->*(x) RETURN DISTINCT x.n AS n ORDER BY n');
    const byExpr = query(graph(), 'MATCH (a:P)-[:T]->*(x) RETURN DISTINCT x.n AS n ORDER BY x.n');

    expect(byExpr).toEqual(byAlias);
  });

  test('an ORDER BY the rung cannot resolve declines rather than answering wrongly', () => {
    // `ORDER BY x.n + 1` is neither an output column nor an item's expression, so the rung declines
    // and the general path takes it — which on an UNBOUNDED pattern exhausts the trail budget.
    // ⚠️ THIS ASSERTS THE ERROR, which is the honest state: declining is correct (the rung must not
    // guess), and the resulting throw is the gap recorded for `ORDER BY` + a window below.
    expect(() =>
      query(graph(), 'MATCH (a:P)-[:T]->*(x) RETURN DISTINCT x.n AS n ORDER BY x.n + 1'),
    ).toThrow();
  });

  test('ORDER BY with a WINDOW is ordered FIRST and sliced second (item 1251)', () => {
    // ⚠️ THIS TEST WAS WRITTEN AT ITEM 1250 ASSERTING A THROW, and item 1251 FLIPPED it. That is
    // what the pin was for: a recorded gap with an assertion that must change, rather than a
    // comment someone has to notice.
    //
    // The slice must come AFTER the order, so the first five are the five SMALLEST — not the first
    // five the BFS happened to reach, which is what the unordered spelling returns.
    expect(
      query(graph(), 'MATCH (a:P)-[:T]->*(x) RETURN DISTINCT x.n AS n ORDER BY n LIMIT 5'),
    ).toEqual([{ n: 0 }, { n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }]);

    expect(
      query(graph(), 'MATCH (a:P)-[:T]->*(x) RETURN DISTINCT x.n AS n ORDER BY n DESC LIMIT 3'),
    ).toEqual([{ n: 399 }, { n: 398 }, { n: 397 }]);

    // OFFSET too, and the order still comes first.
    expect(
      query(graph(), 'MATCH (a:P)-[:T]->*(x) RETURN DISTINCT x.n AS n ORDER BY n OFFSET 2 LIMIT 2'),
    ).toEqual([{ n: 2 }, { n: 3 }]);
  });

  test('a PARAMETERIZED window resolves at run time rather than declining (item 1251)', () => {
    // `LIMIT $k` cannot be resolved when the shape is compiled — the value lives in `params` — so
    // `resolveCount` is called inside the per-query closure. Declining instead would have put this
    // back on the general path, which THROWS on an unbounded pattern.
    expect(
      query(graph(), 'MATCH (a:P)-[:T]->*(x) RETURN DISTINCT x.n AS n ORDER BY n LIMIT $k', {
        k: 3,
      }),
    ).toEqual([{ n: 0 }, { n: 1 }, { n: 2 }]);
  });
});

describe('the reachability shortcut must be EXACT for its quantifier (item 1252)', () => {
  // ⚠️ ONE NODE, ONE SELF-LOOP, and that is the whole fixture: it is the smallest graph on which
  // WALK reachability and TRAIL reachability differ. A 2-hop TRAIL needs two DISTINCT edges and
  // there is only one, so anything with `min >= 2` matches NOTHING — while the BFS, which permits
  // edge reuse, walks a->a->a and reports one endpoint.
  const LOOP = [
    '{"type":"node","id":"a","labels":["P"],"properties":{"n":1}}',
    '{"type":"edge","id":"e1","labels":["R"],"from":"a","to":"a","properties":{}}',
  ].join('\n');
  const loop = (): Graph => deserialize(LOOP, 'ndjson', new Graph());
  const c = (q: string): unknown => query(loop(), q)[0]?.c;

  test('a lower bound above 1 agrees with its BOUNDED oracle', () => {
    // The UNBOUNDED spelling is the only one that can reach the shortcut (the rung requires
    // `max === null`), so the bounded spelling is an independent oracle for the same question.
    // Before item 1252 these disagreed — 1 against 0 — which is a WRONG ANSWER, not a slow one.
    expect(c('MATCH TRAIL (x:P)-[:R]->{2,}(y) RETURN count(DISTINCT y) AS c')).toBe(
      c('MATCH TRAIL (x:P)-[:R]->{2,9}(y) RETURN count(DISTINCT y) AS c'),
    );
    expect(c('MATCH TRAIL (x:P)-[:R]->{2,}(y) RETURN count(DISTINCT y) AS c')).toBe(0);

    expect(c('MATCH TRAIL (x:P)-[:R]->{3,}(y) RETURN count(DISTINCT y) AS c')).toBe(
      c('MATCH TRAIL (x:P)-[:R]->{3,9}(y) RETURN count(DISTINCT y) AS c'),
    );
  });

  test('min 0 and min 1 are still SERVED, so the fix did not disable the rung', () => {
    // The control for the test above: declining too much would also make it pass. `->*` and `->+`
    // are the shapes items 1250 and 1251 serve, and they must keep answering.
    expect(c('MATCH TRAIL (x:P)-[:R]->*(y) RETURN count(DISTINCT y) AS c')).toBe(1);
    expect(c('MATCH TRAIL (x:P)-[:R]->+(y) RETURN count(DISTINCT y) AS c')).toBe(1);
  });

  test('the ROWS form agrees with the count form', () => {
    expect(query(loop(), 'MATCH TRAIL (x:P)-[:R]->{2,}(y) RETURN DISTINCT y.n AS n')).toEqual([]);
    expect(query(loop(), 'MATCH TRAIL (x:P)-[:R]->+(y) RETURN DISTINCT y.n AS n')).toEqual([
      { n: 1 },
    ]);
  });
});

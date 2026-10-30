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

  test('⚠️ ORDER BY with a WINDOW still declines, and still throws — the recorded gap', () => {
    // `runReach` applies `skip`/`limit` ITSELF, so a sort layered on its output would slice BEFORE
    // ordering and return the WRONG ROWS. Declining is therefore correct, not lazy — but it leaves
    // the top-N-reachable shape erroring, which is the most natural query of this family. Pinned so
    // the gap is visible and so a future fix has a test that must FLIP.
    expect(() =>
      query(graph(), 'MATCH (a:P)-[:T]->*(x) RETURN DISTINCT x.n AS n ORDER BY n LIMIT 5'),
    ).toThrow();
  });
});

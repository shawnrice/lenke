// The bounded top-k inside the projection shortcut's sort (item 701).
//
// THE FIXTURE IS THE POINT. `sortRowsByColumns` only selects instead of sorting when
// `(skip + limit) * 16 <= rows.length`, so a test over a handful of rows exercises the FULL SORT
// no matter what it asserts — the repeated fixture mistake in this repo, where the subject is
// unreachable from the fixture. Every case here keeps 320 rows against a window of at most 10.
//
// THE ORACLE IS THE SAME QUERY WITHOUT THE WINDOW, sliced in JS. That is exactly what the route
// did before, so it pins the new branch to the old answer rather than to a second derivation of
// "which row sorts first". Ties are deliberately dense (8 distinct ages over 320 rows) and 1 in 16
// ages is null, because tie order and NULLS placement are observable between the engines
// (item 605) and are what a bounded selection is most likely to get wrong.
import { Graph } from '@lenke/core';
import { describe, expect, it } from 'vitest';

import { query } from './index.js';

const N = 320;

const graph = (): Graph => {
  const g = new Graph();

  for (let i = 0; i < N; i += 1) {
    g.addVertex({
      id: `v${i}`,
      labels: ['P'],
      properties: { age: i % 16 === 3 ? null : (i * 7) % 8, name: `n${i}` },
    });
  }

  return g;
};

const WINDOWED: [string, string, number, number][] = [
  ['LIMIT 1', 'ORDER BY a LIMIT 1', 0, 1],
  ['LIMIT 5', 'ORDER BY a LIMIT 5', 0, 5],
  ['LIMIT 10', 'ORDER BY a LIMIT 10', 0, 10],
  ['DESC', 'ORDER BY a DESC LIMIT 5', 0, 5],
  ['SKIP', 'ORDER BY a SKIP 3 LIMIT 5', 3, 5],
  ['two keys', 'ORDER BY a, nm LIMIT 5', 0, 5],
  ['two keys, mixed direction', 'ORDER BY a DESC, nm LIMIT 5', 0, 5],
  ['second key descending', 'ORDER BY a, nm DESC LIMIT 5', 0, 5],
];

describe('bounded top-k in the projection shortcut sort', () => {
  it.each(WINDOWED)('%s answers what the full sort sliced', (_name, tail, skip, limit) => {
    const g = graph();
    const unwindowed = tail.replace(/ SKIP \d+| LIMIT \d+/g, '');
    const want = query(g, `MATCH (n:P) RETURN n.age AS a, n.name AS nm ${unwindowed}`);
    const got = query(g, `MATCH (n:P) RETURN n.age AS a, n.name AS nm ${tail}`);

    // The guard the fixture rule asks for: if this ever fails, the window is no longer small
    // enough against the row count for the bounded branch to be the thing under test.
    expect(want.length).toBeGreaterThanOrEqual((skip + limit) * 16);
    expect(got).toEqual(want.slice(skip, skip + limit));
  });

  it('is not entered when the window is a large fraction of the rows', () => {
    const g = graph();
    const want = query(g, 'MATCH (n:P) RETURN n.age AS a, n.name AS nm ORDER BY a');

    expect(query(g, 'MATCH (n:P) RETURN n.age AS a, n.name AS nm ORDER BY a LIMIT 100')).toEqual(
      want.slice(0, 100),
    );
  });

  it('keeps the arrival order of tied rows, which is what a selection can silently lose', () => {
    const g = graph();
    const got = query(g, 'MATCH (n:P) RETURN n.age AS a, n.name AS nm ORDER BY a LIMIT 4') as {
      nm: string;
    }[];

    // Every row here ties on `a` (the smallest age), so the only thing distinguishing this from a
    // wrong answer is that the four rows are the FIRST four such vertices in insertion order.
    expect(got.map((r) => r.nm)).toEqual(['n0', 'n8', 'n16', 'n24']);
  });
});

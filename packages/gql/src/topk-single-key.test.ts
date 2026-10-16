import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

// Item 425: `ORDER BY <one key> … LIMIT n` gets its own bounded heap in `applyProjection`,
// gated on `orderBy.length === 1`. 1.34-1.50x across six shapes, five alternated rounds at nine
// reps each.
//
// The ORACLE is the SAME question written with the key TWICE (`ORDER BY s, s`), which the gate
// refuses — `orderBy.length === 2` — so the generic `Keyed` heap answers it. Duplicating a sort
// key cannot change the order, including the tie structure: both paths fall through to the
// arrival-index tiebreak on exactly the same rows. That makes it a real oracle rather than a
// differently-shaped question, which matters most for the TIES below, where the two paths could
// agree on the SET and differ on the order.
const build = (): Graph => {
  const g = new Graph();

  // 40 rows, values deliberately out of insertion order and with heavy TIES, because the
  // arrival-index tiebreak is the part of this heap that no "right answer" assertion sees: a
  // path that kept the right five rows in the wrong order passes any set comparison.
  for (let i = 0; i < 40; i++) {
    const j = (i * 17) % 40;
    const props: Record<string, unknown> = {
      k: j % 7, // ties: ~6 rows per value
      u: `u${String(j).padStart(3, '0')}`, // unique
      t: j % 3 === 0 ? 'a' : 'b', // only two distinct: ties everywhere
    };

    // Every third row has NO `n`, so nulls participate in the order (and `nullsFirst` matters).
    if (j % 3 !== 0) {
      props.n = j % 11;
    }

    g.addVertex({ id: `v${i}`, labels: ['P'], properties: props });
  }

  // A SECOND label whose `d` values are arranged so that the heap is actually PERMUTED by
  // evictions before it settles on a tied set. The first version of this fixture had heavy ties
  // but no such pattern, and the mutant that drops the arrival-index tiebreak SURVIVED: with
  // ties and no eviction, `up` never swaps (every comparison is equal), the heap array stays in
  // arrival order, and a comparator returning 0 everywhere leaves a stable sort alone — so the
  // tiebreak was unobservable and the test that claimed to cover it did not.
  //
  // Ascending with LIMIT 3: the three 9s fill the heap, then each 2 evicts a root and sifts
  // down, which reorders the array. The answer is the three 2s IN ARRIVAL ORDER, which only the
  // tiebreak can still produce once the array has been permuted.
  for (const [i, d] of [9, 9, 9, 2, 2, 2, 5, 5, 2].entries()) {
    g.addVertex({ id: `q${i}`, labels: ['Q'], properties: { d, pos: i } });
  }

  return g;
};

/** The same ORDER BY, with the key duplicated — which forces the generic two-key heap. */
const viaGeneric = (q: string): string =>
  q.replace(/ORDER BY ([^ ]+)( DESC| ASC)?/, 'ORDER BY $1$2, $1$2');

describe('single-key top-k', () => {
  const g = build();

  test.each([
    // Unique key, both directions.
    'MATCH (a:P) RETURN a.u AS s ORDER BY s LIMIT 5',
    'MATCH (a:P) RETURN a.u AS s ORDER BY s DESC LIMIT 5',
    // HEAVY TIES — the arrival-index tiebreak decides which rows are kept AND their order.
    'MATCH (a:P) RETURN a.k AS s ORDER BY s LIMIT 5',
    'MATCH (a:P) RETURN a.k AS s ORDER BY s DESC LIMIT 5',
    'MATCH (a:P) RETURN a.t AS s ORDER BY s LIMIT 7',
    'MATCH (a:P) RETURN a.t AS s ORDER BY s DESC LIMIT 7',
    // NULLs in the key.
    'MATCH (a:P) RETURN a.n AS s ORDER BY s LIMIT 5',
    'MATCH (a:P) RETURN a.n AS s ORDER BY s DESC LIMIT 5',
    // SKIP, which the heap has to over-collect for: the cap is SKIP + LIMIT and the page is
    // taken after the sort.
    'MATCH (a:P) RETURN a.u AS s ORDER BY s SKIP 10 LIMIT 5',
    'MATCH (a:P) RETURN a.k AS s ORDER BY s SKIP 3 LIMIT 4',
    'MATCH (a:P) RETURN a.k AS s ORDER BY s DESC SKIP 3 LIMIT 4',
    // k of 1, and k larger than the row count — the two ends of the bound.
    'MATCH (a:P) RETURN a.u AS s ORDER BY s LIMIT 1',
    'MATCH (a:P) RETURN a.u AS s ORDER BY s LIMIT 500',
    'MATCH (a:P) RETURN a.k AS s ORDER BY s LIMIT 500',
    // A SKIP past the end.
    'MATCH (a:P) RETURN a.u AS s ORDER BY s SKIP 100 LIMIT 5',
    // ORDER BY the INPUT property rather than the output alias — a different `orderNeedsOutput`
    // answer with the same one-key shape.
    'MATCH (a:P) RETURN a.u AS s ORDER BY a.u LIMIT 5',
    // A filtered input, so the heap sees fewer rows than the scan.
    'MATCH (a:P) WHERE a.k > 2 RETURN a.u AS s ORDER BY s LIMIT 5',
    // An expression key, not a bare property.
    'MATCH (a:P) RETURN a.k AS s ORDER BY a.k + 0 LIMIT 5',
    // The EVICTION-THEN-TIE shape. `at` is projected so the arrival order of the tied rows is
    // visible in the answer, which is the whole point: a path keeping the right three rows in
    // the wrong order is otherwise invisible.
    'MATCH (a:Q) RETURN a.d AS s, a.pos AS pos ORDER BY s LIMIT 3',
    'MATCH (a:Q) RETURN a.d AS s, a.pos AS pos ORDER BY s LIMIT 4',
    'MATCH (a:Q) RETURN a.d AS s, a.pos AS pos ORDER BY s DESC LIMIT 3',
    'MATCH (a:Q) RETURN a.d AS s, a.pos AS pos ORDER BY s SKIP 1 LIMIT 3',
  ])('%s', (q) => {
    // Compared IN ORDER, not as a set: the row order of an ORDER BY is the answer.
    expect(query(g, q)).toEqual(query(g, viaGeneric(q)));
  });

  // The oracle has to actually BE the generic path, or every case above is comparing the new
  // heap with itself. A two-key ORDER BY is refused by the `orderBy.length === 1` gate, so this
  // asserts the rewrite produced two keys rather than silently leaving one.
  test('the oracle rewrite really produces two sort keys', () => {
    expect(viaGeneric('MATCH (a:P) RETURN a.u AS s ORDER BY s LIMIT 5')).toBe(
      'MATCH (a:P) RETURN a.u AS s ORDER BY s, s LIMIT 5',
    );
    expect(viaGeneric('MATCH (a:P) RETURN a.u AS s ORDER BY s DESC LIMIT 5')).toBe(
      'MATCH (a:P) RETURN a.u AS s ORDER BY s DESC, s DESC LIMIT 5',
    );
  });

  // The eviction-then-tie answer, pinned: the three `d = 2` rows in ARRIVAL order (`pos` 3, 4,
  // 5), not whatever order the heap's evictions left them in. The fourth `2` arrives at `pos = 8`
  // and must NOT displace any of them.
  test('ties after evictions keep arrival order', () => {
    expect(query(g, 'MATCH (a:Q) RETURN a.d AS s, a.pos AS pos ORDER BY s LIMIT 3')).toEqual([
      { s: 2, pos: 3 },
      { s: 2, pos: 4 },
      { s: 2, pos: 5 },
    ]);
  });

  // And the values themselves, pinned once: agreement between two paths that were both wrong
  // the same way would satisfy everything above.
  test('the kept rows are the right ones', () => {
    expect(query(g, 'MATCH (a:P) RETURN a.u AS s ORDER BY s LIMIT 3')).toEqual([
      { s: 'u000' },
      { s: 'u001' },
      { s: 'u002' },
    ]);
    expect(query(g, 'MATCH (a:P) RETURN a.u AS s ORDER BY s DESC LIMIT 3')).toEqual([
      { s: 'u039' },
      { s: 'u038' },
      { s: 'u037' },
    ]);
    expect(query(g, 'MATCH (a:P) RETURN a.u AS s ORDER BY s SKIP 2 LIMIT 2')).toEqual([
      { s: 'u002' },
      { s: 'u003' },
    ]);
  });
});

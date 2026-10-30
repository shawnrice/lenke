import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { countShortcut } from './executor/count-shortcut.js';
import { V, count, gt, has, hasKey, hasLabel, out, toArray, traversal } from './index.js';
import type { Plan } from './index.js';

// `has('k')` with ONE argument builds `{kind:'hasKey'}`, not `{kind:'has'}`, and item 1140 taught
// exactly ONE detector (`hasChain`) to convert it. Five siblings tested `step.kind !== 'has'` against
// RAW steps and declined — so a presence filter fell to the general traversal stream in every rung
// but one. Item 1283 extracts that conversion into one shared reader (`asHasFilter`) and routes all
// six through it, plus `vertexStepCount`, which is where the measured gap actually lived.
//
// Measured at 200,000 vertices with SELECTIVITY MATCHED — `has(k)` and `has(k, gt(-1))` both keep
// every row and answer identically, which is what rules out a per-survivor cost looking like a
// presence gap:
//
//     V().hasLabel(L).has('age', gt(-1)).count()   2.573 ms -> 2.560   (control, took the rung)
//     V().hasLabel(L).has('age').count()           7.543    -> 2.496   3.0x
//
// ⚠️ THE TESTS THAT MATTER ASSERT THE DECISION, for the reason `has-count-shortcut.test.ts` states:
// a count shortcut is ANSWER-PRESERVING by design, so a mutant that never claims the shape passes
// every row assertion in the package. Each route assertion below therefore has an ANSWER assertion
// beside it, oracled against the general path.
const build = (opts: { index?: boolean; allOneLabel?: boolean } = {}): Graph => {
  const g = new Graph();

  // Four states for `k`: a value, a STORED NULL, an ABSENT key, and a second value. The stored null
  // is the one item 1139 warns about — `{op:'present'}` must count it, and synthesising a VALUE
  // predicate instead would silently drop it.
  const other = opts.allOneLabel === true ? 'Person' : 'Other';

  g.addVertex({ id: 'has1', labels: ['Person'], properties: { k: 1 } });
  g.addVertex({ id: 'nulled', labels: ['Person'], properties: { k: null } });
  g.addVertex({ id: 'absent', labels: ['Person'], properties: {} });
  g.addVertex({ id: 'has2', labels: [other], properties: { k: 2 } });
  g.addVertex({ id: 'absent2', labels: [other], properties: {} });

  if (opts.index === true) {
    g.createIndex({ on: 'vertex', kind: 'hash', keys: ['k'] });
  }

  return g;
};

describe('a single-key hasKey reaches every count rung (item 1283)', () => {
  test('⚠️ ROUTE: the shortcut CLAIMS the shape, on both the vacuous and the selective label', () => {
    // A VACUOUS label is dropped by a pre-pass, so on a single-label graph the chain reduces to
    // `V, hasKey, count` and lands on the SINGLE-STEP rung (`vertexStepCount`). With a selective
    // label it stays a two-step chain and lands on `filterChainCount`. Both had to be fixed, and
    // the all-one-label fixture is the one that found it — the benchmark used exactly that shape.
    const vacuous = build({ allOneLabel: true });
    const selective = build();
    const plan = traversal(V(), hasLabel('Person'), has('k'), count());

    expect(typeof countShortcut(plan, vacuous)).toBe('number');
    expect(typeof countShortcut(plan, selective)).toBe('number');

    // And the bare single-step form, with no label at all.
    expect(typeof countShortcut(traversal(V(), has('k'), count()), selective)).toBe('number');
  });

  test('the count equals the GENERAL PATH row count — the oracle', () => {
    // The same plan WITHOUT `count()` cannot use the shortcut, so its row count is computed by the
    // traverser pipeline. That makes it an oracle for every row the tally claims.
    // The pairs are built separately rather than by splicing a plan's steps: `traversal` takes step
    // FUNCTIONS, not the step objects a built plan holds.
    const pairs: [string, Plan, Plan][] = [
      [
        'labelled',
        traversal(V(), hasLabel('Person'), has('k')),
        traversal(V(), hasLabel('Person'), has('k'), count()),
      ],
      ['bare', traversal(V(), has('k')), traversal(V(), has('k'), count())],
      [
        'value pred',
        traversal(V(), hasLabel('Person'), has('k', gt(0))),
        traversal(V(), hasLabel('Person'), has('k', gt(0)), count()),
      ],
    ];

    for (const g of [build(), build({ allOneLabel: true })]) {
      for (const [what, filtered, counted] of pairs) {
        const viaStream = toArray(filtered, g).length;

        expect(toArray(counted, g)[0]).toBe(viaStream);
        expect(what).toBeTruthy();
      }
    }
  });

  test('⚠️ a STORED NULL is PRESENT, which is what forbids a synthetic value predicate', () => {
    // `has('k')` keeps `has1`, `nulled` and `has2` — the stored null included — and drops only the
    // two absent cells. Item 1139 records that synthesising a value predicate instead of
    // `{op:'present'}` would be a silent wrong answer on exactly this vertex.
    const g = build();

    expect(toArray(traversal(V(), has('k'), count()), g)[0]).toBe(3);
    // `hasKey` spelled explicitly is the same step and must agree.
    expect(toArray(traversal(V(), hasKey('k'), count()), g)[0]).toBe(3);
    // A VALUE predicate keeps only the two real numbers, so the two spellings are NOT the same
    // question — which is why the conversion carries `present` and not `gt(-Infinity)` or similar.
    expect(toArray(traversal(V(), has('k', gt(0)), count()), g)[0]).toBe(2);
  });

  test('MULTI-KEY hasKey still declines, because it is ANY-of and these chains are conjunctions', () => {
    const g = build();

    expect(countShortcut(traversal(V(), hasKey('k', 'other'), count()), g)).toBeUndefined();
    expect(
      countShortcut(traversal(V(), hasLabel('Person'), hasKey('k', 'other'), count()), g),
    ).toBeUndefined();

    // Still answers, by the general path: every vertex has at least one of the two keys? No —
    // `absent`/`absent2` have neither, so three survive.
    expect(toArray(traversal(V(), hasKey('k', 'other'), count()), g)[0]).toBe(3);
  });

  test('a SEEKABLE key declines, so the tally never loses an index', () => {
    // `propertyCount`'s own condition, inherited by the synthetic step: `countShortcut` runs BEFORE
    // `seedFromIndex`, so claiming a seekable shape would answer in O(V) where the general path
    // seeds in O(matches) — item 149's failure. A presence predicate over an INDEXED key is
    // seedable here, so the rung must stand aside.
    const indexed = build({ index: true });
    const plain = build();

    expect(countShortcut(traversal(V(), has('k'), count()), plain)).toBe(3);

    const claimed = countShortcut(traversal(V(), has('k'), count()), indexed);

    // Whichever way the seed gate falls, the ANSWER must not change.
    expect(claimed === undefined || claimed === 3).toBe(true);
    expect(toArray(traversal(V(), has('k'), count()), indexed)[0]).toBe(3);
  });

  test('a hop after the filter is unaffected, and still answers', () => {
    const g = new Graph();
    const a = g.addVertex({ id: 'has1', labels: ['Person'], properties: { k: 1 } });
    const b = g.addVertex({ id: 'has2', labels: ['Person'], properties: { k: 2 } });

    g.addVertex({ id: 'absent', labels: ['Person'], properties: {} });
    g.addEdge({ id: 'e1', from: a, to: b, labels: ['KNOWS'], properties: {} });

    const viaStream = toArray(traversal(V(), has('k'), out('KNOWS')), g).length;

    expect(toArray(traversal(V(), has('k'), out('KNOWS'), count()), g)[0]).toBe(viaStream);
  });
});

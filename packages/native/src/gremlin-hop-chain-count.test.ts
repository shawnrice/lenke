// Item 574. A chain of two or more Gremlin hops before `count()` had no rung: TS ran one
// traverser per path where native answers from degrees. 40,000 vertices / 120,000 edges, one
// case per process:
//
//   V().hasLabel(P).out(T).count()             ts   0.01ms -> 0.01   nv 0.11   the existing rung
//   V().hasLabel(P).out(T).out(T).count()         139.85  -> 24.26      0.40
//   repeat(out(T)).times(2).count()               151.52  -> 26.28      0.60
//   repeat(out(T)).times(1).count()                40.95  -> 0.01       0.10
//   repeat(out(T)).times(3).count()               THREW   -> 62.56      8.31
//
// The `times(3)` row is the point: TS raised "repeat() exceeded the trail budget" where native
// answers 1,080,000. A closed form enumerates nothing, so the budget it tripped is gone — the
// same argument native's `a_group_count_is_not_bounded_by_the_trail_budget` makes for GQL.
//
// EVERY EXPECTED VALUE BELOW IS TINKERPOP 3.7.3's OWN, taken from a real
// `tinkerpop/gremlin-console` run over this fixture (`out1` 14, `out2` 33, `out3` 78, `times1`
// 14, `times2` 33, `times3` 78, `times2emit` 47). That is what establishes `repeat(h).times(k)`
// IS the k-fold chain: the fixture carries a SELF-LOOP and a PARALLEL pair, so any edge- or
// vertex-uniqueness restriction would have shown, and none did.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';
import {
  V,
  both,
  count,
  hasLabel,
  in_,
  out,
  planToGremlin,
  repeat,
  toArray,
  traversal,
} from '@lenke/gremlin';
import type { Plan } from '@lenke/gremlin';
import { deserialize } from '@lenke/serialization';

import { nativeBackend, nativeReady } from './conformance-harness.js';
import { graphFromNdjson } from './graph.js';

// TinkerPop's fixture: 6 vertices, a +1/+2 ring, a self-loop on v0, a parallel v1->v3. V=6, E=14.
const L: string[] = [];

for (let i = 0; i < 6; i++) {
  L.push(JSON.stringify({ type: 'node', id: `v${i}`, labels: ['P'], properties: { n: i } }));
}

let k = 0;

for (let i = 0; i < 6; i++) {
  L.push(
    JSON.stringify({
      type: 'edge',
      id: `e${k++}`,
      labels: ['T'],
      from: `v${i}`,
      to: `v${(i + 1) % 6}`,
    }),
  );
  L.push(
    JSON.stringify({
      type: 'edge',
      id: `e${k++}`,
      labels: ['T'],
      from: `v${i}`,
      to: `v${(i + 2) % 6}`,
    }),
  );
}

L.push(JSON.stringify({ type: 'edge', id: 'eself', labels: ['T'], from: 'v0', to: 'v0' }));
L.push(JSON.stringify({ type: 'edge', id: 'epar', labels: ['T'], from: 'v1', to: 'v3' }));

const NDJSON = L.join('\n');
const suite = nativeReady ? describe : describe.skip;

suite('a Gremlin hop CHAIN count is degree arithmetic (item 574)', () => {
  const nat = graphFromNdjson(nativeBackend(), NDJSON);
  const ts = deserialize(NDJSON, 'ndjson', new Graph());
  const agree = (name: string, plan: Plan, want: number): void => {
    const got = JSON.stringify(toArray(plan, ts));

    expect(`${name} ${got}`).toBe(`${name} ${JSON.stringify(nat.gremlin(planToGremlin(plan)))}`);
    expect(`${name} ${got}`).toBe(`${name} [${want}]`);
  };

  test("TinkerPop 3.7.3's own numbers, both engines", () => {
    agree('out1', traversal(V(), hasLabel('P'), out('T'), count()), 14);
    agree('out2', traversal(V(), hasLabel('P'), out('T'), out('T'), count()), 33);
    agree('out3', traversal(V(), hasLabel('P'), out('T'), out('T'), out('T'), count()), 78);
    agree(
      'times1',
      traversal(V(), hasLabel('P'), repeat(traversal(out('T'))).times(1), count()),
      14,
    );
    agree(
      'times2',
      traversal(V(), hasLabel('P'), repeat(traversal(out('T'))).times(2), count()),
      33,
    );
    // THIS ONE RAISED before the rung existed, which is the divergence it closed.
    agree(
      'times3',
      traversal(V(), hasLabel('P'), repeat(traversal(out('T'))).times(3), count()),
      78,
    );
    // `emit()` sums over depths (14 + 33), so it is a different arithmetic and is REFUSED by the
    // expansion. Its answer must stay right anyway.
    agree(
      'times2emit',
      traversal(
        V(),
        hasLabel('P'),
        repeat(traversal(out('T')))
          .times(2)
          .emit(),
        count(),
      ),
      47,
    );
  });

  test('a repeat body of SEVERAL steps is not one hop repeated', () => {
    // `repeat(out(T).out(T)).times(2)` is `out` FOUR times — 185 here, against 33 for `out`
    // twice. Expanding it by taking only the body's first step would answer 33, which is why
    // the expansion requires a body of exactly one step.
    //
    // Pinned on the TS side ALONE, because `planToGremlin` emits
    // `repeat(out('T').out('T'))` and native's Gremlin parser rejects that text with
    // "expected RParen" — a pre-existing parser gap (it reproduces with this rung reverted),
    // recorded in CLOSED.md and not touched here.
    const twoStep = traversal(
      V(),
      hasLabel('P'),
      repeat(traversal(out('T'), out('T'))).times(2),
      count(),
    );
    const fourHops = traversal(V(), hasLabel('P'), out('T'), out('T'), out('T'), out('T'), count());

    expect(JSON.stringify(toArray(twoStep, ts))).toBe('[185]');
    expect(JSON.stringify(toArray(twoStep, ts))).toBe(JSON.stringify(toArray(fourHops, ts)));
    expect(() => nat.gremlin(planToGremlin(twoStep))).toThrow();
  });

  test('the direction mixes, where a chain is not a product', () => {
    // `out` then `in` is not `out` then `out`: TinkerPop gives 34 against 33 on this fixture.
    agree('mixed', traversal(V(), hasLabel('P'), out('T'), in_('T'), count()), 34);
    agree('in2', traversal(V(), hasLabel('P'), in_('T'), in_('T'), count()), 33);
  });

  test('the shapes the rung must REFUSE still answer correctly', () => {
    // `both` walks out-edges then in-edges, so a self-loop is incident twice and a bucket size
    // is not the degree — the exclusion every rung in that file makes.
    // `both1` is 28 and `both2` is 134 in TinkerPop, both matched here. 28 is 2x the 14
    // out-edges — the self-loop is incident TWICE, which is exactly why `both` is excluded from
    // every degree rung in `count-shortcut.ts`.
    agree('both1', traversal(V(), hasLabel('P'), both('T'), count()), 28);
    agree('both2', traversal(V(), hasLabel('P'), both('T'), both('T'), count()), 134);
    // An unknown type, and a chain through one.
    agree('nope2', traversal(V(), hasLabel('P'), out('Nope'), out('Nope'), count()), 0);
    // `times(0)` is not a chain of hops at all.
    // `times(0)`. BOTH ENGINES SAY 6 (the input passing through, zero iterations) and
    // TINKERPOP 3.7.3 SAYS 14 — it runs the body once. A third-party conformance deviation, not
    // a cross-engine one, and the same class as the inject+limit(0) shape item 417 records.
    // Pinned at the current behaviour so a deliberate change has to come here; the expansion
    // declines `times < 1`, so this item does not touch it either way.
    agree(
      'times0',
      traversal(V(), hasLabel('P'), repeat(traversal(out('T'))).times(0), count()),
      6,
    );
  });
});

// A MULTI-LABEL edge, which has NO TinkerPop ground truth to check against: a TinkerGraph edge
// carries exactly one label, so this is a lenke extension and native is the reference.
//
// It is the trap this rung nearly shipped. Such an edge sits in BOTH of a vertex's adjacency
// buckets, so a hop wanting several labels — or wanting ALL of them, which `out()` does — visits
// it once per label where the walk yields it once. The guard is `labels.length !== 1`, and it
// read `> 1` until a 146-case sweep found 13 divergences, every one an `out()` at depth 2 or
// more. `out(T,U)` was never among them, because that case the narrow guard did catch. Item 573
// shipped the same bug on the GQL side one tick earlier.
suite('a multi-label edge is counted once per path (item 574)', () => {
  const M: string[] = [];

  for (let i = 0; i < 6; i++) {
    M.push(JSON.stringify({ type: 'node', id: `v${i}`, labels: ['P'], properties: { n: i } }));
  }

  let j = 0;

  for (let i = 0; i < 6; i++) {
    M.push(
      JSON.stringify({
        type: 'edge',
        id: `m${j++}`,
        labels: ['T'],
        from: `v${i}`,
        to: `v${(i + 1) % 6}`,
      }),
    );
    M.push(
      JSON.stringify({
        type: 'edge',
        id: `m${j++}`,
        labels: ['U'],
        from: `v${i}`,
        to: `v${(i + 2) % 6}`,
      }),
    );
  }

  M.push(JSON.stringify({ type: 'edge', id: 'emulti', labels: ['T', 'U'], from: 'v2', to: 'v4' }));

  const DOC = M.join('\n');
  const nat = graphFromNdjson(nativeBackend(), DOC);
  const ts = deserialize(DOC, 'ndjson', new Graph());
  const agree = (name: string, plan: Plan, want: number): void => {
    const got = JSON.stringify(toArray(plan, ts));

    expect(`${name} ${got}`).toBe(`${name} ${JSON.stringify(nat.gremlin(planToGremlin(plan)))}`);
    expect(`${name} ${got}`).toBe(`${name} [${want}]`);
  };

  test('a single wanted label is safe; several or ALL must decline', () => {
    // ONE label: `emulti` is in the T bucket once, so the bucket size IS the degree.
    agree('outT2', traversal(V(), hasLabel('P'), out('T'), out('T'), count()), 8);
    // SEVERAL, and ALL: counted once per path, not once per label it carries.
    agree('outTU2', traversal(V(), hasLabel('P'), out('T', 'U'), out('T', 'U'), count()), 28);
    agree('outAny2', traversal(V(), hasLabel('P'), out(), out(), count()), 28);
    agree('outAny3', traversal(V(), hasLabel('P'), out(), out(), out(), count()), 60);
    agree(
      'repTU2',
      traversal(V(), hasLabel('P'), repeat(traversal(out('T', 'U'))).times(2), count()),
      28,
    );
  });

  test('an until() repeat is not a fixed-depth chain', () => {
    // `until` is a per-traverser stop condition, so the depth is not `times`. Expanding it
    // anyway would answer a chain's count (tens) instead of this.
    agree(
      'untilNope',
      traversal(
        V(),
        hasLabel('P'),
        repeat(traversal(out('T')))
          .times(3)
          .until(traversal(hasLabel('Nope'))),
        count(),
      ),
      0,
    );
  });
});

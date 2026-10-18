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
  gt,
  has,
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

// Item 590. The two-hop arm walked every edge and asked each TARGET for its degree, so a vertex's
// degree was recomputed once per in-edge. Summing over ALL sources, that is a degree inner
// product and needs no edge walk at all:
//
//   count = sum over w of arrivals(w) * departures(w)
//
// where each factor is the degree on whichever side its hop traverses. Measured at 40,000
// vertices / 200,000 edges, and the attribution is why this is ALGEBRAIC rather than the layout
// change item 589 made on the GQL side:
//
//   walk both levels of adjacency, nothing else         9.14 ms
//   + per-edge target bucket .get(label).size  [WAS]   61.80
//   + per-edge Map.get on a memoized degree map        42.07   only 1.5x, so not the fix
//   build a flattened CSR of neighbour indices         37.65   item 589's trick: no help here
//   THE INNER PRODUCT, degree passes included           7.73   8.0x
//
// End to end at 200,000 vertices / 1,000,000 edges, one case per process, three alternated rounds:
//
//   out(T).out(T).count()          370.76 ms -> 57.81   6.41x
//   in(T).in(T).count()            368.79    -> 57.60   6.40x
//   out(T).in(T).count()           325.38    -> 45.64   7.13x
//   repeat(out(T)).times(2)        410.39    -> 57.51   7.14x
//   out(T).count()        CONTROL    0.01    ->  0.01   1.00x
//   out x3                CONTROL  689.75    -> 669.88  1.03x   (the multiplicity-map arm)
//   has(age>44) + out x2  CONTROL  176.93    -> 182.54  0.97x   (keeps the walk)
//
// THE FIXTURE HAS TWO HUBS ON PURPOSE. `out/out` and `in/in` must ALWAYS agree — both are
// `sum(indeg*outdeg)` and multiplication commutes — but `out/in` is `sum(indeg^2)` and `in/out` is
// `sum(outdeg^2)`, and on a fixture without skew those coincided with it too: a first version read
// 130 / 130 / 192 / 130 and could not have caught a swapped degree side. With the hubs they read
// 35 / 35 / 73 / 59, which is asserted below rather than assumed (item 586's lesson).
//
// No TinkerPop run is attached because no SEMANTIC question is open here: item 574 established
// from a real console that `repeat(h).times(k)` IS the k-fold chain, and `out().out()` was never
// ambiguous. What changed is which arithmetic computes an already-settled answer, so the pins are
// native's and hand-checked — the T out-degrees sum to 23, and `sum(indeg*outdeg)` is
// 2+9+8+2+4+4+1+3+2 = 35.
describe('a two-hop count from every vertex is a degree inner product (item 590)', () => {
  const L: string[] = [];
  const N = 12;

  for (let i = 0; i < N; i++) {
    L.push(
      `{"type":"node","id":"v${i}","labels":${i % 3 === 0 ? '["P","Q"]' : '["P"]'},"properties":{"age":${(i * 11) % 40}}}`,
    );
  }

  let ec = 0;
  const edge = (f: number, t: number, labels: string): void => {
    L.push(`{"type":"edge","id":"x${ec++}","labels":${labels},"from":"v${f}","to":"v${t}"}`);
  };

  for (let i = 0; i < N; i++) {
    edge(i, (i * 3 + 1) % N, '["T"]');
  }

  // an OUT hub at v3 and an IN hub at v8
  for (let i = 0; i < 4; i++) {
    edge(3, (i * 2 + 5) % N, '["T"]');
    edge((i * 5 + 1) % N, 8, '["T"]');
  }

  edge(0, 0, '["T"]'); // SELF-LOOP: one in-edge AND one out-edge of the same vertex
  edge(1, 4, '["T"]'); // PARALLEL with a generated edge
  edge(2, 5, '["T","U"]'); // MULTI-LABEL, which a per-label bucket sum would double count
  edge(6, 7, '["U"]'); // a second type only
  L.push('{"type":"node","id":"iso","labels":["P"],"properties":{"age":3}}');

  const doc = L.join('\n');
  const nv = graphFromNdjson(nativeBackend(), doc);
  const ts = deserialize(doc, 'ndjson', new Graph());
  const agree = (want: number, plan: Plan): void => {
    const text = planToGremlin(plan);
    const got = JSON.stringify(toArray(plan, ts));

    expect(`${text} ${got}`).toBe(`${text} ${JSON.stringify(nv.gremlin(text))}`);
    expect(`${text} ${got}`).toBe(`${text} [${want}]`);
  };

  test('all four direction pairs, and they are SEPARABLE on this fixture', () => {
    agree(35, traversal(V(), out('T'), out('T'), count()));
    agree(35, traversal(V(), in_('T'), in_('T'), count()));
    agree(73, traversal(V(), out('T'), in_('T'), count()));
    agree(59, traversal(V(), in_('T'), out('T'), count()));

    // The precondition. `out/out` and `in/in` coincide by algebra; the other two must not, or a
    // swapped degree side is invisible and every assertion above still passes.
    const n = (p: Plan): number => Number(String(toArray(p, ts)));
    const oo = n(traversal(V(), out('T'), out('T'), count()));
    const oi = n(traversal(V(), out('T'), in_('T'), count()));
    const io = n(traversal(V(), in_('T'), out('T'), count()));

    expect(new Set([oo, oi, io]).size).toBe(3);
  });

  test('edge labels, including the multi-label and absent cases', () => {
    // `out()` with NO label iterates every bucket, so the multi-label edge is visited once per
    // label it carries unless the degree helper dedupes — the hazard items 573 and 574 both hit.
    agree(36, traversal(V(), out(), out(), count()));
    agree(36, traversal(V(), out('T', 'U'), out('T', 'U'), count()));
    // `U` alone has no two-hop path at all, which is the zero-arrivals early exit.
    agree(0, traversal(V(), out('U'), out('U'), count()));
    agree(23, traversal(V(), out('T'), count()));
  });

  test('MIXED labels, so each factor must read its OWN hop', () => {
    // Every case above puts the same label on both hops, which makes "arrivals uses h1's labels"
    // and "departures uses h0's labels" indistinguishable — two mutants survived on exactly that.
    // `out(T).out(U)` and `out(U).out(T)` are 0 and 2, so a swap is visible.
    agree(0, traversal(V(), out('T'), out('U'), count()));
    agree(2, traversal(V(), out('U'), out('T'), count()));
    agree(4, traversal(V(), in_('T'), out('U'), count()));
  });

  test('repeat(out).times(2) reaches the same arithmetic', () => {
    agree(35, traversal(V(), repeat(traversal(out('T'))).times(2), count()));
  });

  test('the shapes that must keep the WALK', () => {
    // A FILTERED source cannot use the identity: `arrivals(w)` would have to count in-edges from
    // the survivors only, which is a per-edge question again.
    agree(15, traversal(V(), hasLabel('Q'), out('T'), out('T'), count()));
    // A `has` filter is NOT seedable, so `canSeed` is false for it — and defining "unfiltered" as
    // `!canSeed` rather than "no filter steps" would wrongly take the identity here. That mutant
    // survived until this case existed.
    agree(12, traversal(V(), has('age', gt(20)), out('T'), out('T'), count()));
    // THREE hops keeps the multiplicity-map arm.
    agree(63, traversal(V(), out('T'), out('T'), out('T'), count()));
  });
});

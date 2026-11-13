// Unit tests for the realistic-workload GENERATOR (item 1817).
//
// ⚠️ WHY THE GENERATOR NEEDS ITS OWN TEST, SEPARATE FROM THE FUZZER THAT USES IT. The fuzzer
// compares two engines, so anything it generates that is answer-equivalent across them passes —
// including a family that silently stops matching rows, a family that stops being drawn, and a
// family whose queries all take a route nobody intended. That is the same reasoning the repo
// applies to a perf gate (`perf-gate-needs-its-own-test`): a choice that does not change the
// answer survives every differential, so the choice has to be asserted directly.
//
// These tests assert properties of the TEXT and the DRAW. Whether a family matches rows on the
// real fixture is asserted by the fuzzer's own non-empty floors, and `workload-family-probe.mjs`
// prints it per family during development.
import { describe, expect, test } from 'bun:test';

import { WORKLOAD_FAMILIES, WORKLOAD_FAMILY_NAMES, genWorkload } from './workload-queries.js';

/** The fuzzer's PRNG, duplicated here so a draw is reproducible without importing the test file. */
const mulberry32 = (seed: number): (() => number) => {
  let a = seed >>> 0;

  return () => {
    a |= 0;
    a = (a + 0x6d_2b_79_f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);

    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
};

const draw = (n: number) =>
  Array.from({ length: n }, (_, i) => genWorkload(mulberry32(i * 2654435761)));

describe('item 1817 — the workload generator', () => {
  const sample = draw(8000);

  test('every family is drawn, and the draw is FLAT rather than skewed', () => {
    const counts = new Map<string, number>();

    for (const w of sample) {
      counts.set(w.family, (counts.get(w.family) ?? 0) + 1);
    }

    expect([...counts.keys()].sort()).toEqual([...WORKLOAD_FAMILY_NAMES]);

    // ⚠️ THE FLATNESS IS THE WHOLE ITEM. The generator this arm was added beside puts 60.8% of
    // its queries on one shape; a replacement that merely moved the lump somewhere else would
    // not be an improvement. Expected share is 1/17 ≈ 5.9%, and every family must land within a
    // factor of 1.5 of it — loose enough not to be a flake at 8,000 draws, tight enough that a
    // family drawn twice as often as its neighbours fails.
    const expected = sample.length / WORKLOAD_FAMILY_NAMES.length;

    for (const [family, n] of counts) {
      expect({ family, low: n > expected / 1.5, high: n < expected * 1.5 }).toEqual({
        family,
        low: true,
        high: true,
      });
    }
  });

  test('every parameter referenced in the text is supplied, and vice versa', () => {
    // A missing parameter raises `E_MISSING_PARAMETER` on BOTH engines, which the differential
    // comparison reads as agreement — so this class of bug is invisible to the fuzzer and has to
    // be caught here. (The reverse, an unused param, is harmless and both engines accept it; it
    // is still asserted so a family cannot carry a typo'd name unnoticed.)
    for (const w of sample) {
      const referenced = [...w.text.matchAll(/\$([a-z][a-z0-9]*)/g)].map((m) => m[1]);

      for (const name of referenced) {
        expect({ text: w.text, name, supplied: w.params[name] !== undefined }).toEqual({
          text: w.text,
          name,
          supplied: true,
        });
      }
    }
  });

  test('a query claiming to be ORDERED carries an ORDER BY, and one that does not, does not', () => {
    // The `ordered` flag decides whether the fuzzer compares IN ORDER or as a multiset. If it
    // ever disagreed with the text, the comparison would be either too weak (a dropped sort goes
    // unseen — item 1039's bug) or too strong (an unordered result flagged as a divergence,
    // which `order-is-unspecified` says is a non-bug). Both directions are asserted.
    for (const w of sample) {
      const hasOrderBy = w.text.includes(' ORDER BY ');

      // A scalar aggregate returns exactly one row, so it is trivially ordered without a sort —
      // that is the one admitted exception, and it is named rather than left as a loophole.
      const scalarAggregate = /RETURN (count|sum|avg|min|max)\(/.test(w.text);

      if (w.ordered && !scalarAggregate) {
        expect({ text: w.text, hasOrderBy }).toEqual({ text: w.text, hasOrderBy: true });
      }

      if (!w.ordered) {
        expect({ text: w.text, hasOrderBy }).toEqual({ text: w.text, hasOrderBy: false });
      }
    }
  });

  test('paging is generated ONLY alongside an ORDER BY', () => {
    // A `LIMIT`/`OFFSET` with no `ORDER BY` lets row order decide WHICH rows survive, so two
    // engines that are both correct can return different rows. Generating that would manufacture
    // divergences out of a settled non-question (`order-is-unspecified`).
    for (const w of sample) {
      if (/ (LIMIT|OFFSET) /.test(w.text)) {
        expect({ text: w.text, ordered: w.text.includes(' ORDER BY ') }).toEqual({
          text: w.text,
          ordered: true,
        });
      }
    }
  });

  test('the Cypher-only SKIP $param spelling is never generated', () => {
    // TS's parser restricts `SKIP` to a literal while native accepts a parameter, so generating
    // it would make the fuzzer red for a known, open question rather than for a regression — the
    // same reasoning the adversarial arm applies to a negative `percentile` fraction. The ISO
    // spelling `OFFSET $p` is generated instead, and both engines accept it. See
    // `skip-param-divergence.test.ts`, which pins the disagreement itself.
    for (const w of sample) {
      expect(w.text.includes('SKIP $')).toBe(false);
    }
  });

  test('the chain family draws the BARE spelling, which is the only one the rung accepts', () => {
    // ⚠️ THE GUARD ON THE ROUTE, NOT ON THE TEXT. The TS chain rung declines an `ORDER BY`
    // outright, so a chain family that only ever emits the ordered spelling generates perfectly
    // good queries and reaches the rung ZERO times. That is not hypothetical — the first draft of
    // this generator did exactly that, and a `throw` at the rung's first statement left 20,000
    // workload queries GREEN. Nothing else in this suite can see it.
    const chains = sample.filter((w) => w.family === 'chain-rows');
    const bare = chains.filter((w) => !w.text.includes(' ORDER BY '));
    const threeSegmentBare = bare.filter((w) => (w.text.match(/\]->\(/g) ?? []).length >= 3);

    expect(chains.length).toBeGreaterThan(300);
    expect(bare.length).toBeGreaterThan(100);
    // Three segments is where the chain rung starts; two hops have had their own rung since
    // item 1619. A bare spelling that never reaches three segments guards the wrong rung.
    expect(threeSegmentBare.length).toBeGreaterThan(50);
  });

  test('the chain family draws far-end-only AND interior reads', () => {
    // The two route to different walks: a far-end-only projection is answered by the batched
    // sweep, an interior read must fall to the depth-first descent. A corpus covering one leaves
    // the other exactly as uncovered as the fuzzer left both before this item.
    const chains = sample.filter((w) => w.family === 'chain-rows');
    const interior = chains.filter((w) => /RETURN [bc]\.n|WHERE b\.n/.test(w.text));

    expect(interior.length).toBeGreaterThan(50);
    expect(chains.length - interior.length).toBeGreaterThan(50);
  });

  test('every family generator is reachable from the exported list', () => {
    // A family defined and then left out of `WORKLOAD_FAMILIES` is dead code that reads exactly
    // like coverage.
    expect(WORKLOAD_FAMILIES.length).toBe(WORKLOAD_FAMILY_NAMES.length);
  });

  test('the generator is deterministic for a given seed', () => {
    // The fuzzer prints a seed on failure and the whole triage workflow assumes replaying it
    // reproduces the query.
    const a = genWorkload(mulberry32(12345));
    const b = genWorkload(mulberry32(12345));

    expect(a).toEqual(b);
  });
});

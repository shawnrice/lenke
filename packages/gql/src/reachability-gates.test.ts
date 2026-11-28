import { describe, expect, it } from 'bun:test';

import type { PathMode, PathPattern, Quantifier } from './ast.ts';
import {
  isAcyclicMode,
  quantMin,
  quantifierServed,
  reachQuantifierIsExact,
  trailMinAdmissible,
} from './executor/reachability.ts';

/**
 * Item 2461: the var-length ADMISSION gates, which item 2460's coverage map put at the top of the
 * untested list — `quantifierServed`, `trailMinAdmissible`, `isAcyclicMode` and `quantMin` were
 * named in NO test, and `reachQuantifierIsExact` in exactly one.
 *
 * WHY THESE AND WHY UNIT TESTS. A route choice is ANSWER-EQUIVALENT in the direction that matters
 * most often: a gate that NARROWS sends a servable shape to the general matcher, which returns the
 * same rows more slowly, so no differential, fuzz or conformance test can see it
 * (`perf-gate-needs-its-own-test`). The other direction is worse than slow — `trailMinAdmissible`'s
 * mode exclusions are documented as "a measured divergence rather than caution" (item 2007, nine
 * hazard fixtures across three bounds), so WIDENING the mode test admits a shape the BFS-over-
 * reached-set arm answers WRONGLY. `ACYCLIC`/`TRAIL` admission is where this repo has already
 * shipped a wrong answer: the zero-length path omission went out at item 2002 and was caught at
 * 2005 by a fuzzer, not by a test like this one.
 *
 * These assert the VALUE at each boundary rather than that a gate "answered", which is
 * `gate-returning-a-value` — three wrong residuals got through that way, each of which routes and
 * then declines downstream with the same answer.
 */

const q = (min: number | undefined, max: number | null | undefined): Quantifier =>
  ({ min, max }) as Quantifier;

describe('reachQuantifierIsExact', () => {
  it('is false without a quantifier', () => {
    expect(reachQuantifierIsExact(undefined)).toBe(false);
  });

  it('admits min 0 and min 1, unbounded above', () => {
    expect(reachQuantifierIsExact(q(0, null))).toBe(true);
    expect(reachQuantifierIsExact(q(1, null))).toBe(true);
  });

  it('treats a missing min as 0', () => {
    expect(reachQuantifierIsExact(q(undefined, 1))).toBe(true);
  });

  it('refuses min 2 — the BFS reached-set is not exact there', () => {
    expect(reachQuantifierIsExact(q(2, null))).toBe(false);
    expect(reachQuantifierIsExact(q(2, 5))).toBe(false);
  });

  it('refuses max 0, which reaches nothing', () => {
    expect(reachQuantifierIsExact(q(0, 0))).toBe(false);
  });

  it('admits a bounded max of at least 1', () => {
    expect(reachQuantifierIsExact(q(0, 1))).toBe(true);
    expect(reachQuantifierIsExact(q(1, 9))).toBe(true);
  });
});

describe('trailMinAdmissible', () => {
  it('is false without a quantifier', () => {
    expect(trailMinAdmissible(undefined, 'trail')).toBe(false);
    expect(trailMinAdmissible(undefined, undefined)).toBe(false);
  });

  it('admits a bounded min >= 2 under the default mode and under TRAIL', () => {
    expect(trailMinAdmissible(q(2, 3), undefined)).toBe(true);
    expect(trailMinAdmissible(q(2, 3), 'trail')).toBe(true);
  });

  /*
   * THE MODE EXCLUSIONS ARE CORRECTNESS, NOT CAUTION (item 2007). Each of these modes reaches a
   * different vertex set than a trail does, so admitting one here answers wrongly rather than
   * slowly. A mutant that widens this test is a wrong-answer mutant.
   */
  it('refuses WALK, SIMPLE and ACYCLIC', () => {
    for (const mode of ['walk', 'simple', 'acyclic'] as PathMode[]) {
      expect(trailMinAdmissible(q(2, 3), mode)).toBe(false);
    }
  });

  it('refuses min < 2, which the exact arm serves instead', () => {
    expect(trailMinAdmissible(q(1, 3), 'trail')).toBe(false);
    expect(trailMinAdmissible(q(0, 3), 'trail')).toBe(false);
    expect(trailMinAdmissible(q(undefined, 3), 'trail')).toBe(false);
  });

  it('refuses an UNBOUNDED max — null and undefined alike', () => {
    expect(trailMinAdmissible(q(2, null), 'trail')).toBe(false);
    expect(trailMinAdmissible(q(2, undefined), 'trail')).toBe(false);
  });

  it('refuses an inverted range and admits the degenerate equal one', () => {
    expect(trailMinAdmissible(q(3, 2), 'trail')).toBe(false);
    expect(trailMinAdmissible(q(2, 2), 'trail')).toBe(true);
  });
});

describe('quantifierServed', () => {
  it('is served by the EXACT arm when min <= 1, and that arm ignores the mode', () => {
    // reachQuantifierIsExact takes no mode: a BFS over the reached set IS walk reachability, so
    // min <= 1 is served whatever the mode says. Pinning it because it is asymmetric with the
    // trail arm directly below, and the asymmetry looks like an oversight until you check.
    expect(quantifierServed(q(1, null), 'walk')).toBe(true);
    expect(quantifierServed(q(1, null), 'acyclic')).toBe(true);
    expect(quantifierServed(q(0, 4), 'simple')).toBe(true);
  });

  it('is served by the TRAIL arm for a bounded min >= 2 under trail or default', () => {
    expect(quantifierServed(q(2, 3), 'trail')).toBe(true);
    expect(quantifierServed(q(2, 3), undefined)).toBe(true);
  });

  it('is NOT served when neither arm applies', () => {
    expect(quantifierServed(q(2, 3), 'walk')).toBe(false);
    expect(quantifierServed(q(2, 3), 'acyclic')).toBe(false);
    expect(quantifierServed(q(2, null), 'trail')).toBe(false);
    expect(quantifierServed(undefined, 'trail')).toBe(false);
  });
});

describe('isAcyclicMode', () => {
  it('defaults to TRAIL, so an absent mode is NOT acyclic', () => {
    // The `?? 'trail'` default is the whole content of this gate. Were it `?? 'acyclic'`, every
    // unannotated pattern would take acyclic semantics.
    expect(isAcyclicMode({} as PathPattern)).toBe(false);
  });

  it('is true only for an explicit ACYCLIC', () => {
    expect(isAcyclicMode({ mode: 'acyclic' } as PathPattern)).toBe(true);
    expect(isAcyclicMode({ mode: 'trail' } as PathPattern)).toBe(false);
    expect(isAcyclicMode({ mode: 'walk' } as PathPattern)).toBe(false);
    expect(isAcyclicMode({ mode: 'simple' } as PathPattern)).toBe(false);
  });
});

describe('quantMin', () => {
  it('reads min, defaulting an absent one to 0', () => {
    expect(quantMin(q(5, 9))).toBe(5);
    expect(quantMin(q(0, 9))).toBe(0);
    expect(quantMin(q(undefined, 9))).toBe(0);
  });
});

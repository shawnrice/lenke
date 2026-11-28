import { describe, expect, it } from 'bun:test';

import { Graph } from '@lenke/core';

import { compileLinear } from './executor/rewrites.ts';
import { query } from './index.ts';
import { parse } from './parser.ts';

/**
 * Item 2464: `detectForCount` and `detectForProjection`, from item 2460's coverage map — named in
 * NO test file, like the other 16 `detect*` route detectors.
 *
 * A route detector's choice is ANSWER-EQUIVALENT: whichever arm answers, the rows are the same. So
 * a mutant that makes `detectForCount` decline is invisible to every differential, fuzz and
 * conformance suite in the repo — the general path simply answers more slowly
 * (`perf-gate-needs-its-own-test`). The opposite mutation is worse: a detector that ADMITS a shape
 * it cannot serve answers wrongly, and `compileLinear`'s own comment says why nothing downstream
 * will catch it — "EVERY detector RUNS … the field order below carries no precedence whatsoever."
 *
 * TESTED THROUGH `compileLinear` RATHER THAN BY HAND-BUILDING CLAUSES. The detectors take
 * `(fast, compiled)` where `fast` is the clause list after every rewrite PASS has run, so a
 * hand-made `Clause[]` would test a shape the planner never produces. 36 test files already use
 * this idiom.
 *
 * AND EVERY ROUTE ASSERTION IS PAIRED WITH THE ROWS THE ROUTE PRODUCES, which is
 * `gate-returning-a-value`: asserting a detector "returned something" let three wrong residuals
 * through (an empty result, an off-by-one, and a whole-plan), each of which routes and then
 * declines downstream to the same answer. So each test below CALLS the returned function and
 * compares against what the engine answers for the same text.
 */

const build = (): Graph => {
  const g = new Graph();

  for (const id of ['a', 'b']) {
    g.addVertex({ id, labels: ['Person'], properties: { tags: ['x', 'y'] } });
  }

  return g;
};

const g = build();

type Linear = Parameters<typeof compileLinear>[0];

const linear = (text: string): Linear => {
  const parsed = parse(text) as { parts?: readonly unknown[] };

  return (parsed.parts === undefined ? parsed : parsed.parts[0]) as Linear;
};

const routes = (text: string) => compileLinear(linear(text));

describe('detectForCount', () => {
  it('serves a FOR over a literal list under count(*), and its ROWS are the engine answer', () => {
    const text = 'MATCH (n:Person) FOR x IN [1, 2, 3] RETURN count(*) AS c';
    const compiled = routes(text);

    expect(compiled.forCount).not.toBeNull();
    // Two Person vertices x three list items. Asserted as a VALUE, not as "it returned a function".
    expect(compiled.forCount?.(g, {})).toStrictEqual([{ c: 6 }]);
    expect(query(g, text, {})).toStrictEqual([{ c: 6 }]);
  });

  it('serves a FOR over a PROPERTY list too', () => {
    const text = 'MATCH (n:Person) FOR t IN n.tags RETURN count(*) AS c';
    const compiled = routes(text);

    expect(compiled.forCount).not.toBeNull();
    // Two vertices x two tags each.
    expect(compiled.forCount?.(g, {})).toStrictEqual([{ c: 4 }]);
    expect(query(g, text, {})).toStrictEqual([{ c: 4 }]);
  });

  it('DECLINES when the projection is not a count — and the sibling takes it instead', () => {
    const text = 'MATCH (n:Person) FOR t IN n.tags RETURN t AS t';
    const compiled = routes(text);

    expect(compiled.forCount).toBeNull();
    expect(compiled.forProjection).not.toBeNull();
  });

  it('DECLINES a FOR under an aggregate it cannot fold, leaving the general path to answer', () => {
    // `sum` is not this detector's shape. The decline is the interesting half: NO fast field is
    // populated, and the answer is still right — which is exactly why no answer test can see a
    // mutation here.
    const text = 'MATCH (n:Person) FOR x IN [1, 2] RETURN sum(x) AS s';
    const compiled = routes(text);

    expect(compiled.forCount).toBeNull();
    expect(compiled.forProjection).toBeNull();
    expect(query(g, text, {})).toStrictEqual([{ s: 6 }]);
  });

  /*
   * THE FIXTURES BELOW EXIST BECAUSE FOUR ADMISSION MUTANTS SURVIVED the first cut of this file
   * (item 2464), and each survivor named a shape the fixtures could not reach. That is the FIXTURE
   * GAP verdict — the only one of the four survivor verdicts that is a test defect.
   *
   * The diagnosis matters more than the fix: my original no-FOR case has only TWO clauses, so the
   * `clauses.length < 3` guard rejected it before either kind check ran. A decline is not evidence
   * that a guard works; it is evidence that SOME guard works.
   */
  it('DECLINES a bare FOR with no MATCH — only two clauses, so the length guard rejects it', () => {
    const text = 'FOR x IN [1, 2, 3] RETURN count(*) AS c';
    const compiled = routes(text);

    expect(compiled.clauses.map((c) => c.kind)).toStrictEqual(['for', 'return']);
    expect(compiled.forCount).toBeNull();
    expect(query(g, text, {})).toStrictEqual([{ c: 3 }]);
  });

  it('DECLINES when the clause before the RETURN is not a FOR, with three clauses present', () => {
    // Reaches the `loop.kind !== 'for'` check, which the two-clause case above never does.
    const text = 'MATCH (a:Person) MATCH (b:Person) RETURN count(*) AS c';
    const compiled = routes(text);

    expect(compiled.clauses.map((c) => c.kind)).toStrictEqual(['match', 'match', 'return']);
    expect(compiled.forCount).toBeNull();
    expect(query(g, text, {})).toStrictEqual([{ c: 4 }]);
  });

  it('DECLINES when the last clause is a WRITE rather than a RETURN', () => {
    // `[match, for, set]` reaches the `ret.kind !== 'return'` check.
    const compiled = routes('MATCH (n:Person) FOR x IN [1, 2] SET n.k = x');

    expect(compiled.clauses.map((c) => c.kind)).toStrictEqual(['match', 'for', 'set']);
    expect(compiled.forCount).toBeNull();
  });

  it('DECLINES a list with a NON-LITERAL element, which is a correctness condition', () => {
    /*
     * The source says why this is not caution: "an element that FAULTS must fault, and the general
     * path is where that happens, so the whole list has to be inert." A `$param` element makes the
     * length known at compile time and the VALUES not, so admitting it would scale a count whose
     * evaluation might have raised.
     */
    const text = 'MATCH (n:Person) FOR x IN [1, $p] RETURN count(*) AS c';
    const compiled = routes(text);

    expect(compiled.forCount).toBeNull();
    expect(query(g, text, { p: 2 })).toStrictEqual([{ c: 4 }]);
  });

  it('DECLINES a nested FOR, because the BASE count cannot be taken', () => {
    // Both kind checks pass and the list is inert; the decline happens further in, where
    // `detectCountShortcut` is asked for the query with the inner FOR removed and refuses.
    const text = 'MATCH (n:Person) FOR x IN [1, 2] FOR y IN [3, 4] RETURN count(*) AS c';
    const compiled = routes(text);

    expect(compiled.forCount).toBeNull();
    expect(query(g, text, {})).toStrictEqual([{ c: 8 }]);
  });

  it('DECLINES a query with no FOR clause at all', () => {
    const text = 'MATCH (n:Person) RETURN count(*) AS c';
    const compiled = routes(text);

    expect(compiled.forCount).toBeNull();
    expect(compiled.forProjection).toBeNull();
    // A different rung answers this one, which is what makes it a valid decline rather than a gap.
    expect(compiled.countShortcut).not.toBeNull();
    expect(query(g, text, {})).toStrictEqual([{ c: 2 }]);
  });
});

describe('detectForProjection', () => {
  it('serves a FOR whose projection returns the loop variable, and its ROWS are the answer', () => {
    const text = 'MATCH (n:Person) FOR t IN n.tags RETURN t AS t';
    const compiled = routes(text);
    const expected = [{ t: 'x' }, { t: 'y' }, { t: 'x' }, { t: 'y' }];

    expect(compiled.forProjection).not.toBeNull();
    // Compared as a multiset: `order-is-unspecified` — an unordered result's row order is not a
    // contract, so this asserts CONTENT without pinning the walk.
    expect([...(compiled.forProjection?.(g, {}) ?? [])].sort()).toStrictEqual([...expected].sort());
    expect([...query(g, text, {})].sort()).toStrictEqual([...expected].sort());
  });

  it('DECLINES when the projection is a count, which its sibling serves', () => {
    const compiled = routes('MATCH (n:Person) FOR x IN [1, 2, 3] RETURN count(*) AS c');

    expect(compiled.forProjection).toBeNull();
    expect(compiled.forCount).not.toBeNull();
  });

  it('DECLINES a query with no FOR clause', () => {
    const compiled = routes('MATCH (n:Person) RETURN n.tags AS t');

    expect(compiled.forProjection).toBeNull();
    expect(compiled.forCount).toBeNull();
  });
});

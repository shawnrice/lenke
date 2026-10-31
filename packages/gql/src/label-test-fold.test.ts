/**
 * `MATCH (n) WHERE n IS LABELED L` folds to `MATCH (n:L)` — the rewrite's ROUTE and its EXCLUSIONS
 * (item 1303).
 *
 * TWO KINDS OF ASSERTION, because the fold has two kinds of failure.
 *
 * It is a ROUTE CHOICE, so it is answer-equivalent where it applies: a fold that silently stops
 * firing returns the same rows by the general pipeline, more slowly, and no answer test can see it.
 * That is the failure `perf-gate-needs-its-own-test` names and `routes-fired.test.ts` exists for, so
 * the positive cases here assert that the clause spelling takes THE SAME ROUTES as the pattern
 * spelling — which is the whole claim, stated as the engine can check it.
 *
 * Its EXCLUSIONS fail the other way round: folding where the fold is not sound is a WRONG ANSWER,
 * not a slow one. Those cases assert answers, and they assert the answer the engine gives TODAY —
 * descriptively, the way `routes-fired.test.ts` says its rows are. The contract being pinned is
 * "the fold does not change this", not "this is the conformant result"; for `OPTIONAL MATCH` in
 * particular the conformance question is item 1226's and still open, which is exactly why an
 * optimization must not be the thing that moves it.
 */
import { describe, expect, it } from 'bun:test';

import { Graph } from '@lenke/core';

import { compileLinear, foldLabelTestsIntoPatterns } from './executor.ts';
import { query } from './index.ts';
import { parse } from './parser.ts';

/** The shape of a rewritten `MATCH`, narrowed to the parts this rewrite is allowed to touch. */
type FoldedMatch = {
  kind: string;
  where?: unknown;
  patterns: readonly {
    start: { variable?: string; label?: unknown };
    segments: readonly { node: { variable?: string; label?: unknown } }[];
  }[];
};

/**
 * The FIRST clause of `src` after the rewrite — the rewrite's own output, not a route summary.
 *
 * This is the assertion with teeth, and the measurement that says so is in the export comment on
 * `foldLabelTestsIntoPatterns`: with the fold disabled, five of the six route twins below still
 * passed, because `countShortcut` fires for both spellings regardless. Only an assertion on the
 * rewritten AST distinguishes "the fold ran" from "the detector fired anyway".
 */
const folded = (src: string): FoldedMatch => {
  const [linear] = (parse(src) as never as { parts: readonly { clauses: readonly never[] }[] })
    .parts;
  const [first] = foldLabelTestsIntoPatterns(linear.clauses) as never as readonly FoldedMatch[];

  return first;
};

const L = (name: string) => ({ kind: 'label', name });

/**
 * The detector fields that came back non-null, sorted — i.e. the routes this query will take.
 *
 * A six-line copy of `routes-fired.test.ts`'s helper rather than an import: that file does not
 * export it, and a test reaching into another test file for a helper couples two suites that should
 * fail independently.
 */
const routes = (src: string): string[] => {
  const q = parse(src) as never as { parts: readonly never[] };
  const cl = compileLinear(q.parts[0]) as unknown as Record<string, unknown>;

  return Object.entries(cl)
    .filter(([k, v]) => k !== 'clauses' && v !== null && v !== undefined)
    .map(([k]) => k)
    .sort();
};

/**
 * NO LABEL IS ON EVERY VERTEX, deliberately.
 *
 * `vacuousLabel` deletes a label every live vertex carries, and item 1302 lost a whole measurement
 * to that: the arm it believed was start-filtered had its label dropped and measured the bare plan
 * instead. A fixture where `P` covered everything would make the start-labelled cases here agree
 * for a reason that has nothing to do with the fold.
 */
const build = (): Graph => {
  const g = new Graph();

  for (const [id, labels, age] of [
    ['a', ['P'], 10],
    ['b', ['P', 'E'], 20],
    ['c', ['E'], 30],
    ['d', ['Q'], 40],
  ] as ReadonlyArray<readonly [string, string[], number]>) {
    g.addVertex({ id, labels, properties: { age } });
  }

  const v = (id: string) => g.verticesById.get(id)!;

  for (const [id, from, to, label] of [
    ['e1', 'a', 'b', 'T'],
    ['e2', 'a', 'c', 'T'],
    ['e3', 'b', 'c', 'T'],
    ['e4', 'c', 'd', 'T'],
    ['e5', 'b', 'd', 'S'],
    // A SELF-LOOP on `b`, which is an `E`. Without it the "variable at two node positions" case
    // counts 0 either way and the exclusion is asserted against an empty answer — the vacuous
    // fixture that let two of item 1302's mutants survive.
    ['e6', 'b', 'b', 'T'],
  ] as ReadonlyArray<readonly [string, string, string, string]>) {
    g.addEdge({ id, from: v(from), to: v(to), labels: [label], properties: {} });
  }

  return g;
};

const c = (g: Graph, src: string): number =>
  Number((query(g, src)[0] as Record<string, unknown>).c);

describe('the rewrite puts the label on the node and removes the clause', () => {
  it('folds a bare scan', () => {
    const m = folded('MATCH (n) WHERE n IS LABELED E RETURN count(*) AS c');

    expect(m.patterns[0].start.label).toEqual(L('E'));
    // The `where` KEY must be absent, not present holding `undefined`: the claim is that the two
    // spellings become one clause object.
    expect('where' in m).toBe(false);
  });

  it('folds onto the FAR node of a hop', () => {
    const m = folded('MATCH (a)-[:T]->(b) WHERE b IS LABELED E RETURN count(*) AS c');

    expect(m.patterns[0].segments[0].node.label).toEqual(L('E'));
    expect(m.patterns[0].start.label).toBeUndefined();
    expect('where' in m).toBe(false);
  });

  it('folds BOTH ends from one AND', () => {
    const m = folded(
      'MATCH (a)-[:T]->(b) WHERE a IS LABELED P AND b IS LABELED E RETURN count(*) AS c',
    );

    expect(m.patterns[0].start.label).toEqual(L('P'));
    expect(m.patterns[0].segments[0].node.label).toEqual(L('E'));
    expect('where' in m).toBe(false);
  });

  it('ANDs onto a label the pattern already carries', () => {
    const m = folded('MATCH (n:P) WHERE n IS LABELED E RETURN count(*) AS c');

    expect(m.patterns[0].start.label).toEqual({ kind: 'and', left: L('P'), right: L('E') });
  });

  it('folds a negated test as a `not`', () => {
    const m = folded('MATCH (n) WHERE n IS NOT LABELED E RETURN count(*) AS c');

    expect(m.patterns[0].start.label).toEqual({ kind: 'not', expr: L('E') });
  });

  it('KEEPS an unfoldable conjunct and still folds the label', () => {
    const m = folded('MATCH (n) WHERE n IS LABELED E AND n.age > 25 RETURN count(*) AS c');

    expect(m.patterns[0].start.label).toEqual(L('E'));
    // The residual survives as the lone conjunct — not wrapped in a one-item `and`.
    expect(m.where).toMatchObject({ kind: 'compare' });
  });

  // THE EXCLUSIONS, asserted as "the rewrite did NOT touch this". Each is a shape where folding
  // would be a wrong answer, so a mutant that drops the guard must be visible here and not only
  // in an answer that happens to coincide on this fixture.
  const UNTOUCHED: ReadonlyArray<readonly [string, string]> = [
    ['an OPTIONAL MATCH', 'OPTIONAL MATCH (n) WHERE n IS LABELED E RETURN count(*) AS c'],
    ['a quantified segment', 'MATCH (a)-[:T]->{1,2}(b) WHERE b IS LABELED E RETURN count(*) AS c'],
    ['an edge variable', 'MATCH (a)-[r]->(b) WHERE r IS LABELED T RETURN count(*) AS c'],
    // ⚠️ THE COLLISION IS THE CASE THAT NEEDS THE REL POISONING, and the plain edge-variable row
    // above is NOT it: `r` never appears at a node position, so it is absent from the site map and
    // declined by absence whether the poisoning runs or not. Measured — removing the poisoning
    // block survived the whole 3,287-test suite until this row existed.
    //
    // Here the names COLLIDE, and `a` binds the RELATIONSHIP: on a graph with one `T` edge from a
    // `P` node, `WHERE a IS LABELED T` answers 1 while `WHERE a IS LABELED P` answers 0. So a fold
    // onto the node `a` would test the node's labels and answer the second question.
    [
      'a variable that is BOTH a node and a relationship',
      'MATCH (a)-[a]->(b) WHERE a IS LABELED T RETURN count(*) AS c',
    ],
    [
      'a variable at two node positions',
      'MATCH (n)-[:T]->(n) WHERE n IS LABELED E RETURN count(*) AS c',
    ],
    // A path SELECTOR. Note what actually declines this: the engine accepts a selector ONLY with a
    // single variable-length segment (`ANY SHORTEST (a)-[:T]->(m)-[:T]->(b)` is a syntax error), so
    // the QUANTIFIER guard reaches it first and the selector guard is never the deciding condition.
    // That is why the mutant removing the selector guard survives — see `patternTakesFold`.
    [
      'a path selector',
      'MATCH ANY SHORTEST (a)-[:T]->+(b) WHERE b IS LABELED E RETURN count(*) AS c',
    ],
    [
      'a SHORTEST k selector',
      'MATCH SHORTEST 2 (a)-[:T]->+(b) WHERE b IS LABELED E RETURN count(*) AS c',
    ],
  ];

  for (const [name, src] of UNTOUCHED) {
    it(`leaves ${name} alone`, () => {
      const m = folded(src);

      expect(m.where).toBeDefined();
      expect(m.patterns[0].start.label).toBeUndefined();

      for (const seg of m.patterns[0].segments) {
        expect(seg.node.label).toBeUndefined();
      }
    });
  }
});

describe('a clause label test routes exactly as the pattern label does', () => {
  // Each pair is the SAME question in two spellings. The fold's claim is that they become one plan,
  // so they must take the same routes AND answer the same number.
  const TWINS: ReadonlyArray<readonly [string, string, string]> = [
    [
      'a bare scan count',
      'MATCH (n) WHERE n IS LABELED E RETURN count(*) AS c',
      'MATCH (n:E) RETURN count(*) AS c',
    ],
    [
      'a far-end label on a one-hop count',
      'MATCH (a)-[:T]->(b) WHERE b IS LABELED E RETURN count(*) AS c',
      'MATCH (a)-[:T]->(b:E) RETURN count(*) AS c',
    ],
    [
      'a START label on a one-hop count',
      'MATCH (a)-[:T]->(b) WHERE a IS LABELED P RETURN count(*) AS c',
      'MATCH (a:P)-[:T]->(b) RETURN count(*) AS c',
    ],
    [
      'both ends at once',
      'MATCH (a)-[:T]->(b) WHERE a IS LABELED P AND b IS LABELED E RETURN count(*) AS c',
      'MATCH (a:P)-[:T]->(b:E) RETURN count(*) AS c',
    ],
    [
      'a projection, not a count',
      'MATCH (n) WHERE n IS LABELED E RETURN n.age AS c ORDER BY c',
      'MATCH (n:E) RETURN n.age AS c ORDER BY c',
    ],
    [
      'the COLON spelling of the same predicate',
      'MATCH (n) WHERE n:E RETURN count(*) AS c',
      'MATCH (n:E) RETURN count(*) AS c',
    ],
  ];

  for (const [name, clause, pattern] of TWINS) {
    it(`${name} routes identically`, () => {
      // Non-empty, or two shapes that both route nowhere would satisfy this vacuously.
      expect(routes(pattern).length).toBeGreaterThan(0);
      expect(routes(clause)).toEqual(routes(pattern));
    });

    it(`${name} answers identically`, () => {
      const g = build();

      expect(query(g, clause)).toEqual(query(g, pattern));
    });
  }
});

describe('the fold composes with what is already on the node', () => {
  it('ANDs onto an existing pattern label instead of replacing it', () => {
    const g = build();

    // `b` alone carries both. Dropping the pattern label would answer 2 (every `E`).
    expect(c(g, 'MATCH (n:P) WHERE n IS LABELED E RETURN count(*) AS c')).toBe(1);
    expect(c(g, 'MATCH (n:P) RETURN count(*) AS c')).toBe(2);
    expect(c(g, 'MATCH (n:E) RETURN count(*) AS c')).toBe(2);
  });

  it('folds TWO tests on the same variable', () => {
    const g = build();

    expect(c(g, 'MATCH (n) WHERE n IS LABELED P AND n IS LABELED E RETURN count(*) AS c')).toBe(1);
  });

  it('keeps the conjuncts it cannot fold', () => {
    const g = build();

    // Only `c` is an `E` older than 25. A fold that dropped the residual would answer 2.
    expect(c(g, 'MATCH (n) WHERE n IS LABELED E AND n.age > 25 RETURN count(*) AS c')).toBe(1);
    // And the other way round, so neither ordering is privileged.
    expect(c(g, 'MATCH (n) WHERE n.age > 25 AND n IS LABELED E RETURN count(*) AS c')).toBe(1);
  });

  it('folds a NEGATED test as a `not` label expression', () => {
    const g = build();

    expect(c(g, 'MATCH (n) WHERE n IS NOT LABELED E RETURN count(*) AS c')).toBe(2);
    expect(c(g, 'MATCH (n) WHERE NOT (n IS LABELED E) RETURN count(*) AS c')).toBe(2);
    // The negated test must not be folded as if it were POSITIVE — that mutant answers 2 as well
    // on a 50/50 fixture, which is why `E` is on 2 of 4 and `Q` on 1 of 4.
    expect(c(g, 'MATCH (n) WHERE n IS NOT LABELED Q RETURN count(*) AS c')).toBe(3);
  });
});

describe('the exclusions: shapes where a pattern label is NOT the same question', () => {
  it('declines an edge variable, whose pattern label is its TYPE', () => {
    const g = build();

    // `r` is a relationship. Folding `r IS LABELED S` into the NODE `b` would answer 0.
    expect(c(g, 'MATCH (a)-[r]->(b) WHERE r IS LABELED S RETURN count(*) AS c')).toBe(1);
    expect(c(g, 'MATCH (a)-[r]->(b) WHERE r IS LABELED T RETURN count(*) AS c')).toBe(5);
  });

  it('declines a COLLIDING name, where the variable binds the relationship', () => {
    const g = build();

    // `a` is both the node and the edge here, and the EDGE binding is the one the engine keeps.
    // Folding onto the node would turn the first question into the second.
    expect(c(g, 'MATCH (a)-[a]->(b) WHERE a IS LABELED T RETURN count(*) AS c')).toBe(5);
    expect(c(g, 'MATCH (a)-[a]->(b) WHERE a IS LABELED P RETURN count(*) AS c')).toBe(0);
  });

  it('declines a variable used at more than one node position', () => {
    const g = build();

    // The self-loop on `b` makes this non-zero, so the row is not asserted against an empty
    // answer. The ANSWER is the same either way — both positions bind the same element, so a fold
    // into one of them tests the same vertex — which is why the mutant that drops the poisoning is
    // caught by the REWRITE assertion above and not by this number.
    expect(c(g, 'MATCH (n)-[:T]->(n) WHERE n IS LABELED E RETURN count(*) AS c')).toBe(1);
    expect(c(g, 'MATCH (n)-[:T]->(n) WHERE n IS LABELED Q RETURN count(*) AS c')).toBe(0);
  });
});

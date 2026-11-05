import { describe, expect, it } from 'bun:test';

/**
 * ITEM 1490 — a temporal LITERAL in a predicate declined every single-node and hop fast path,
 * because the AST walk that decides the route mistook the stored `Temporal` for an expression.
 *
 * The six temporal classes each carry `readonly kind = 'date'` (etc.) as their `instanceof`
 * discriminant. `rowLocalChild` / `itemLocalChild` treat ANY object with a string `kind` as an
 * `Expr`, so `{ kind: 'lit', value: <LocalDate> }` — what the parser lowers `DATE '…'` to — was
 * handed to `rowLocal` as an expression of kind `'date'`, missed the allowlist, and declined.
 *
 * ⚠️ THE ROUTE IS ANSWER-EQUIVALENT, so the differential suites cannot see a mutant in it — every
 * query below answers identically on both routes, which is exactly why the bug survived. That is
 * `perf-gate-needs-its-own-test`: the first half of this file tests the PURE PREDICATES directly,
 * where a wrong answer IS observable. The second half is the behavioural backstop.
 *
 * Measured at 200,000 vertices, FANOUT=2 scattered: node 15.07 -> 6.41 ms (2.35x), the same shape
 * projecting the temporal 15.69 -> 6.75 (2.32x), the hop 26.60 -> 7.16 (3.72x). Numeric-literal
 * and temporal-PARAM controls moved 1.08-1.14x.
 */
import { Graph, LocalDate, temporalParse } from '@lenke/core';

import type { Expr } from './ast.js';
import { itemLocal, rowLocal } from './executor/shortcuts.js';
import { query } from './index.js';

const lit = (value: unknown): Expr => ({ kind: 'lit', value });

describe('the route predicates admit a literal whatever it holds', () => {
  it('admits a plain numeric literal', () => {
    expect(rowLocal(lit(5))).toBe(true);
    expect(itemLocal(lit(5))).toBe(true);
  });

  it('admits a DATE literal — the measured regression', () => {
    const d = temporalParse('date', '2029-11-10');

    expect(d).toBeInstanceOf(LocalDate);
    // The collision itself: the stored value's discriminant looks like an expression kind.
    expect((d as unknown as { kind: string }).kind).toBe('date');
    expect(rowLocal(lit(d))).toBe(true);
    expect(itemLocal(lit(d))).toBe(true);
  });

  it('admits every temporal kind, not just date', () => {
    for (const [tag, iso] of [
      ['date', '2029-11-10'],
      ['localtime', '12:34:56'],
      ['datetime', '2029-11-10T12:34:56'],
      ['zoned_datetime', '2029-11-10T12:34:56+01:00'],
      ['zoned_time', '12:34:56+01:00'],
      ['duration', 'P1Y2M3DT4H5M6S'],
    ] as const) {
      const v = temporalParse(tag, iso);

      expect(rowLocal(lit(v))).toBe(true);
      expect(itemLocal(lit(v))).toBe(true);
    }
  });

  it('admits a literal holding a plain object with a `kind` key — the general case', () => {
    // Not reachable from today's parser, and that is the point: the guard is on the `lit` rather
    // than on `isTemporal(value)` so the next value type to carry a `kind` does not re-break it.
    expect(rowLocal(lit({ kind: 'exists', nope: true }))).toBe(true);
    expect(itemLocal(lit({ kind: 'exists', nope: true }))).toBe(true);
  });

  it('admits a temporal literal NESTED in a comparison, which is the real shape', () => {
    const cmp = {
      kind: 'compare',
      op: '>',
      left: { kind: 'prop', variable: 'n', key: 'd' },
      right: lit(temporalParse('date', '2029-11-10')),
    } as unknown as Expr;

    expect(rowLocal(cmp)).toBe(true);
    expect(itemLocal(cmp)).toBe(true);
  });

  it('STILL DECLINES a genuine non-row-local expression — the guard did not widen the allowlist', () => {
    // If the `lit` stop were written as an unconditional early return, or placed before the
    // allowlist check, these would start passing and the fast path would answer shapes it was
    // never checked against.
    const sub = { kind: 'exists', pattern: {} } as unknown as Expr;

    expect(rowLocal(sub)).toBe(false);
    expect(rowLocal({ kind: 'nonesuch' } as unknown as Expr)).toBe(false);
    // An aggregate is still refused even though its argument is a literal.
    expect(rowLocal({ kind: 'func', name: 'count', args: [lit(1)] } as unknown as Expr)).toBe(
      false,
    );
  });

  it('STILL DESCENDS into an allowlisted node — a NESTED refusal is still refused', () => {
    // ⚠️ THIS CASE EXISTS BECAUSE A MUTANT SURVIVED WITHOUT IT. Replacing the `lit` stop with
    // `if (e.kind !== undefined) return true;` — admit anything that got past the allowlist,
    // without descending — left all 17 of the other tests green, because every decline they
    // check is refused by the allowlist at the TOP level, before the stop is ever reached. The
    // walk's whole job is the descent, so the test has to put the refusal UNDERNEATH an
    // admissible node. Item 475's rule read the other way round: a survivor is as readily an
    // untested guard as a redundant one.
    const nestedSubquery = {
      kind: 'and',
      left: { kind: 'prop', variable: 'n', key: 'k' },
      right: { kind: 'exists', pattern: {} },
    } as unknown as Expr;

    // `rowLocal` refuses a subquery outright (`exists` is not in the allowlist).
    expect(rowLocal(nestedSubquery)).toBe(false);

    // `itemLocal` ADMITS a subquery by design, so its nested refusal has to be an aggregate.
    const nestedAggregate = {
      kind: 'and',
      left: { kind: 'prop', variable: 'n', key: 'k' },
      right: { kind: 'func', name: 'count', args: [lit(1)] },
    } as unknown as Expr;

    expect(itemLocal(nestedAggregate)).toBe(false);
    expect(rowLocal(nestedAggregate)).toBe(false);

    // And one level deeper, under the arithmetic wrapper item 207 found the walk mishandling.
    const deep = {
      kind: 'arith',
      head: { kind: 'prop', variable: 'n', key: 'k' },
      tail: [['+', { kind: 'func', name: 'sum', args: [lit(1)] }]],
    } as unknown as Expr;

    expect(rowLocal(deep)).toBe(false);
    expect(itemLocal(deep)).toBe(false);
  });
});

/** Both arms store the SAME ordinal twice, so a numeric and a temporal predicate select one set. */
const fixture = (): Graph => {
  const g = new Graph();
  const ids: string[] = [];

  for (let i = 0; i < 40; i += 1) {
    const day = `2029-11-${String((i % 28) + 1).padStart(2, '0')}`;

    ids.push(`v${i}`);
    g.addVertex({
      id: `v${i}`,
      labels: ['P'],
      properties: { ord: (i % 28) + 1, d: { '@date': day }, k: i % 5 },
    });
  }

  for (let e = 0; e < 40; e += 1) {
    const from = g.getVertexById(ids[e % 40]);
    const to = g.getVertexById(ids[(e * 7 + 1) % 40]);

    if (from === null || to === null) {
      throw new Error('fixture endpoint missing');
    }

    g.addEdge({ id: `e${e}`, labels: ['E'], from, to });
  }

  return g;
};

describe('a temporal literal answers the same as its equivalent spellings', () => {
  const g = fixture();
  const cut = { '@date': '2029-11-14' };

  for (const op of ['>', '>=', '<', '<=', '=', '<>'] as const) {
    it(`node scan, \`${op}\`: literal, param and numeric twin agree`, () => {
      const viaLit = query(g, `MATCH (n:P) WHERE n.d ${op} DATE '2029-11-14' RETURN n.id AS i`);
      const viaParam = query(g, `MATCH (n:P) WHERE n.d ${op} $c RETURN n.id AS i`, { c: cut });
      const viaNum = query(g, `MATCH (n:P) WHERE n.ord ${op} 14 RETURN n.id AS i`);
      const sortIds = (rows: readonly Record<string, unknown>[]): string[] =>
        rows.map((r) => String(r.i)).sort();

      expect(sortIds(viaLit)).toEqual(sortIds(viaParam));
      expect(sortIds(viaLit)).toEqual(sortIds(viaNum));
      expect(viaLit.length).toBeGreaterThan(0);
    });
  }

  it('node scan with ORDER BY + LIMIT — the top-K arm', () => {
    const viaLit = query(
      g,
      "MATCH (n:P) WHERE n.d > DATE '2029-11-14' RETURN n.ord AS v ORDER BY v LIMIT 5",
    );
    const viaParam = query(g, 'MATCH (n:P) WHERE n.d > $c RETURN n.ord AS v ORDER BY v LIMIT 5', {
      c: cut,
    });

    expect(viaLit).toEqual(viaParam);
    expect(viaLit.length).toBe(5);
  });

  it('node scan PROJECTING the temporal, not just filtering on one', () => {
    const viaLit = query(g, "MATCH (n:P) WHERE n.d > DATE '2029-11-14' RETURN n.d AS d, n.k AS k");
    const viaParam = query(g, 'MATCH (n:P) WHERE n.d > $c RETURN n.d AS d, n.k AS k', { c: cut });

    expect(viaLit.length).toBe(viaParam.length);
    expect(JSON.stringify(viaLit)).toBe(JSON.stringify(viaParam));
  });

  it('hop, which routes through `rowLocal` rather than `itemLocal`', () => {
    const viaLit = query(
      g,
      "MATCH (a:P)-[:E]->(b:P) WHERE a.d > DATE '2029-11-14' RETURN b.k AS k",
    );
    const viaParam = query(g, 'MATCH (a:P)-[:E]->(b:P) WHERE a.d > $c RETURN b.k AS k', {
      c: cut,
    });

    expect(viaLit.length).toBe(viaParam.length);
    expect(viaLit.length).toBeGreaterThan(0);
    expect([...viaLit].map((r) => r.k).sort()).toEqual([...viaParam].map((r) => r.k).sort());
  });

  it('an inline `{d: DATE …}` constraint agrees with the clause WHERE — the other spelling pair', () => {
    const inline = query(g, "MATCH (n:P {d: DATE '2029-11-14'}) RETURN n.id AS i");
    const clause = query(g, "MATCH (n:P) WHERE n.d = DATE '2029-11-14' RETURN n.id AS i");

    expect([...inline].map((r) => r.i).sort()).toEqual([...clause].map((r) => r.i).sort());
    expect(inline.length).toBeGreaterThan(0);
  });

  it('a temporal literal in the PROJECTION, with no temporal predicate at all', () => {
    const rows = query(g, "MATCH (n:P) WHERE n.k = 0 RETURN DATE '2029-11-14' AS d");

    expect(rows.length).toBe(8);
    expect(JSON.stringify(rows[0].d)).toBe(JSON.stringify({ '@date': '2029-11-14' }));
  });
});

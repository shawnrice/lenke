import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { compileLinear } from './executor/rewrites.js';
import { query } from './index.js';
import { parse } from './parser.js';

/**
 * `ORDER BY <an expression>` with NO WINDOW reaches the deferred compiled-key arm (item 1902).
 *
 * Item 1062 built that arm for WINDOWED sorts and its header states the asymmetry it left behind:
 * `outputColumnSorts` requires every key to NAME an output column and substitutes only a `prop`
 * alias, so `ORDER BY n.k + 1` reached no rung while `ORDER BY n.k + 1 LIMIT 3` reached this one.
 * Item 1901 measured the unwindowed gap at **8.9x** over 200,000 rows.
 *
 * ⚠️⚠️ **THE ORACLE IS `OFFSET 0`, AND IT NEEDS NO KILL SWITCH.** A `SKIP` with no `LIMIT` still
 * DECLINES the arm — that refusal is about faults on rows a window discards and is deliberately
 * unchanged — so `… ORDER BY <expr> OFFSET 0` runs the GENERAL PATH and drops nothing. Every answer
 * below is therefore asserted against the same query written both ways, which compares the new
 * route to the old one directly rather than to a hand-written array that could encode my own
 * mistake.
 *
 * ⚠️ AND `ORDER BY n.k + 1` MUST ORDER LIKE `ORDER BY n.k`, because adding 1 is monotone. That is
 * the equivalent-spelling claim the whole item is about, and it is checked here as an answer rather
 * than only as a time in `bun run spelling`.
 */
const fixture = (): Graph => {
  const g = new Graph();

  // ⚠️ TIES ARE THE POINT OF `k`'s POOL: `Array.prototype.sort` is stable, so tie order is ARRIVAL
  // order, and tie order under `ORDER BY` is OBSERVABLE between the engines (item 605). A fixture
  // of distinct keys cannot see a tiebreak change at all.
  const K = [3, 1, 3, 2, 1, 3, 2, 1];

  for (const [i, k] of K.entries()) {
    g.addVertex({
      id: String(i + 1),
      labels: ['T'],
      properties: {
        k,
        // `s` tags arrival order, so a tie's resolution is readable in the answer.
        s: `v${String(i + 1)}`,
        // `nu` is NULL on a third of them, so a computed key goes null and NULLS placement shows.
        nu: i % 3 === 1 ? null : k,
      },
    });
  }

  // `odd` carries no `m` at all, so `n.m + 1` is null for it — an ABSENT key, not a stored null.
  g.addVertex({ id: '99', labels: ['T'], properties: { k: 9, s: 'v99', nu: 9, m: 4 } });

  return g;
};

/** The same query with `OFFSET 0` appended — the general path, dropping nothing. */
const bothRoutes = (g: Graph, text: string): unknown[] => {
  const viaRung = query(g, text);
  const viaGeneral = query(g, `${text} OFFSET 0`);

  expect(viaRung).toStrictEqual(viaGeneral);

  return viaRung;
};

describe('an unwindowed expression sort key agrees with the general path', () => {
  test('a monotone expression key orders exactly like the bare property', () => {
    const g = fixture();
    const viaExpr = bothRoutes(g, 'MATCH (n:T) RETURN n.s AS s ORDER BY n.k + 1');

    // `ORDER BY n.k` takes the PLAIN arm (`outputColumnSorts` substitutes a `prop` alias since
    // item 642), so this compares the new route against a THIRD one, not just against the general
    // path — and the orders must be identical because adding 1 is monotone.
    expect(viaExpr).toStrictEqual(query(g, 'MATCH (n:T) RETURN n.s AS s ORDER BY n.k'));
  });

  test('ties keep ARRIVAL order', () => {
    const g = fixture();

    // k = 1 arrives as v2, v5, v8; k = 2 as v4, v7; k = 3 as v1, v3, v6; then k = 9 as v99.
    expect(bothRoutes(g, 'MATCH (n:T) RETURN n.s AS s ORDER BY n.k + 1')).toStrictEqual([
      { s: 'v2' },
      { s: 'v5' },
      { s: 'v8' },
      { s: 'v4' },
      { s: 'v7' },
      { s: 'v1' },
      { s: 'v3' },
      { s: 'v6' },
      { s: 'v99' },
    ]);
  });

  test('DESC', () => {
    const g = fixture();
    const rows = bothRoutes(g, 'MATCH (n:T) RETURN n.s AS s ORDER BY n.k + 1 DESC');

    expect((rows[0] as { s: string }).s).toBe('v99');
  });

  test('a NULL key, from a stored null and from an ABSENT one', () => {
    const g = fixture();

    // `nu` is a stored null on v2, v5, v8; `m` is absent on everything but v99.
    bothRoutes(g, 'MATCH (n:T) RETURN n.s AS s ORDER BY n.nu + 1');
    bothRoutes(g, 'MATCH (n:T) RETURN n.s AS s ORDER BY n.m + 1');
  });

  test('two keys, the second deciding', () => {
    const g = fixture();

    bothRoutes(g, 'MATCH (n:T) RETURN n.s AS s ORDER BY n.k + 1, n.s');
    bothRoutes(g, 'MATCH (n:T) RETURN n.s AS s ORDER BY n.k + 1 DESC, n.s');
  });

  test('a key naming an ALIAS whose item is itself an expression', () => {
    const g = fixture();

    bothRoutes(g, 'MATCH (n:T) RETURN n.k + 1 AS c, n.s AS s ORDER BY c');
    bothRoutes(g, 'MATCH (n:T) RETURN n.k + 1 AS c, n.s AS s ORDER BY n.k + 1');
  });

  test('the key may read a property the projection does not', () => {
    const g = fixture();

    bothRoutes(g, 'MATCH (n:T) RETURN n.s AS s ORDER BY n.nu * 2');
  });

  test('a WHERE in front of it', () => {
    const g = fixture();

    expect(
      bothRoutes(g, 'MATCH (n:T) WHERE n.k > 1 RETURN n.s AS s ORDER BY n.k + 1'),
    ).toHaveLength(6);
  });
});

/**
 * ⚠️⚠️ THE ROUTE IS ITS OWN ASSERTION, because taking the arm is ANSWER-EQUIVALENT — every test
 * above passes with the change reverted, and a mutant restoring the old gate survives all of them.
 * [[perf-gate-needs-its-own-test]]. `compileLinear` runs every detector and returns the set, so a
 * non-null `nodeProjection` means a rung claimed the query and an all-null result means the general
 * path, whatever the precedence between rungs is.
 */
describe('the ROUTE, which the answers cannot see', () => {
  const rungsFor = (text: string): string[] => {
    const stmt = parse(text);

    // `parse` returns a `Statement` union whose `TxControl` arm carries no `parts`; every query
    // here is a linear statement, so narrowing is the honest way past it.
    if (!('parts' in stmt)) {
      throw new Error('not a linear statement');
    }

    const [part] = stmt.parts;
    const lin = compileLinear(part) as Record<string, unknown> | undefined;

    return lin === undefined
      ? []
      : Object.entries(lin)
          .filter(([k, v]) => v !== undefined && v !== null && k !== 'clauses' && k !== 'writes')
          .map(([k]) => k);
  };

  test('an unwindowed expression key reaches a rung', () => {
    expect(rungsFor('MATCH (n:T) RETURN n.n AS x ORDER BY n.n + 1')).toContain('nodeProjection');
  });

  test('so does the alias spelling, unchanged', () => {
    expect(rungsFor('MATCH (n:T) RETURN n.n AS x ORDER BY x')).toContain('nodeProjection');
  });

  test('a windowed one still does', () => {
    expect(rungsFor('MATCH (n:T) RETURN n.n AS x ORDER BY n.n + 1 LIMIT 3')).toContain(
      'nodeProjection',
    );
  });

  /** ⚠️ The two refusals the item left alone, asserted as refusals rather than assumed. */
  test('a SKIP with no LIMIT still reaches NO rung', () => {
    expect(rungsFor('MATCH (n:T) RETURN n.n AS x ORDER BY n.n + 1 OFFSET 1')).toStrictEqual([]);
  });

  test('LIMIT 0 still reaches NO rung', () => {
    expect(rungsFor('MATCH (n:T) RETURN n.n AS x ORDER BY n.n + 1 LIMIT 0')).toStrictEqual([]);
  });
});

/**
 * One node with `nan` a STORED NaN, so `nu * nan` is NaN and `true + NaN` raises — the fixture
 * `page-fold-fault.test.ts` built for item 1056, reused because the fault rule is the same rule.
 */
const withFaultingRow = (): Graph => {
  const g = new Graph();

  g.addVertex({ id: 'bad', labels: ['T'], properties: { n: 0, nu: 5 } });

  for (let i = 1; i <= 3; i += 1) {
    g.addVertex({ id: `ok${String(i)}`, labels: ['T'], properties: { n: i, nu: null } });
  }

  query(g, 'MATCH (n:T) WHERE n.n = 0 SET n.nan = sin(1e400) RETURN count(*) AS c');

  return g;
};

const FAULTS = '(1 < 2) + (n.nu * n.nan)';

/**
 * ⚠️⚠️ THE FAULT RULE IS WHY THIS ARM REFUSED EVERYTHING UNWINDOWED, so it gets its own section.
 * The argument for admitting NO window is that nothing is discarded, so both paths evaluate every
 * key and every item and raise on the same inputs — and these tests are that argument as code.
 */
describe('the fault rule still holds either side of the change', () => {
  test('with NO window, a faulting projected item raises — as it does on the general path', () => {
    const g = withFaultingRow();

    expect(() => query(g, `MATCH (n:T) RETURN ${FAULTS} AS x ORDER BY n.n + 1`)).toThrow();
    // The general-path spelling of the same query raises too, which is the parity claim.
    expect(() => query(g, `MATCH (n:T) RETURN ${FAULTS} AS x ORDER BY n.n + 1 OFFSET 0`)).toThrow();
  });

  test('a faulting SORT KEY raises with no window, both routes', () => {
    const g = withFaultingRow();

    expect(() => query(g, `MATCH (n:T) RETURN n.n AS t ORDER BY ${FAULTS}`)).toThrow();
    expect(() => query(g, `MATCH (n:T) RETURN n.n AS t ORDER BY ${FAULTS} OFFSET 0`)).toThrow();
  });

  /**
   * ⚠️ `OFFSET` WITH NO `LIMIT` MUST STILL DECLINE, and this is the control that says so. Item
   * 1062's note records `page-fold-fault.test.ts` catching the first cut of this arm admitting it:
   * with no cap the general path projects EVERY row and then drops the skipped ones, so the query
   * raises — while ranking-then-projecting would emit fewer rows than it projects and silently
   * return rows instead.
   */
  test('OFFSET past the faulting row still raises, so the arm has not claimed it', () => {
    const g = withFaultingRow();

    expect(() => query(g, `MATCH (n:T) RETURN ${FAULTS} AS x ORDER BY n.n + 1 OFFSET 1`)).toThrow();
  });

  /** And a LIMIT that excludes it must still NOT raise — the windowed arm, unchanged. */
  test('a LIMIT excluding the faulting row does not raise', () => {
    const g = withFaultingRow();
    const rows = query(
      g,
      `MATCH (n:T) RETURN ${FAULTS} AS x, n.n AS t ORDER BY n.n + 1 DESC LIMIT 2`,
    );

    expect(rows).toStrictEqual([
      { x: null, t: 3 },
      { x: null, t: 2 },
    ]);
  });
});

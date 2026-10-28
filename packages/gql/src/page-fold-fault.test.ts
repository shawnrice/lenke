import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { query } from './index.js';

// Item 1056: `foldPageIntoReturn` (item 969) rewrites `MATCH … ORDER BY k OFFSET n RETURN items`
// into `MATCH … RETURN items ORDER BY k OFFSET n`, justified because "a row-wise projection
// preserves row identity". True of the ORDER, and NOT of FAULTS: when the page DROPS rows, the
// unfolded form evaluates the projection only for survivors while the folded form evaluates it for
// every row and pages afterwards — so a row the `OFFSET` discarded can raise, and the query errors
// where it should have returned rows.
//
// Found by the differential fuzzer at `FUZZ_SEED=3076589914` (items 1054/1055): TS raised
// `E_INVALID_VALUE` where native returned five rows. CONFIRMED as this fold's doing by disabling
// it, which turned every real divergence into agreement.
//
// A STORED NaN is what makes the projection fault, and it cannot come from a literal: ingest
// coerces NaN and the infinities to null, so the only way into a property is to COMPUTE it with
// `SET`. That is also why the first bisect against the fixture's NDJSON could not reproduce the
// bug — the fixture is the file PLUS its setup statements.

/** One node with `nan` a STORED NaN and `nu` a number, so `nu * nan` is NaN and `true + NaN`
 *  raises; plus `extra` nodes that cannot fault, ordered after it by `n`. */
const withFaultingFirstRow = (extra: number): Graph => {
  const g = new Graph();

  g.addVertex({ id: 'bad', labels: ['T'], properties: { n: 0, nu: 5 } });

  for (let i = 1; i <= extra; i++) {
    // `nu` NULL, so `nu * nan` is null and `true + null` is null — these rows never fault.
    g.addVertex({ id: `ok${i}`, labels: ['T'], properties: { n: i, nu: null } });
  }

  // The stored NaN, on the faulting row only.
  query(g, 'MATCH (n:T) WHERE n.n = 0 SET n.nan = sin(1e400) RETURN count(*) AS c');

  return g;
};

const FAULTS = '(1 < 2) + (n.nu * n.nan)';

describe('a statement-position page must skip rows BEFORE the projection (item 1056)', () => {
  test('OFFSET past the only faulting row returns no rows rather than raising', () => {
    // THE MINIMAL REPRO. Native answered `[]` here and TS raised.
    const g = withFaultingFirstRow(0);

    expect(query(g, `MATCH (n:T) ORDER BY n.n OFFSET 1 RETURN ${FAULTS} AS x`)).toEqual([]);
  });

  test('OFFSET past it still projects the survivors', () => {
    const g = withFaultingFirstRow(3);
    const rows = query(g, `MATCH (n:T) ORDER BY n.n OFFSET 1 RETURN ${FAULTS} AS x, n.n AS t`);

    expect(rows).toEqual([
      { x: null, t: 1 },
      { x: null, t: 2 },
      { x: null, t: 3 },
    ]);
  });

  test('a LIMIT that excludes the faulting row likewise does not raise', () => {
    // `ORDER BY n.n DESC` puts the faulting row (n = 0) LAST, so `LIMIT 2` never reaches it.
    const g = withFaultingFirstRow(3);
    const rows = query(g, `MATCH (n:T) ORDER BY n.n DESC LIMIT 2 RETURN ${FAULTS} AS x, n.n AS t`);

    expect(rows).toEqual([
      { x: null, t: 3 },
      { x: null, t: 2 },
    ]);
  });

  describe('the controls — these must KEEP raising', () => {
    test('OFFSET 0 keeps the faulting row, so the query raises', () => {
      const g = withFaultingFirstRow(2);

      expect(() => query(g, `MATCH (n:T) ORDER BY n.n OFFSET 0 RETURN ${FAULTS} AS x`)).toThrow();
    });

    test('no page at all raises', () => {
      const g = withFaultingFirstRow(2);

      expect(() => query(g, `MATCH (n:T) RETURN ${FAULTS} AS x`)).toThrow();
    });

    test('CLAUSE position raises — there the projection genuinely precedes the paging', () => {
      // The arm that confirms the diagnosis from the other side, and the one a too-broad fix would
      // have broken: in `RETURN items ORDER BY … OFFSET n` the projection IS evaluated for every
      // row before paging, so raising is correct. Native raises here too.
      const g = withFaultingFirstRow(2);

      expect(() =>
        query(g, `MATCH (n:T) RETURN ${FAULTS} AS x, n.n AS t ORDER BY t OFFSET 1`),
      ).toThrow();
    });
  });

  test('the FOLD still applies when the projection cannot fault', () => {
    // Item 969's measured case. The refusal is narrow on BOTH conditions — a page that drops rows
    // AND a projection that can fault — so a plain property read still folds. Asserted on the
    // ANSWER here; the 3.72x itself is a perf claim, re-measured in the audit entry at 13.86 ms
    // against the clause form's 13.05.
    const g = withFaultingFirstRow(3);

    expect(query(g, 'MATCH (n:T) ORDER BY n.n OFFSET 1 RETURN n.n AS c')).toEqual([
      { c: 1 },
      { c: 2 },
      { c: 3 },
    ]);
  });
});

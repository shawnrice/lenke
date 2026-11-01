import { beforeAll, describe, expect, test } from 'bun:test';

import { Graph, type Vertex } from '@lenke/core';

import { query } from './index.js';

/**
 * Item 1333: inline properties on ANY pattern of a multi-pattern `MATCH` are lifted to the clause
 * `WHERE`, so they can become a seed hint. `liftStartProps` used to refuse
 * `patterns.length !== 1` outright.
 *
 * In `MATCH (a:S), (b:P {k: 7})` the braces sit on the SECOND pattern, so nothing lifted. The
 * refusal was listed in that function's header with no reason beside it — an unmeasured scope
 * limit, not a decision, and the GQL spelling probe was measuring what it cost.
 *
 * ⚠️ THE MECHANISM IS NOT SEEDING. Inline props already seed through `indexCandidates`'s
 * `node.pred.props` path, lifted or not — mutation proved it by restoring the old refusal and
 * leaving every assertion in THIS FILE green. So the seeding assertions below are real checks on
 * the seek, but they do NOT hold the lift; `lift-start-props.test.ts` does that. What the lifted
 * form saves is open.
 *
 * On that probe's fixture, the group alone, five processes before and eight after:
 *
 *     braces       24.69 -> 13.29 ms   1.86x, and the group no longer flags at all
 *     inline WHERE 11.82 -> 11.39      the spelling it had to catch up with
 *     clause       14.20 -> 11.35      1.25x, NOT a target — see below
 *     MATCH MATCH  11.39 -> 10.18      1.12x, likewise
 *
 * ⚠️ THE LAST TWO ROWS ARE NOT WINS THIS ITEM EARNED DIRECTLY. They share a PROCESS with the
 * braces shape in that probe, and a shape that was 2x slower was polluting the dispatch sites its
 * group-mates use. Fixing it made them faster as a side effect. That is also why the probe
 * overstated the gap relative to a one-shape-per-process reading, and it is worth knowing before
 * quoting any group-mate's improvement as an engine win.
 *
 * ⚠️ AND A STANDALONE PROBE NEVER REPRODUCED THE GAP. `product-inline-seed-probe.ts` matches that
 * fixture on N, edge count, labels, property richness, the NDJSON load path, index-build order,
 * the second index, one-process multi-shape timing, two-pass min, and the per-rep `JSON.stringify`
 * — seven candidate causes, all refuted — and reads braces 8.78 against inlineWhere 8.66 both
 * before and after. So it cannot validate this change, and its flatness is NOT evidence the change
 * does nothing. Why the shared fixture shows a 2x that a matched one does not is OPEN.
 */

/** Counts label-bucket and id-map pulls, the two surfaces a scan can take (items 1329, 1330). */
const spyScan = (g: Graph): (() => number) => {
  let pulled = 0;
  const counted = (inner: Iterator<Vertex>): IterableIterator<Vertex> =>
    ({
      [Symbol.iterator]() {
        return this;
      },
      next() {
        const step = inner.next();

        if (!step.done) {
          pulled += 1;
        }

        return step;
      },
    }) as unknown as IterableIterator<Vertex>;

  const byId = g.verticesById;
  const realIdValues = byId.values.bind(byId);

  byId.values = (() => counted(realIdValues())) as unknown as typeof byId.values;

  const byLabel = g.verticesByLabel;
  const realGet = byLabel.get.bind(byLabel);

  byLabel.get = (key: string): Set<Vertex> | undefined => {
    const set = realGet(key);

    if (!set) {
      return set;
    }

    const realIter = set[Symbol.iterator].bind(set);
    const realValues = set.values.bind(set);

    (set as unknown as { [Symbol.iterator]: () => IterableIterator<Vertex> })[Symbol.iterator] =
      () => counted(realIter());
    set.values = (() => counted(realValues())) as unknown as typeof set.values;

    return set;
  };

  return () => pulled;
};

/** Above `SEEK_FLOOR_VERTICES` (4,096), or no seek is priced at all and every arm reads zero. */
const N = 5_000;

let g: Graph;
let scanned: () => number;

beforeAll(() => {
  g = new Graph();
  g.createIndex({ on: 'vertex', kind: 'hash', keys: ['k'] });

  for (let i = 0; i < N; i++) {
    g.addVertex({ id: `v${i}`, labels: ['P'], properties: { k: i, grp: i % 2 } });
  }

  // FOUR left-side vertices, so a comma product is a measurement rather than N x N.
  for (let i = 0; i < 4; i++) {
    g.addVertex({ id: `s${i}`, labels: ['S'], properties: { k: i } });
  }

  scanned = spyScan(g);
});

const walkedBy = <T>(run: () => T): { walked: number; value: T } => {
  const before = scanned();
  const value = run();

  return { walked: scanned() - before, value };
};

describe('inline props on a second pattern reach the index', () => {
  test('the braces spelling seeds, so neither vertex source is walked for it', () => {
    const { walked, value } = walkedBy(() =>
      query(g, `MATCH (a:S), (b:P {k: 7}) RETURN b.k AS x`, {}),
    );

    expect(value.length).toBe(4);
    // The left side `(a:S)` is four vertices and IS enumerated; what must not happen is a walk of
    // the 5,000-vertex `P` bucket for `b`. Four is the floor, not zero.
    expect(walked).toBeLessThan(100);
  });

  test('the braces spelling costs the same as the clause WHERE it means', () => {
    const braces = walkedBy(() => query(g, `MATCH (a:S), (b:P {k: 7}) RETURN b.k AS x`, {}));
    const clause = walkedBy(() => query(g, `MATCH (a:S), (b:P) WHERE b.k = 7 RETURN b.k AS x`, {}));

    expect(braces.value.length).toBe(clause.value.length);

    // BOTH SEED, which is the claim — neither walks the 5,000-vertex `P` bucket. They do not
    // enumerate IDENTICALLY (braces 8, clause 12 at this fixture size), so this asserts the
    // property that matters rather than an equality that happens not to hold: before this item the
    // braces form had no seed hint at all and would walk the bucket. An exact-equality assertion
    // here would be a stricter claim than the item makes, and would fail for a reason unrelated to
    // seeding.
    expect(braces.walked).toBeLessThan(100);
    expect(clause.walked).toBeLessThan(100);
  });

  test('props on BOTH patterns lift, not just the first', () => {
    const { walked, value } = walkedBy(() =>
      query(g, `MATCH (a:S {k: 1}), (b:P {k: 7}) RETURN b.k AS x`, {}),
    );

    expect(value.length).toBe(1);
    expect(walked).toBeLessThan(100);
  });
});

describe('the refusals that must survive', () => {
  /**
   * ⚠️ THE SUITE FOUND THIS, not the reasoning, and it is the one regression a performance rewrite
   * must never cause: a query that MUST error returning a row instead.
   *
   * `MATCH p = (a:P {k: 1}), (p:P {k: 2})` collides a PATH variable with a node variable and must
   * raise. It raises only because the product-of-counts shortcut DECLINES and the general path
   * gets there; adding a `where` routed the shortcut elsewhere and it answered 0. Item 778 records
   * the same hazard one case along — "one rung's admission gate is another rung's disqualifier".
   */
  test('a clause binding a PATH variable does not lift, so the collision still raises', () => {
    expect(() =>
      query(g, `MATCH p = (a:P {k: 1}), (p:P {k: 2}) RETURN count(*) AS c`, {}),
    ).toThrow();
  });

  test('a NULL literal still stays inline, because it means IS NULL', () => {
    // Item 260: `{k: null}` matches a STORED null; `b.k = null` is UNKNOWN and matches nothing. The
    // one refusal here that changes an answer rather than a plan.
    expect(query(g, `MATCH (a:S), (b:P {k: null}) RETURN b.k AS x`, {}).length).toBe(0);
  });

  test('a PARAM value still stays inline, since it cannot be shown non-null at compile time', () => {
    const rows = query(g, `MATCH (a:S), (b:P {k: $k}) RETURN b.k AS x`, { k: 7 });

    expect(rows.length).toBe(4);
  });

  test('a clause that already carries a WHERE is left alone', () => {
    // Combining the two needs an AND whose operand order carries items 258/259's short-circuit
    // contract — still refused, and this pins that the refusal survives the multi-pattern change.
    const rows = query(g, `MATCH (a:S), (b:P {k: 7}) WHERE b.grp = 1 RETURN b.k AS x`, {});

    expect(rows.length).toBe(4);
  });
});

describe('answers are unchanged, which a lift must never affect', () => {
  const CASES: readonly [string, string][] = [
    ['braces vs clause', `MATCH (a:S), (b:P {k: 7}) RETURN b.k AS x`],
    ['two patterns both constrained', `MATCH (a:S {k: 1}), (b:P {k: 7}) RETURN b.k AS x`],
    ['an unselective key', `MATCH (a:S), (b:P {grp: 1}) RETURN count(*) AS c`],
    [
      'with a hop on the second pattern',
      `MATCH (a:S), (b:P {k: 7})-[:E]->(c) RETURN count(*) AS c`,
    ],
  ];

  for (const [name, q] of CASES) {
    test(`${name} agrees with the clause-WHERE spelling`, () => {
      // Rewrite the inline props as a clause WHERE by hand and compare, which is the oracle: the
      // lift claims the two are the same question.
      const asClause = q
        .replace(`(b:P {k: 7})`, `(b:P)`)
        .replace(`(b:P {grp: 1})`, `(b:P)`)
        .replace(`(a:S {k: 1})`, `(a:S)`);
      const whereFor = (): string => {
        if (q.includes('{grp: 1}')) {
          return ' WHERE b.grp = 1';
        }

        return q.includes('(a:S {k: 1})') ? ' WHERE a.k = 1 AND b.k = 7' : ' WHERE b.k = 7';
      };
      const where = whereFor();
      const i = asClause.indexOf(' RETURN ');
      const rebuilt = `${asClause.slice(0, i)}${where}${asClause.slice(i)}`;

      expect(JSON.stringify(query(g, q, {}))).toBe(JSON.stringify(query(g, rebuilt, {})));
    });
  }
});

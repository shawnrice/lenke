import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';

import { compilePredicate } from './executor/core.js';
import { indexCandidates } from './executor/matching.js';
import { query } from './index.js';

/**
 * ⚠️ ITEM 1605 — A WRONG ANSWER: an index on a key made `{k: null}` UNDER-COUNT, by exactly the
 * vertices that lack the key.
 *
 * `indexCandidates` seeds from `node.pred.props` — the INLINE constraint — and `isScalar` admits
 * `null`, so a null-valued inline property seeded from the index's null bucket. But the two
 * equality readings differ precisely there:
 *
 * ```text
 *    {k: null}         matches a stored null AND an ABSENT key   (item 260, and `satisfies`)
 *    WHERE n.k = null  matches NEITHER
 * ```
 *
 * A value bucket can hold the stored nulls. It cannot hold the vertices with no such key, and no
 * re-validation can add them back — a seed is only ever NARROWED. On a fixture with 10 stored
 * nulls, 10 absent and 20 valued:
 *
 * ```text
 *    MATCH (u:P {note: null}) RETURN count(*)    unindexed 20    indexed 10
 *    MATCH (u:P) WHERE u.note IS NULL            unindexed 20    indexed 20
 * ```
 *
 * Twenty is right: the unindexed path, the `IS NULL` spelling and `satisfies`'s own `props` loop all
 * agree, and `IS NULL` canonicalizes TO `{k: null}`. The indexed path silently dropped ten rows.
 *
 * ⚠️ HOW IT HID. Every probe this session used a non-null `$param`, and the one contract that would
 * have caught it — item 149's "an index may change the COST and must never change the COUNT" — is
 * asserted by `gql-seek-revalidation-probe.mjs` on exactly the shapes it measures, none of which is
 * null-valued. The whole suite was green. It surfaced only because item 1605 went looking at what
 * `isScalar` admits before threading an exactness flag through the same loop.
 */
const build = (indexed: boolean): Graph => {
  const g = new Graph();

  for (let i = 0; i < 40; i += 1) {
    const properties: Record<string, unknown> = { k: i % 4 };

    if (i % 4 === 0) {
      properties.note = null; // 10 STORED nulls
    } else if (i % 4 !== 1) {
      properties.note = `x${i}`; // 20 with a value
    }
    // i % 4 === 1 leaves `note` ABSENT — the 10 the bucket cannot hold

    g.addVertex({ id: `u${i}`, labels: ['P'], properties });
  }

  if (indexed) {
    g.createIndex({ on: 'vertex', kind: 'hash', keys: ['note'] });
    g.createIndex({ on: 'vertex', kind: 'hash', keys: ['k'] });
  }

  return g;
};

const plain = build(false);
const indexed = build(true);

describe('an index must change the COST and never the COUNT', () => {
  const SHAPES: readonly [string, string, Record<string, unknown>][] = [
    ['inline literal null', 'MATCH (u:P {note: null}) RETURN count(*) AS c', {}],
    ['inline param null', 'MATCH (u:P {note: $v}) RETURN count(*) AS c', { v: null }],
    ['inline null, ROWS', 'MATCH (u:P {note: null}) RETURN u.k AS k', {}],
    ['inline null + a second key', 'MATCH (u:P {k: 1, note: null}) RETURN count(*) AS c', {}],
    [
      'clause = null matches NEITHER',
      'MATCH (u:P) WHERE u.note = $v RETURN count(*) AS c',
      { v: null },
    ],
    ['IS NULL', 'MATCH (u:P) WHERE u.note IS NULL RETURN count(*) AS c', {}],
    ['IS NOT NULL', 'MATCH (u:P) WHERE u.note IS NOT NULL RETURN count(*) AS c', {}],
    // The non-null controls: these DO seek, and must keep answering the same thing.
    ['inline value', 'MATCH (u:P {note: "x6"}) RETURN count(*) AS c', {}],
    ['inline numeric', 'MATCH (u:P {k: 2}) RETURN count(*) AS c', {}],
    ['clause value', 'MATCH (u:P) WHERE u.note = $v RETURN count(*) AS c', { v: 'x6' }],
  ];

  for (const [name, text, params] of SHAPES) {
    test(name, () => {
      expect(JSON.stringify(query(indexed, text, params))).toBe(
        JSON.stringify(query(plain, text, params)),
      );
    });
  }

  test('and on the right NUMBERS, which agreement alone cannot show', () => {
    /**
     * ⚠️ TWO WRONG PATHS AGREEING IS STILL WRONG — items 1581/1596 both shipped a normalizer whose
     * comparison passed while both sides were wrong. These literals come from the fixture: 10
     * stored nulls, 10 absent, 20 valued.
     */
    const c = (g: Graph, text: string, params: Record<string, unknown> = {}): number =>
      Number(query(g, text, params)[0]?.c);

    for (const g of [plain, indexed]) {
      expect(c(g, 'MATCH (u:P {note: null}) RETURN count(*) AS c')).toBe(20);
      expect(c(g, 'MATCH (u:P) WHERE u.note IS NULL RETURN count(*) AS c')).toBe(20);
      expect(c(g, 'MATCH (u:P) WHERE u.note IS NOT NULL RETURN count(*) AS c')).toBe(20);
      expect(c(g, 'MATCH (u:P) WHERE u.note = $v RETURN count(*) AS c', { v: null })).toBe(0);
      expect(c(g, 'MATCH (u:P {note: "x6"}) RETURN count(*) AS c')).toBe(1);
      expect(c(g, 'MATCH (u:P {k: 2}) RETURN count(*) AS c')).toBe(10);
    }
  });
});

describe('the fix declines the seek rather than disabling seeding', () => {
  /**
   * The route assertion, so "no wrong answer" is not achieved by never seeking at all. `{k: null}`
   * must yield NO candidate — the matching set is not a value bucket — while a non-null value must
   * still yield one.
   */
  const candidatesFor = (props: { key: string; value: unknown }[]): number => {
    const pred = compilePredicate(
      props.map((p) => ({ key: p.key, value: { kind: 'lit' as const, value: p.value } })),
      undefined,
      'u',
    );
    const node = { variable: 'u', pred, seedHints: [] } as unknown as Parameters<
      typeof indexCandidates
    >[1];

    return [...indexCandidates(indexed, node, { binding: new Map(), params: {}, graph: indexed })]
      .length;
  };

  test('a NULL inline value yields no candidate', () => {
    expect(candidatesFor([{ key: 'note', value: null }])).toBe(0);
  });

  test('a non-null inline value still yields one', () => {
    expect(candidatesFor([{ key: 'note', value: 'x6' }])).toBe(1);
    expect(candidatesFor([{ key: 'k', value: 2 }])).toBe(1);
  });

  test('a pair yields one per indexed non-null key, and the null one is simply absent', () => {
    expect(
      candidatesFor([
        { key: 'k', value: 1 },
        { key: 'note', value: 'x6' },
      ]),
    ).toBe(2);
    expect(
      candidatesFor([
        { key: 'k', value: 1 },
        { key: 'note', value: null },
      ]),
    ).toBe(1);
  });

  test('an UNINDEXED key yields none either way, so the gate is the index and not the null', () => {
    expect(candidatesFor([{ key: 'nosuch', value: 'x' }])).toBe(0);
    expect(candidatesFor([{ key: 'nosuch', value: null }])).toBe(0);
  });
});

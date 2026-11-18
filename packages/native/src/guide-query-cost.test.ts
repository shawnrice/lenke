/**
 * ⚠️⚠️ **EVERY SNIPPET IN `docs/guides/query-cost.md` RUNS HERE (item 2278).** The guide was written at item
 * 2277 from measurements, but its code was TYPED, not executed — and a guide whose snippets do not run is
 * worse than no guide, because a reader trusts it.
 *
 * 🔑 These are the guide's four snippets, verbatim in shape, with their ANSWERS asserted — not just that
 * they parse. Two of them were genuinely uncertain when written:
 *
 * - the keyset snippet compares STRINGS with `>`, and cross-type comparison in this engine has rules
 *   (a string against a temporal raises);
 * - the Gremlin snippet filters a DATE with `gte(...)`, and stored temporals have their own handling.
 *
 * ⚠️ This is a TEST, not a probe, so the guide cannot rot: if a snippet stops working, this fails.
 */
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';
import { V, count, gte, has, hasLabel, toArray, traversal } from '@lenke/gremlin';

const SURNAMES = ['Adler', 'Boyd', 'Boyd', 'Cardoso', 'Devi', 'Eze'] as const;

const build = (): Graph => {
  const g = new Graph();

  for (const [i, surname] of SURNAMES.entries()) {
    g.addVertex({
      id: `p${i}`,
      labels: ['Person'],
      properties: {
        surname,
        name: `n${i}`,
        team: i % 2 === 0 ? 'core' : 'platform',
        startedAt: 2020 + i,
      },
    });
  }

  return g;
};

describe('docs/guides/query-cost.md snippets', () => {
  test('one query returning every row — the "fetch once" shape', () => {
    const rows = query(build(), 'MATCH (p:Person) RETURN p.surname AS s ORDER BY s', {});

    expect(rows.map((r) => r.s)).toStrictEqual([...SURNAMES].sort());
  });

  test('offset paging: `OFFSET $s` is accepted and `SKIP $s` is a SYNTAX ERROR, though they are ISO synonyms', () => {
    const g = build();

    /*
     * ⚠️⚠️ **THIS TEST FOUND A PARSER INCONSISTENCY (item 2278).** `SKIP` and `OFFSET` are synonyms in
     * ISO-GQL, and the parser's own error message says "after SKIP/OFFSET" — yet a PARAMETER is accepted
     * after `OFFSET` and refused after `SKIP`. It matters because a paging caller who cannot bind the
     * offset must interpolate it, making every page a distinct query text and defeating the parse cache.
     */
    expect(() =>
      query(g, 'MATCH (p:Person) RETURN p.surname AS s ORDER BY s SKIP $skip LIMIT 2', { skip: 2 }),
    ).toThrow(/non-negative integer after SKIP/);

    const page = (skip: number): unknown[] =>
      query(g, 'MATCH (p:Person) RETURN p.surname AS s ORDER BY s OFFSET $skip LIMIT 2', {
        skip,
      }).map((r) => r.s);

    expect(page(0)).toStrictEqual(['Adler', 'Boyd']);
    expect(page(2)).toStrictEqual(['Boyd', 'Cardoso']);
    expect(page(4)).toStrictEqual(['Devi', 'Eze']);
  });

  test('keyset paging on a STRING key resumes correctly — and SKIPS TIES, which is why the guide says to add a tiebreak', () => {
    const g = build();
    const after = (last: string): unknown[] =>
      query(
        g,
        'MATCH (p:Person) WHERE p.surname > $lastSurname RETURN p.surname AS s ORDER BY s LIMIT 2',
        { lastSurname: last },
      ).map((r) => r.s);

    /* The string comparison works, which was the uncertain part. */
    expect(after('')).toStrictEqual(['Adler', 'Boyd']);

    /*
     * ⚠️ AND HERE IS THE TIE LOSS THE GUIDE WARNS ABOUT, PINNED: resuming after the FIRST 'Boyd' skips the
     * SECOND one, because `>` excludes everything equal to the cursor. The guide's advice to order by the
     * key plus a unique column is what this test exists to justify.
     */
    expect(after('Boyd')).toStrictEqual(['Cardoso', 'Devi']);
    expect(SURNAMES.filter((s) => s === 'Boyd')).toHaveLength(2);
  });

  test('a named projection and the element projection return different shapes', () => {
    const g = build();
    const named = query(g, 'MATCH (p:Person) WHERE p.surname = $s RETURN p.name AS name', {
      s: 'Adler',
    });
    const element = query(g, 'MATCH (p:Person) WHERE p.surname = $s RETURN p AS p', { s: 'Adler' });

    expect(named).toStrictEqual([{ name: 'n0' }]);
    expect(Object.keys(element[0] ?? {})).toStrictEqual(['p']);

    /*
     * ⚠️ The element form returns the LIVE element, whose properties live under `.properties` — not as
     * direct fields. My first expectation read `.surname` off it and got `undefined`; the
     * `{id, labels, properties}` map the guide prices at 4.1x is what a serializer builds FROM it.
     */
    const el = element[0]?.p as { properties: Record<string, unknown> };

    expect(el.properties.surname).toBe('Adler');
  });

  test('a bound parameter serves every value — one cache entry, many callers', () => {
    const g = build();
    const byTeam = (team: string): number =>
      query(g, 'MATCH (p:Person) WHERE p.team = $team RETURN p.name AS name', { team }).length;

    expect(byTeam('core')).toBe(3);
    expect(byTeam('platform')).toBe(3);
  });

  test('the hoisted Gremlin traversal runs and counts', () => {
    const g = build();
    /* Built once, as the guide shows — then called. `gte` is a predicate FUNCTION, not an object literal. */
    const recentHires = traversal(V(), hasLabel('Person'), has('startedAt', gte(2023)), count());

    expect(Number(toArray(recentHires, g)[0])).toBe(3);
    /* Called twice, because the guide's point is reuse across requests. */
    expect(Number(toArray(recentHires, g)[0])).toBe(3);
  });
});

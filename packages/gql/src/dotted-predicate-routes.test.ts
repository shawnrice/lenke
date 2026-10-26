import { describe, expect, it } from 'bun:test';

/**
 * A DOTTED predicate (`p.meta.city = 'NYC'`) filters correctly through every route that carries a
 * node predicate.
 *
 * This is the fixture item 901 found missing. Items 900/901 attempted to lift a dotted conjunct
 * into a fourth element-direct list (`pathProps`) beside `eqProps`/`cmpProps`/`truthProps`, and the
 * attempt **passed all 2,711 GQL tests while being latently wrong**. The reason is worth stating,
 * because it is what these tests exist to prevent:
 *
 * `compilePredicate` computes `generic = direct === null ? where : direct.residual`, and `residual`
 * is always `undefined` — so a successful lift EMPTIES `where`. A lifted list is therefore the ONLY
 * remaining carrier of that conjunct, not a shortcut beside the general evaluator. There are at
 * least five consumers that must know about it (`matchesPredicate`, `rejectedByElementDirect`, two
 * `preFilter` gates in `matching.ts`, and `shortcuts.ts`' `InlinePred`), none discoverable from the
 * list's own definition — and a consumer that misses it returns a silent SUPERSET.
 *
 * No existing fixture combined a dotted conjunct with the routes that would expose that, so the
 * suite could not see it. These do. Each case names the route it exercises; a future lift that
 * wires some consumers and not others fails here instead of shipping.
 *
 * The expectations are the answers the engine gives TODAY, with the dotted predicate going through
 * the general evaluator — which is the behaviour any optimization has to preserve.
 */
import { Graph } from '@lenke/core';

import { query } from './index.ts';

const CITIES = ['NYC', 'LDN'];

/**
 * Eight `:P` vertices, alternating city, each carrying the value THREE ways — a flat `tag`, a
 * one-level `meta.city`, and a two-level `meta.deep.z` — plus a chain of `:R` edges so the far-node
 * route has something to walk. Alternating (not uniform) so a dropped predicate shows up as a
 * doubled count rather than as the same answer.
 */
const g = new Graph();

for (let i = 0; i < 8; i += 1) {
  const city = CITIES[i % 2];

  g.addVertex({
    id: `v${i}`,
    labels: ['P'],
    properties: { n: i, tag: city, meta: { city, deep: { z: city } } },
  });
}

for (let i = 0; i < 7; i += 1) {
  g.addEdge({
    id: `e${i}`,
    labels: ['R'],
    from: g.getVertexById(`v${i}`) as never,
    to: g.getVertexById(`v${i + 1}`) as never,
  });
}

const count = (q: string): number =>
  Number((([...query(g, q)][0] ?? {}) as Record<string, unknown>).c ?? -1);

describe('a dotted predicate filters through every predicate route', () => {
  // THE COUNT SHORTCUT. `shortcuts.ts` builds its OWN CPredicate for a filtered count and its
  // `InlinePred` contract knows three carriers; this is the route the 900 attempt actually ran
  // through, and the one whose un-wired state a superset would have come from.
  it('clause WHERE + count(*) — the count shortcut', () => {
    expect(count("MATCH (p:P) WHERE p.meta.city = 'NYC' RETURN count(*) AS c")).toBe(4);
  });

  it('inline WHERE + count(*) — the inline-predicate route', () => {
    expect(count("MATCH (p:P WHERE p.meta.city = 'NYC') RETURN count(*) AS c")).toBe(4);
  });

  // A PROJECTION rather than a count, so the rows themselves are checked and not just a tally —
  // a dropped predicate shows up as extra rows, which is the superset shape exactly.
  it('clause WHERE + projection — the rows, not a tally', () => {
    expect([
      ...query(g, "MATCH (p:P) WHERE p.meta.city = 'NYC' RETURN p.n AS c ORDER BY c"),
    ]).toEqual([{ c: 0 }, { c: 2 }, { c: 4 }, { c: 6 }]);
  });

  // AND-CHAINS IN BOTH ORDERS. `directEqProps` declines the WHOLE chain on the first conjunct it
  // cannot admit, so a mixed chain is where a partial lift would go wrong — and the order matters
  // because the dotted conjunct can be the first or a later one.
  it('AND: flat conjunct then dotted', () => {
    expect(
      count("MATCH (p:P) WHERE p.tag = 'NYC' AND p.meta.city = 'NYC' RETURN count(*) AS c"),
    ).toBe(4);
  });

  it('AND: dotted conjunct then an ordering comparison', () => {
    expect(count("MATCH (p:P) WHERE p.meta.city = 'NYC' AND p.n > 2 RETURN count(*) AS c")).toBe(2);
  });

  it('a THREE-segment path', () => {
    expect(count("MATCH (p:P) WHERE p.meta.deep.z = 'NYC' RETURN count(*) AS c")).toBe(4);
  });

  // THE FAR NODE OF A HOP, which is `hop-projection`'s merge route — the one whose `mergeFarPreds`
  // must carry every list or the far predicate is silently dropped.
  it('the FAR node of a hop', () => {
    expect(count("MATCH (a:P)-[:R]->(b:P) WHERE b.meta.city = 'NYC' RETURN count(*) AS c")).toBe(3);
  });

  // BOTH OPERAND ORDERS — the equivalent-spelling rule this engine is named for: accepting one
  // and scanning for the other is the whole bug class.
  it('the flipped operand order', () => {
    expect(count("MATCH (p:P) WHERE 'NYC' = p.meta.city RETURN count(*) AS c")).toBe(4);
  });

  it('an ORDERING comparison on a dotted path', () => {
    expect(count("MATCH (p:P) WHERE p.meta.city > 'LDN' RETURN count(*) AS c")).toBe(4);
  });

  // THE NULL CASES. An absent final segment and an absent BASE both make the comparison UNKNOWN,
  // and a FILTER keeps only TRUE — so both match nothing. A lift that read these wrong would
  // return everything, which is the superset again.
  it('an absent final segment matches nothing', () => {
    expect(count("MATCH (p:P) WHERE p.meta.nope = 'NYC' RETURN count(*) AS c")).toBe(0);
  });

  it('an absent BASE property matches nothing', () => {
    expect(count("MATCH (p:P) WHERE p.none.city = 'NYC' RETURN count(*) AS c")).toBe(0);
  });

  // And the control that makes the counts above meaningful: without the predicate every route
  // returns all eight, so a "4" is a filter that ran and not a coincidence of the fixture.
  it('CONTROL: no predicate returns all eight', () => {
    expect(count('MATCH (p:P) RETURN count(*) AS c')).toBe(8);
    expect(count('MATCH (a:P)-[:R]->(b:P) RETURN count(*) AS c')).toBe(7);
  });
});

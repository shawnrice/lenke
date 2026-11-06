/**
 * `V()[…filters] out(T) …filters out(U) .count()` — a filter BETWEEN two hops, which reached NONE
 * of `countShortcut`'s rungs and fell to the traverser pipeline at **62x** (item 1602).
 *
 * ⚠️ EVERY EXPECTATION HERE IS A HAND COUNT OVER THE FIXTURE, not a recording from the engine, and
 * for this rung that matters twice over. The shape previously declined to the pipeline, so nothing
 * in the suite covered it — and the first oracle written for it was `toArray(plan, graph)`, which
 * CALLS `countShortcut` and therefore agreed with the rung by construction. An oracle written by
 * the same hand can share the same bug (CLAUDE.md); the numbers below were counted from the table.
 *
 * The fixture is built to be discriminating rather than representative. `>` is an `E` edge and `~`
 * an `F` edge:
 *
 * ```text
 *   a  [User]        team=t1  >b  >c  ~d      two E edges and one of another TYPE
 *   b  [User]        team=t1  >c              on the path a->b->c
 *   c  [Admin]       team=t2  >c              a SELF-LOOP: arrives at itself and departs
 *   d  [User,Admin]  team=t1  >a  >b          TWO labels, so `hasLabel` is not a partition
 *   e  [User]        team=t2                  no adjacency at all
 *   f  [Admin]       (no team)  >a            a MISSING property, which `has` must reject
 * ```
 */
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';
import type { Vertex } from '@lenke/core';

import { V, Scope, both, count, eq, gt, has, hasLabel, in_, out, traversal } from '../index.js';
import type { Plan } from '../index.js';
import { countShortcut } from './count-shortcut.js';

type Row = { id: string; labels: string[]; team?: string; out: [string, string][] };

const TABLE: readonly Row[] = [
  {
    id: 'a',
    labels: ['User'],
    team: 't1',
    out: [
      ['b', 'E'],
      ['c', 'E'],
      ['d', 'F'],
    ],
  },
  { id: 'b', labels: ['User'], team: 't1', out: [['c', 'E']] },
  { id: 'c', labels: ['Admin'], team: 't2', out: [['c', 'E']] },
  {
    id: 'd',
    labels: ['User', 'Admin'],
    team: 't1',
    out: [
      ['a', 'E'],
      ['b', 'E'],
    ],
  },
  { id: 'e', labels: ['User'], team: 't2', out: [] },
  { id: 'f', labels: ['Admin'], out: [['a', 'E']] },
];

const build = (indexed = false): Graph => {
  const g = new Graph();

  for (const r of TABLE) {
    const properties: Record<string, unknown> = {};

    if (r.team !== undefined) {
      properties.team = r.team;
    }

    g.addVertex({ id: r.id, labels: [...r.labels], properties });
  }

  let n = 0;

  for (const r of TABLE) {
    for (const [to, label] of r.out) {
      g.addEdge({
        id: `e${n++}`,
        from: g.getVertexById(r.id) as Vertex,
        to: g.getVertexById(to) as Vertex,
        labels: [label],
        properties: {},
      });
    }
  }

  if (indexed) {
    g.createIndex({ on: 'vertex', kind: 'hash', keys: ['team'] });
  }

  return g;
};

const g = build();
const answered = (plan: Plan): number | undefined => countShortcut(plan, g);

describe('the rung answers a filter between two hops', () => {
  test('a leading hasLabel and an interior has', () => {
    /**
     * `V().hasLabel(User).out(E).has(team, t1).out(E).count()`
     *
     * User starts: a, b, d, e. Their E-targets, with the interior `team = t1` test:
     *   a -> b (t1 PASS, b has 1 E out) and c (t2 fail); a's ~d is an F edge, not traversed
     *   b -> c (fail)
     *   d -> a (t1 PASS, a has 2 E out) and b (t1 PASS, 1 E out)
     *   e -> nothing
     * so 1 + 2 + 1 = 4.
     */
    expect(
      answered(
        traversal(V(), hasLabel('User'), out('E'), has('team', eq('t1')), out('E'), count()),
      ),
    ).toBe(4);
  });

  test('NO leading filter — the arrivals arm that reads a degree instead of walking', () => {
    /**
     * `V().out(E).has(team, t1).out(E).count()` — every vertex is a start, so arrivals at a middle
     * is just its E in-degree. Middles with team = t1 are a, b, d.
     *   a: E in-edges from d and f  -> 2 arrivals, a departs 2  -> 4
     *   b: E in-edges from a and d  -> 2 arrivals, b departs 1  -> 2
     *   d: E in-edges none (a->d is F) -> 0
     * so 6.
     */
    expect(answered(traversal(V(), out('E'), has('team', eq('t1')), out('E'), count()))).toBe(6);
  });

  test('an interior hasLabel, which seeds the middle from its bucket', () => {
    /**
     * `V().out(E).hasLabel(Admin).out(E).count()` — Admin middles are c, d and f.
     *   c: E in-edges from a, from b, and its own SELF-LOOP -> 3 arrivals, c departs 1 -> 3
     *   d: E in-edges none (a->d is an F edge) -> 0
     *   f: E in-edges none -> 0
     * so 3. ⚠️ The self-loop is the discriminating row: it is one of c's in-edges AND one of its
     * out-edges, and it must be counted in both roles exactly as enumeration walks it.
     *
     * ⚠️ MY FIRST GUESS HERE WAS 2 — I read c's in-edges as a plus the loop and forgot b->c. SIX
     * of this file's literals were wrong on the first run and the ENGINE was right every time;
     * they were re-derived by a hand count over the table with no engine involved. Item 1596's
     * lesson: a comparison proves two paths agree, only a literal proves they agree on the right
     * number — and only careful counting makes the literal worth anything.
     */
    expect(answered(traversal(V(), out('E'), hasLabel('Admin'), out('E'), count()))).toBe(3);
  });

  test('a leading has, which must be applied to the ARRIVING edge and not folded away', () => {
    /**
     * `V().has(team, t2).out(E).has(team, t1).out(E).count()` — starts with team = t2 are c and e.
     *   c -> c (self-loop; c is t2, fails the interior t1)
     *   e -> nothing
     * so 0. The control below proves the 0 is the leading filter and not an empty shape.
     */
    expect(
      answered(
        traversal(V(), has('team', eq('t2')), out('E'), has('team', eq('t1')), out('E'), count()),
      ),
    ).toBe(0);
    expect(
      answered(
        traversal(V(), has('team', eq('t1')), out('E'), has('team', eq('t1')), out('E'), count()),
      ),
    ).toBe(4);
  });

  test('TWO interior filters', () => {
    // `V().out(E).hasLabel(User).has(team, t1).out(E).count()` — middles that are User AND t1 are
    // a, b, d. Same arrivals as the no-lead case above: 4 + 2 + 0 = 6.
    expect(
      answered(
        traversal(V(), out('E'), hasLabel('User'), has('team', eq('t1')), out('E'), count()),
      ),
    ).toBe(6);
  });

  test('a MISSING property is rejected, not treated as a match', () => {
    // `f` has no `team`. `V().out(E).has(team, t2).out(E).count()`: t2 middles are c and e.
    //   c: 3 arrivals (from a, from b, and its self-loop), departs 1 -> 3
    //   e: no in-edges -> 0
    // so 3 — and `f`, which has no team at all, contributes nothing as a middle, which is the row
    // this case exists for.
    expect(answered(traversal(V(), out('E'), has('team', eq('t2')), out('E'), count()))).toBe(3);
  });

  test('an `in` hop on either side', () => {
    /**
     * `V().in(E).has(team, t1).out(E).count()` — an `in` first hop ARRIVES at a middle along the
     * middle's OUT-edges, which is the mirror the arrivals arm has to get right.
     * t1 middles are a, b, d; every vertex is a start, so arrivals = the middle's E OUT-degree.
     *   a: departs(out E) 2, arrivals(out E) 2 -> 4
     *   b: 1 and 1 -> 1
     *   d: 2 and 2 -> 4
     * so 9.
     */
    expect(answered(traversal(V(), in_('E'), has('team', eq('t1')), out('E'), count()))).toBe(9);
  });

  test('an interior seekable `has` is answered even with the index present', () => {
    /**
     * ⚠️ THE ASYMMETRY THE RUNG DOCUMENTS. A seekable LEADING `has` is refused, because
     * `countShortcut` runs before `seedFromIndex` and a tally that scanned would preempt the seek.
     * An INTERIOR one is not, because a seek seeds the SOURCE and no route seeds from the middle of
     * a walk — refusing it would decline the shape on every indexed graph and gain nothing.
     */
    const indexed = build(true);
    const plan = traversal(V(), out('E'), has('team', eq('t1')), out('E'), count());

    expect(countShortcut(plan, indexed)).toBe(6);

    // And the leading twin IS refused on the same indexed graph, which is what makes the asymmetry
    // deliberate rather than an accident of where the check sits.
    expect(
      countShortcut(
        traversal(V(), has('team', eq('t1')), out('E'), hasLabel('User'), out('E'), count()),
        indexed,
      ),
    ).toBeUndefined();
  });
});

describe('the rung declines what it must', () => {
  test('⚠️ a filter AFTER the last hop is now ANSWERED — by item 1612, not by this rung', () => {
    /**
     * ⚠️ THIS TEST USED TO ASSERT A DECLINE, and the change is deliberate. This item left the shape
     * open with the reason "the final contribution stops being a degree, so it needs the last level
     * walked" — and item 1612 walked it, far-driven, at **214x** on the two-hop form and 36.8x on
     * this one. `countShortcut` therefore answers it now, through
     * `trailingFilteredHopChainCount`.
     *
     * What this rung does is unchanged: `interleavedHopChainCount` still requires the LAST step to
     * BE the hop and still declines this shape, which is what keeps the two disjoint. The
     * expectation that moved is about the CHAIN, which is what `answered` calls.
     *
     * Hand-derived: paths `x -> mid -> far` with both teams `t1` are `d -> a -> b` and `f -> a -> b`.
     */
    expect(
      answered(
        traversal(V(), out('E'), has('team', eq('t1')), out('E'), has('team', eq('t1')), count()),
      ),
    ).toBe(2);
  });

  test('a `both` hop on either side', () => {
    expect(
      answered(traversal(V(), both('E'), has('team', eq('t1')), out('E'), count())),
    ).toBeUndefined();
    expect(
      answered(traversal(V(), out('E'), has('team', eq('t1')), both('E'), count())),
    ).toBeUndefined();
  });

  test('a step that is not a vertex filter between the hops', () => {
    expect(
      answered(traversal(V(), out('E'), has('team', eq('t1')), out('E'), out('E'), count())),
    ).toBeUndefined();
  });

  test('a MULTI-TYPE graph with an untyped hop', () => {
    /**
     * ⚠️ `degreeOfTypes` sums the per-type buckets, which is a degree only when the wanted set is
     * ONE bucket. `hopChainShape`'s own note records 13 divergences from getting this wrong, every
     * one an untyped `out()` at depth 2 or more, and that `!== 1` is the right test because
     * `out()` iterates EVERY bucket and so visits a two-type edge once per label it carries.
     */
    const multi = new Graph();

    multi.addVertex({ id: 'x', labels: ['User'], properties: { team: 't1' } });
    multi.addVertex({ id: 'y', labels: ['User'], properties: { team: 't1' } });
    multi.addVertex({ id: 'z', labels: ['User'], properties: { team: 't1' } });
    multi.addEdge({
      id: 'm1',
      from: multi.getVertexById('x') as Vertex,
      to: multi.getVertexById('y') as Vertex,
      labels: ['E', 'F'],
      properties: {},
    });
    multi.addEdge({
      id: 'm2',
      from: multi.getVertexById('y') as Vertex,
      to: multi.getVertexById('z') as Vertex,
      labels: ['E'],
      properties: {},
    });

    expect(multi.multiTypeEdgeCount).toBeGreaterThan(0);
    expect(
      countShortcut(traversal(V(), out(), has('team', eq('t1')), out(), count()), multi),
    ).toBeUndefined();

    // A SINGLE named type is still safe on the same graph — one bucket is one bucket however many
    // types the edge carries — so the guard narrows rather than disabling the rung.
    expect(
      countShortcut(traversal(V(), out('E'), has('team', eq('t1')), out('E'), count()), multi),
    ).toBe(1);
  });

  test('count(local) is a different question', () => {
    expect(
      answered(traversal(V(), out('E'), has('team', eq('t1')), out('E'), count(Scope.local))),
    ).toBeUndefined();
  });
});

describe('the siblings keep every shape they already answered', () => {
  /**
   * The condition for adding a rung: it is listed AFTER the four it sits beside, and requires at
   * least one filter STRICTLY BETWEEN two hops, which none of them accepts. These pin that the
   * neighbouring shapes still reach their own rungs with their own answers.
   */
  test('the four neighbours', () => {
    // one hop, no filter: 8 E edges in the fixture (a:2, b:1, c:1, d:2, f:1 = 7) — counted: a->b,
    // a->c, b->c, c->c, d->a, d->b, f->a = 7.
    expect(answered(traversal(V(), out('E'), count()))).toBe(7);
    // hop then filter (`filteredHopCount`): E-targets with team t1 are b (from a, d) and a (from d,
    // f) = 4.
    expect(answered(traversal(V(), out('E'), has('team', eq('t1')), count()))).toBe(4);
    // filter then hop (`startFilteredHopCount`): t1 starts are a, b, d with 2 + 1 + 2 = 5 E edges.
    expect(answered(traversal(V(), has('team', eq('t1')), out('E'), count()))).toBe(5);
    // two hops, no filter between (`hopChainCount`): sum over middles of arrivals x departures —
    // a: 2x2=4 (in from d, f), b: 2x1=2 (in from a, d), c: 3x1=3 (in from a, b, itself) -> 9.
    expect(answered(traversal(V(), out('E'), out('E'), count()))).toBe(9);
  });

  test('an ordering predicate still works through the new rung', () => {
    // `gt` rather than `eq`, so the rung is not quietly equality-only.
    expect(answered(traversal(V(), out('E'), has('team', gt('t1')), out('E'), count()))).toBe(3);
  });
});

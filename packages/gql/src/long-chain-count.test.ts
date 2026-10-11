// Item 298. The count family was smooth to FOUR segments and fell off a cliff at FIVE: 200 nodes
// of degree 5, min of 3, the rate per path was 8.7 / 9.9 ns at three and four hops and 425.6 ns
// at five, flat at 433.2 by six — the signature of the general matcher, which builds a binding
// per path. `longChainCount` answers five or more segments as a forward sweep of way counts,
// O(hops x edges) in time and O(vertices) in memory: 266.03 -> 0.37 ms at five hops (719x) and
// 1353.82 -> 0.52 ms at six (2603x).
//
// EVERY TEST HERE HAS AN ORACLE, and it is the engine's own other route. A clause `WHERE` over
// four or more segments declines the whole shortcut family (`detectCountShortcut` returns `null`
// there), so adding an always-true predicate that READS a variable forces the identical question
// onto the general matcher. `sweptAndWalked` asks both and requires them equal. That is the
// safety argument: a sweep that mis-attributes a weight returns a plausible number, and only a
// second route disagrees with it.
import { describe, expect, test } from 'bun:test';

import { Graph, type Vertex } from '@lenke/core';

import { query } from './index.js';

/**
 * An IRREGULAR graph, on purpose. Equal degrees hide a mis-weighted sweep — every wrong
 * attribution lands on a bucket of the same size — so degrees here vary per vertex, labels are
 * mixed, and two edge types interleave.
 */
const g = (): Graph => {
  const graph = new Graph();
  const ids: Vertex[] = [];

  for (let i = 0; i < 24; i++) {
    ids.push(
      graph.addVertex({
        // Three labels, unevenly spread, so a label test at any position changes the answer.
        labels: [i % 3 === 0 ? 'A' : 'B', 'N'],
        // `s` is on EVEN vertices only, so a PRESENCE test is a real gate rather than an
        // always-true one — every vertex carries `i`, so `i IS NOT NULL` would decide nothing.
        properties: i % 2 === 0 ? { i, s: 1 } : { i },
      }),
    );
  }

  for (let i = 0; i < ids.length; i++) {
    // Degrees 1..4, varying with i.
    for (let d = 0; d <= i % 4; d++) {
      graph.addEdge({
        from: ids[i],
        to: ids[(i * 5 + d * 7 + 1) % ids.length],
        labels: [d % 2 === 0 ? 'E' : 'F'],
        properties: { d },
      });
    }
  }

  return graph;
};

const countOf = (q: string): number => {
  const [row] = [...query(g(), q)] as { c: number }[];

  return row?.c ?? -1;
};

/**
 * The same question down both routes: the sweep's `count(*)`, and the ENUMERATION of the same
 * pattern, whose row count is the same number because a fixed-length chain is a walk and nothing
 * here is `DISTINCT`.
 *
 * This oracle used to be an always-true clause `WHERE a.i >= 0`, on the grounds that a clause
 * predicate over four or more segments declined the whole family. **Item 305 taught the sweep
 * exactly that shape**, so the predicate spelling would have made this the sweep compared against
 * itself — every test below passing by agreeing with the thing it tests. Projecting a COLUMN
 * cannot be answered by any count shortcut, because `detectCountShortcut` requires `count(*)` and
 * a projection is not one; it is also the oracle the Rust twin uses, which is the reason to prefer
 * it over hunting for the next predicate the sweep still declines.
 */
const enumeratedOf = (q: string): number => [...query(g(), q)].length;

const sweptAndWalked = (pattern: string): number => {
  const swept = countOf(`MATCH ${pattern} RETURN count(*) AS c`);
  const walked = enumeratedOf(`MATCH ${pattern} RETURN a.i AS z`);

  expect(swept).toBe(walked);

  return swept;
};

/** The unfiltered five-segment baseline every DECLINE case is measured against. */
const PLAIN_OUT_PATTERN = '(a:N)-[:E]->(b)-[:E]->(c)-[:E]->(d)-[:E]->(e)-[:E]->(f)';
const PLAIN_OUT = `MATCH ${PLAIN_OUT_PATTERN} RETURN count(*) AS c`;

describe('the sweep agrees with the general matcher', () => {
  test('five segments, unlabelled interior', () => {
    expect(sweptAndWalked(PLAIN_OUT_PATTERN)).toBe(204);
  });

  test('six segments', () => {
    expect(sweptAndWalked('(a:N)-[:E]->(b)-[:E]->(c)-[:E]->(d)-[:E]->(e)-[:E]->(f)-[:E]->(h)'));
  });

  test('seven segments — the depth a fifth hand-written arm would not have reached', () => {
    expect(
      sweptAndWalked('(a:N)-[:E]->(b)-[:E]->(c)-[:E]->(d)-[:E]->(e)-[:E]->(f)-[:E]->(h)-[:E]->(j)'),
    );
  });

  test('a label on every position, including the two ENDS', () => {
    // The ends are what the degree products cannot carry. The sweep visits them, so it can.
    expect(sweptAndWalked('(a:A)-[:E]->(b:B)-[:E]->(c:A)-[:E]->(d:B)-[:E]->(e:A)-[:E]->(f:B)'));
  });

  test('a label on the LAST position only — the bucket-size fast path has a far label', () => {
    expect(sweptAndWalked('(a:N)-[:E]->(b)-[:E]->(c)-[:E]->(d)-[:E]->(e)-[:E]->(f:A)'));
  });

  test('a label on the START position only', () => {
    expect(sweptAndWalked('(a:A)-[:E]->(b)-[:E]->(c)-[:E]->(d)-[:E]->(e)-[:E]->(f)')).toBe(68);
  });

  test('a CONJUNCTIVE label, where the candidate source hands back a SUPERSET', () => {
    // `seedLabel` on an `and` seeds ONE side and returns the other unchecked, so
    // `candidateVertexSource(:N&A)` yields all 24 `N` vertices and the explicit `matchesLabel`
    // re-test is what narrows them to the 8 that are also `A`. A mutant that dropped that
    // re-test SURVIVED every single-label case here — `:A` already seeds exactly the right
    // bucket, and `:N` is vacuous — and only a conjunction whose seeded side is a superset
    // tells them apart: 68 against the unnarrowed 204.
    expect(sweptAndWalked('(a:N&A)-[:E]->(b)-[:E]->(c)-[:E]->(d)-[:E]->(e)-[:E]->(f)')).toBe(68);
    expect(sweptAndWalked('(a:N)-[:E]->(b:N&A)-[:E]->(c)-[:E]->(d)-[:E]->(e)-[:E]->(f)')).toBe(68);
    expect(sweptAndWalked('(a:N)-[:E]->(b)-[:E]->(c)-[:E]->(d)-[:E]->(e)-[:E]->(f:N&A)')).toBe(68);
  });

  test('every segment REVERSED', () => {
    expect(sweptAndWalked('(a:N)<-[:E]-(b)<-[:E]-(c)<-[:E]-(d)<-[:E]-(e)<-[:E]-(f)'));
  });

  test('MIXED directions — a swapped endpoint on any leg is a different answer', () => {
    expect(sweptAndWalked('(a:N)-[:E]->(b)<-[:E]-(c)-[:E]->(d)<-[:E]-(e)-[:E]->(f)'));
  });

  test('a SECOND edge type, and mixed types along the chain', () => {
    expect(sweptAndWalked('(a:N)-[:F]->(b)-[:F]->(c)-[:F]->(d)-[:F]->(e)-[:F]->(f)'));
    expect(sweptAndWalked('(a:N)-[:E]->(b)-[:F]->(c)-[:E]->(d)-[:F]->(e)-[:E]->(f)'));
  });

  test('an UNTYPED relationship spans both buckets', () => {
    // The abbreviated edge pattern, which carries no type — so `relTypeNames` is `undefined` and
    // both `edgesOfTypes` and `bucketSize` take their every-bucket route.
    expect(sweptAndWalked('(a:N)->(b)->(c)->(d)->(e)->(f)'));
  });

  test('a chain that DIES in the middle counts 0, and still counts a row', () => {
    // No vertex carries `Z`, so position 3 is empty and the early return fires. ISO yields one
    // row of zero for an aggregate with no GROUP BY, which the sweep must not swallow.
    expect(
      countOf(
        'MATCH (a:N)-[:E]->(b)-[:E]->(c:Z)-[:E]->(d)-[:E]->(e)-[:E]->(f) RETURN count(*) AS c',
      ),
    ).toBe(0);
  });

  test('a chain whose LAST position is empty counts 0', () => {
    expect(
      countOf(
        'MATCH (a:N)-[:E]->(b)-[:E]->(c)-[:E]->(d)-[:E]->(e)-[:E]->(f:Z) RETURN count(*) AS c',
      ),
    ).toBe(0);
  });

  test('an unreachable edge TYPE counts 0', () => {
    expect(
      countOf(
        'MATCH (a:N)-[:NOPE]->(b)-[:E]->(c)-[:E]->(d)-[:E]->(e)-[:E]->(f) RETURN count(*) AS c',
      ),
    ).toBe(0);
  });
});

describe('an INLINE constraint at any position', () => {
  // Item 303. The arm used to refuse any constrained node outright (`plainNode`), so a chain with
  // one gated interior position declined every shortcut and fell to the general matcher: 25-82x
  // the unconstrained chain in TS and 28-121x in native. The sweep VISITS every position, so a
  // gate has a once-per-element place to go — item 219's argument, one family along. Now 1.2-1.7x,
  // i.e. 33.6-79.8x faster.
  //
  // Each case is against the ORACLE, as everything else here is: a clause `WHERE` over four or
  // more segments declines the whole family, so appending an always-true one that reads a bound
  // name forces the identical question onto the general matcher.
  const SIX = ['a', 'b', 'c', 'd', 'e', 'f'];

  /** The 5-segment chain with `{k: …}` at position `at` (0 = the start, 5 = the last node). */
  const gatedAt = (at: number, prop = 'i: 1'): string => {
    let q = `(${SIX[0]}:N${at === 0 ? ` {${prop}}` : ''})`;

    for (let h = 1; h <= 5; h++) {
      q += `-[:E]->(${h < 6 ? `n${h}` : ''}${at === h ? ` {${prop}}` : ''})`;
    }

    return q;
  };

  test('a gate at EVERY position agrees with the general matcher', () => {
    // Six positions, including the START (applied at seed time) and the LAST (which takes an
    // extra pass rather than the degree-sum shortcut — a different code path from the interiors).
    //
    // EXACT counts, not `> 0`: when these were first written as `>= 0` the two multi-gate cases
    // below were silently comparing 0 against 0, which asserts nothing. A measured number is the
    // only version of this test that cannot go vacuous without failing.
    expect([0, 1, 2, 3, 4, 5].map((at) => sweptAndWalked(gatedAt(at)))).toEqual([
      7, 10, 9, 8, 7, 10,
    ]);
  });

  test('a gate that matches NOTHING counts 0 at every position, and still yields a row', () => {
    for (let at = 0; at <= 5; at++) {
      expect(countOf(`MATCH ${gatedAt(at, 'i: 9999')} RETURN count(*) AS c`)).toBe(0);
    }
  });

  test('SEVERAL gates at once, including both ends', () => {
    // Ranges rather than single values, because three single-value gates over this fixture
    // co-occur on NO walk — the first spelling of this test counted 0 both ways.
    expect(
      sweptAndWalked(
        '(a:N WHERE a.i < 12)-[:E]->(b)-[:E]->(c)-[:E]->(d)-[:E]->(e)-[:E]->(f WHERE f.i > 5)',
      ),
    ).toBe(78);
    expect(
      sweptAndWalked(
        '(a:N)-[:E]->(b WHERE b.i < 20)-[:E]->(c WHERE c.i < 20)-[:E]->(d WHERE d.i < 20)' +
          '-[:E]->(e)-[:E]->(f)',
      ),
    ).toBe(106);
    // And an inline-PROPERTY gate at both ends, which is nonzero but only just — a reminder that
    // the start gate and the last-position gate are different code paths.
    expect(
      sweptAndWalked('(a:N {i: 1})-[:E]->(b)-[:E]->(c)-[:E]->(d)-[:E]->(e)-[:E]->(f {i: 6})'),
    ).toBe(2);
  });

  test('an inline WHERE, not just properties', () => {
    // `inlineOf` accepts an inline `WHERE` when it reads only the node's OWN variable, which is
    // the other half of what `plainNode` used to refuse.
    expect(
      sweptAndWalked('(a:N)-[:E]->(b)-[:E]->(c WHERE c.i > 10)-[:E]->(d)-[:E]->(e)-[:E]->(f)'),
    ).toBe(110);
    expect(
      sweptAndWalked('(a:N WHERE a.i < 12)-[:E]->(b)-[:E]->(c)-[:E]->(d)-[:E]->(e)-[:E]->(f)'),
    ).toBe(102);
  });

  test('a gate COMBINED with a label at the same position', () => {
    expect(
      sweptAndWalked('(a:N)-[:E]->(b:A {i: 0})-[:E]->(c)-[:E]->(d)-[:E]->(e)-[:E]->(f:B)'),
    ).toBe(2);
  });

  test('a gate on a REVERSED chain, where the landed end is the FROM side', () => {
    expect(sweptAndWalked('(a:N)<-[:E]-(b)<-[:E]-(c {i: 1})<-[:E]-(d)<-[:E]-(e)<-[:E]-(f)')).toBe(
      8,
    );
  });

  test('a gate on a MIXED chain, so the gate and the direction vary together', () => {
    expect(sweptAndWalked('(a:N)-[:E]->(b)<-[:E]-(c {i: 1})-[:E]->(d)<-[:E]-(e)-[:E]->(f)')).toBe(
      6,
    );
  });

  test('a gate rejecting a vertex at ONE position does not reject it at another', () => {
    // The verdict is stamped as a NEGATIVE sentinel in the per-pass buffer, not on the slot,
    // because a slot is global to the sweep and the same vertex is reached at several positions.
    // Here `{i: 1}` sits at position 2 only: vertex 1 must be excluded THERE and still counted
    // wherever else the walk lands on it, which it does — the answer has to match the oracle.
    expect(sweptAndWalked('(a:N)-[:E]->(b)-[:E]->(c {i: 1})-[:E]->(d)-[:E]->(e)-[:E]->(f)')).toBe(
      9,
    );
  });
});

describe('what the sweep must DECLINE, and still answer correctly', () => {
  test('an OPEN inline constraint — one that reads ANOTHER variable — declines', () => {
    // `inlineOf` returns `null` for these, because the constraint is not element-local: it needs
    // the start binding, which the sweep has forgotten by the time it lands on `c`. The answer
    // must still be right, via the general matcher.
    //
    // An inline WHERE rather than `{i: a.i}` — that spelling counts 0 over this fixture, so it
    // would "prove" the decline with an empty answer. The reading that matters is a NONZERO
    // count that the sweep could not have produced.
    expect(
      countOf(
        'MATCH (a:N)-[:E]->(b)-[:E]->(c WHERE c.i >= a.i)-[:E]->(d)-[:E]->(e)-[:E]->(f) ' +
          'RETURN count(*) AS c',
      ),
    ).toBe(121);
    expect(
      countOf(
        'MATCH (a:N)-[:E]->(b)-[:E]->(c {i: a.i})-[:E]->(d)-[:E]->(e)-[:E]->(f) ' +
          'RETURN count(*) AS c',
      ),
    ).toBe(0);
  });

  test('an OPEN constraint on the START position declines', () => {
    // The start is a separate code path from the interiors — its gate is applied at SEED time —
    // and a mutant that carried an open constraint there SURVIVED until this existed, because
    // nothing else reached it.
    //
    // What this discriminates is NOT the number: a FORWARD reference in an inline predicate is
    // UNKNOWN (`f` is unbound when `a`'s constraint is evaluated), so the right answer is 0 and
    // the general matcher gives it. What a wrongly-carried `null` gate does is THROW, reading
    // `.bindVar` off it — so the assertion that matters here is that this returns at all.
    expect(
      countOf(
        'MATCH (a:N WHERE a.i >= f.i)-[:E]->(b)-[:E]->(c)-[:E]->(d)-[:E]->(e)-[:E]->(f) ' +
          'RETURN count(*) AS c',
      ),
    ).toBe(0);
    expect(
      countOf(
        'MATCH (a:N {i: f.i})-[:E]->(b)-[:E]->(c)-[:E]->(d)-[:E]->(e)-[:E]->(f) ' +
          'RETURN count(*) AS c',
      ),
    ).toBe(0);
  });

  // Each of these falls through to the general matcher. The test is that the answer is right —
  // a sweep that wrongly accepted one would return a number that cannot be expressed as a
  // product of way counts.
  test('a SHARED node variable is a self-join', () => {
    // `a` appears twice, so the chain must close on itself. The sweep has no way to express
    // that: its way counts have forgotten where they came from, so it must decline.
    //
    // Its own fixture, because the discriminating evidence is that the closed count is BOTH
    // smaller than the open one AND non-zero — if the sweep had wrongly accepted the shape it
    // would have answered `open`, and a zero would not have told them apart. A ring of 10 with
    // steps +1 and +2 gives 10 x 2^5 = 320 open 5-walks and, since a closed one needs five steps
    // summing to 10, exactly 10 closed ones (all +2).
    const ring = new Graph();
    const ids = Array.from({ length: 10 }, (_, i) =>
      ring.addVertex({ labels: ['N'], properties: { i } }),
    );

    for (let i = 0; i < 10; i++) {
      for (const step of [1, 2]) {
        ring.addEdge({ from: ids[i], to: ids[(i + step) % 10], labels: ['E'], properties: {} });
      }
    }

    const on = (q: string): number => ([...query(ring, q)] as { c: number }[])[0]?.c ?? -1;
    const closed = on(
      'MATCH (a:N)-[:E]->(b)-[:E]->(c)-[:E]->(d)-[:E]->(e)-[:E]->(a) RETURN count(*) AS c',
    );
    const open = on(
      'MATCH (a:N)-[:E]->(b)-[:E]->(c)-[:E]->(d)-[:E]->(e)-[:E]->(f) RETURN count(*) AS c',
    );

    expect(open).toBe(320);
    expect(closed).toBe(10);
  });

  test('a BOUND relationship variable declines', () => {
    expect(
      countOf(
        'MATCH (a:N)-[r:E]->(b)-[:E]->(c)-[:E]->(d)-[:E]->(e)-[:E]->(f) RETURN count(*) AS c',
      ),
    ).toBe(
      countOf('MATCH (a:N)-[:E]->(b)-[:E]->(c)-[:E]->(d)-[:E]->(e)-[:E]->(f) RETURN count(*) AS c'),
    );
  });

  test('an UNDIRECTED segment declines — it is not one direction or the other', () => {
    // EXACT, not an inequality. `>= PLAIN_OUT` was the first spelling and a mutant that dropped
    // the `'both'` gate SURVIVED it: taking the segment as whichever direction it was written
    // makes the two counts EQUAL, which `>=` accepts. Measured both positions, because a gate
    // that only covers the first leg is the same bug one segment along.
    expect(
      countOf('MATCH (a:N)-[:E]-(b)-[:E]->(c)-[:E]->(d)-[:E]->(e)-[:E]->(f) RETURN count(*) AS c'),
    ).toBe(420);
    expect(
      countOf('MATCH (a:N)-[:E]->(b)-[:E]->(c)-[:E]-(d)-[:E]->(e)-[:E]->(f) RETURN count(*) AS c'),
    ).toBe(420);
    expect(countOf(PLAIN_OUT)).toBe(204);
  });

  test('a VARIABLE-LENGTH quantifier declines', () => {
    // `plainRel` refuses a quantifier. EXACT for the same reason: `> 0` let a mutant that
    // dropped the `plainRel` gate through, because a quantified leg taken as a single hop still
    // returns a positive number.
    expect(
      countOf(
        'MATCH (a:N)-[:E]->{1,2}(b)-[:E]->(c)-[:E]->(d)-[:E]->(e)-[:E]->(f) RETURN count(*) AS c',
      ),
    ).toBe(522);
  });

  test('an INLINE RELATIONSHIP property declines', () => {
    // The other half of `plainRel`, and the one no other gate covers: there is no relationship
    // VARIABLE here, so `s.rel.variable !== undefined` does not catch it.
    expect(
      countOf(
        'MATCH (a:N)-[:E {d: 0}]->(b)-[:E]->(c)-[:E]->(d)-[:E]->(e)-[:E]->(f) RETURN count(*) AS c',
      ),
    ).toBe(132);
  });
});

describe('the way-count arrays GROW, and the growth is mid-pass', () => {
  // Item 300 rewrote the sweep onto `Float64Array`s that DOUBLE from a 256-slot start, and a
  // mutant that dropped the copy of the already-written counts into the grown buffer SURVIVED
  // every test above — because the largest fixture here reaches 120 vertices, so `cap` never grew
  // at all and the whole path was dead code to the suite. The repo's own rule, learned on
  // `pull_capped`'s block bound: WHEN A LOOP HAS A BLOCK SIZE, THE FIXTURE MUST EXCEED IT, TWICE.
  //
  // So: a SMALL seed over a LARGE graph at degree 4, which reaches 10 -> 40 -> 160 -> 640 ->
  // 2560 vertices. The grow therefore fires in the MIDDLE of a pass, with counts already written
  // into the buffer being replaced — which is the only state that distinguishes the copy from its
  // absence.
  const wide = (): Graph => {
    const graph = new Graph();
    const ids = Array.from({ length: 3000 }, (_, i) =>
      graph.addVertex({
        // Ten seeds, so `cap` starts at its 256 floor and has to grow during the sweep rather
        // than during the seed.
        labels: i < 10 ? ['N', 'S'] : ['N'],
        properties: { i },
      }),
    );

    for (let i = 0; i < ids.length; i++) {
      for (let d = 0; d < 4; d++) {
        graph.addEdge({
          from: ids[i],
          to: ids[(i * 13 + d * 523 + 1) % ids.length],
          labels: ['E'],
          properties: {},
        });
      }
    }

    return graph;
  };

  test('a six-hop sweep whose frontier crosses 256 and 512 agrees with the enumeration', () => {
    const graph = wide();
    const pattern = `(a:S)${'-[:E]->()'.repeat(5)}-[:E]->(z)`;
    const on = (q: string): number => ([...query(graph, q)] as { c: number }[])[0]?.c ?? -1;
    const swept = on(`MATCH ${pattern} RETURN count(*) AS c`);
    const walked = [...query(graph, `MATCH ${pattern} RETURN a.i AS z`)].length;

    // 10 seeds x 4^6.
    expect(swept).toBe(10 * 4 ** 6);
    expect(walked).toBe(swept);
  });

  test('the same shape REVERSED, so the grow happens on the cached-adjacency route too', () => {
    const graph = wide();
    const pattern = `(z)${'<-[:E]-()'.repeat(5)}<-[:E]-(a:S)`;
    const on = (q: string): number => ([...query(graph, q)] as { c: number }[])[0]?.c ?? -1;

    expect(on(`MATCH ${pattern} RETURN count(*) AS c`)).toBe(
      [...query(graph, `MATCH ${pattern} RETURN a.i AS z`)].length,
    );
  });
});

describe('the sweep is BOUNDED in the path count, which is the point', () => {
  // The incident shape. 120 nodes at degree 5 is 120 x 5^7 = 9.375M seven-hop paths; the sweep
  // does 7 passes over 600 edges. A unit test cannot assert an RSS or a time, so what it pins is
  // that a count no enumeration could finish is still EXACT — checked against the closed form,
  // which this fixture has because every vertex has exactly degree 5.
  const regular = (): Graph => {
    const graph = new Graph();
    const ids = Array.from({ length: 120 }, (_, i) =>
      graph.addVertex({ labels: ['N'], properties: { i } }),
    );

    for (let i = 0; i < ids.length; i++) {
      for (let d = 0; d < 5; d++) {
        graph.addEdge({
          from: ids[i],
          to: ids[(i * 11 + d) % ids.length],
          labels: ['E'],
          properties: {},
        });
      }
    }

    return graph;
  };

  test('a seven-hop count over 9.4M paths is exact', () => {
    const q = `MATCH (a:N)${'-[:E]->()'.repeat(7)} RETURN count(*) AS c`;
    const [row] = [...query(regular(), q)] as { c: number }[];

    expect(row?.c).toBe(120 * 5 ** 7);
  });

  test('a TEN-hop count, where the general matcher would enumerate 1.17e9 paths', () => {
    const q = `MATCH (a:N)${'-[:E]->()'.repeat(10)} RETURN count(*) AS c`;
    const [row] = [...query(regular(), q)] as { c: number }[];

    expect(row?.c).toBe(120 * 5 ** 10);
  });
});

describe('a clause WHERE is split across the positions it names', () => {
  // Item 305. These are EXACT counts and each is also compared against the enumeration by
  // `clauseAndWalked`; the plain 204 is the discriminator that says the predicate ran at all.
  //
  // The oracle for this whole file had to be replaced before any of this could be written: it was
  // an always-true clause `WHERE a.i >= 0`, which this item makes the sweep ANSWER, so it would
  // have become the sweep compared against itself.
  const clauseAndWalked = (q: string): number => {
    const swept = countOf(q);

    expect(swept).toBe(enumeratedOf(q.replace('count(*) AS c', 'a.i AS z')));

    return swept;
  };
  const five = (where: string): string =>
    `MATCH ${PLAIN_OUT_PATTERN} ${where} RETURN count(*) AS c`;

  test('one position at a time, all six', () => {
    expect(clauseAndWalked(five(''))).toBe(204);

    for (const [name, want] of [
      ['a', 158],
      ['b', 157],
      ['c', 159],
      ['d', 160],
      ['e', 160],
      ['f', 155],
    ] as const) {
      expect(clauseAndWalked(five(`WHERE ${name}.i > 5`))).toBe(want);
    }
  });

  test('the flipped spelling of the same compare answers the same', () => {
    expect(clauseAndWalked(five('WHERE 5 < f.i'))).toBe(155);
    expect(clauseAndWalked(five('WHERE f.i > 5'))).toBe(155);
  });

  test('a conjunction over two positions, and over three', () => {
    expect(clauseAndWalked(five('WHERE b.i > 5 AND e.i < 20'))).toBe(132);
    expect(clauseAndWalked(five('WHERE a.i > 2 AND c.i > 5 AND f.i < 20'))).toBe(113);
  });

  test('a clause WHERE and an inline constraint on the SAME node conjoin', () => {
    const inlineB = '(a:N)-[:E]->(b {i: 7})-[:E]->(c)-[:E]->(d)-[:E]->(e)-[:E]->(f)';

    // `b.i > 5` is implied by `{i: 7}`, so the two together are the inline count — a gate that
    // OVERWROTE instead of conjoining would also return this, which is why the second case
    // (where the clause names a DIFFERENT node) is here too.
    expect(clauseAndWalked(`MATCH ${inlineB} WHERE b.i > 5 RETURN count(*) AS c`)).toBe(7);
    expect(clauseAndWalked(`MATCH ${inlineB} WHERE f.i > 5 RETURN count(*) AS c`)).toBe(6);
    // And a clause conjunct that CONTRADICTS the inline one must count nothing.
    expect(clauseAndWalked(`MATCH ${inlineB} WHERE b.i < 5 RETURN count(*) AS c`)).toBe(0);
  });

  test('a presence test is a gate here, and matches its inline twin', () => {
    const inlineS = '(a:N)-[:E]->(b {s: 1})-[:E]->(c)-[:E]->(d)-[:E]->(e)-[:E]->(f)';

    // Unlike the native sweep, which needs a leaf form per test, a TS gate runs the general
    // path's own `satisfies`, so ANY single-node predicate is expressible — `IS NOT NULL`
    // included. `s` is on even vertices only, so this decides something.
    expect(clauseAndWalked(five('WHERE b.s IS NOT NULL'))).toBe(102);
    expect(clauseAndWalked(five('WHERE f.s IS NOT NULL'))).toBe(102);
    expect(clauseAndWalked(`MATCH ${inlineS} RETURN count(*) AS c`)).toBe(102);
  });

  test('what it still DECLINES, each still answered correctly', () => {
    // A CORRELATION is not a per-vertex test: `a.i <= f.i` needs both ends at once. The `=`
    // spelling answers 0 over this fixture, so the `<=` one carries the discriminator.
    expect(clauseAndWalked(five('WHERE a.i <= f.i'))).toBe(100);
    expect(clauseAndWalked(five('WHERE a.i = f.i'))).toBe(0);
    // A DISJUNCTION across two positions is not a conjunction of per-position gates.
    expect(clauseAndWalked(five('WHERE b.i > 5 OR e.i < 20'))).toBe(195);
    // A CONSTANT reads no name at all, so there is no position to put it at.
    expect(clauseAndWalked(five('WHERE 1 = 1'))).toBe(204);
  });

  test('SEVERAL conjuncts on ONE position conjoin, from either spelling', () => {
    // Two clause conjuncts on one node, which a gate that kept only the first would answer as
    // 157 (the `> 5` half alone).
    expect(clauseAndWalked(five('WHERE b.i > 5 AND b.i < 10'))).toBe(34);
    expect(clauseAndWalked(five('WHERE b.i > 5 AND b.i < 10 AND e.i > 3'))).toBe(24);

    // The same question with one half spelled as an INLINE `WHERE` on the node. A gate that
    // dropped the node's own inline predicate once a clause conjunct joined it would answer the
    // clause half alone.
    const inlineWhere = '(a:N)-[:E]->(b WHERE b.i > 5)-[:E]->(c)-[:E]->(d)-[:E]->(e)-[:E]->(f)';

    expect(clauseAndWalked(`MATCH ${inlineWhere} RETURN count(*) AS c`)).toBe(157);
    expect(clauseAndWalked(`MATCH ${inlineWhere} WHERE b.i < 10 RETURN count(*) AS c`)).toBe(34);
  });
});

describe('a THREE-segment chain whose END is constrained takes the sweep', () => {
  // Item 306. Items 303 and 305 MOVED this family's cliff rather than closing it: a degree
  // product answers its last hop as a weighted sum of DEGREES, and a degree cannot say which of a
  // vertex's edges land somewhere that passes, so an END constraint declined every arm and
  // enumerated — 668.3ms against 19.5 for the same chain unfiltered, at 20,000 vertices.
  //
  // Only three segments, and the TWO-segment case is a retraction with its numbers (28.5ms
  // against the 7.5 the tuned two-hop arm already managed). Native went the other way at two
  // hops. The routing is a perf claim the bench settles; what these tests pin is that the answer
  // is EXACT at a depth this arm never ran at before.
  const three = '(a:N)-[:E]->(b)-[:E]->(c)-[:E]->(d)';
  const exact = (q: string, want: number): void => {
    expect(countOf(q)).toBe(want);
    expect(enumeratedOf(q.replace('count(*) AS c', 'a.i AS z'))).toBe(want);
  };

  test('the ungated control, and both spellings of a gate on the END', () => {
    exact(`MATCH ${three} RETURN count(*) AS c`, 84);
    exact('MATCH (a:N)-[:E]->(b)-[:E]->(c)-[:E]->(d {i: 7}) RETURN count(*) AS c', 3);
    exact(`MATCH ${three} WHERE d.i > 5 RETURN count(*) AS c`, 64);
    exact(`MATCH ${three} WHERE d.s IS NOT NULL RETURN count(*) AS c`, 42);
    exact('MATCH (a:N)-[:E]->(b)-[:E]->(c)-[:E]->(d:A) RETURN count(*) AS c', 28);
  });

  test('a gate on the END and one on the START at once', () => {
    exact(`MATCH ${three} WHERE a.i > 5 AND d.i > 5 RETURN count(*) AS c`, 49);
  });

  test('a MIXED-direction three-segment chain with a gated end', () => {
    exact('MATCH (a:N)-[:E]->(b)<-[:E]-(c)-[:E]->(d {i: 7}) RETURN count(*) AS c', 3);
  });

  test('a CORRELATION on the end still declines, and still answers', () => {
    // `d.i >= a.i` names two positions, so it is not a per-vertex gate: the sweep declines and
    // the general matcher answers. The number is what says the predicate ran — the ungated chain
    // is 84.
    exact(`MATCH ${three} WHERE d.i >= a.i RETURN count(*) AS c`, 41);
  });

  test('an INLINE gate on the end PLUS a clause the split declines', () => {
    // The shape a mutant lived in: with the end inline-gated the route is taken, and if a
    // DECLINED split were carried as "no gates" the correlation would be silently dropped and
    // this would answer 3 — the inline `{i: 7}` alone — instead of 2.
    exact('MATCH (a:N)-[:E]->(b)-[:E]->(c)-[:E]->(d {i: 7}) RETURN count(*) AS c', 3);
    exact(
      'MATCH (a:N)-[:E]->(b)-[:E]->(c)-[:E]->(d {i: 7}) WHERE d.i >= a.i RETURN count(*) AS c',
      2,
    );
  });
});

describe('a THREE-segment chain whose START is constrained takes the sweep too', () => {
  // Item 307. Item 306 routed the END at this depth and left the START enumerating: 141.3ms
  // against 16.3 for the same chain unfiltered, where native answered it in 0.34 — a 415x
  // cross-engine gap on one position of one depth. Now 19.2ms (7.4x), 16.9 for the clause
  // spelling (8.1x).
  //
  // The END or the START, never an interior ALONE: an interior gate makes the degree product
  // faster than its own unfiltered self (8.1ms against 16.3, because the product iterates the
  // middle and the gate shrinks what it iterates), so there is nothing to win there and item 219
  // already owns it.
  const exact = (q: string, want: number): void => {
    expect(countOf(q)).toBe(want);
    expect(enumeratedOf(q.replace('count(*) AS c', 'a.i AS z'))).toBe(want);
  };

  test('both spellings of a gate on the START', () => {
    exact('MATCH (a:N)-[:E]->(b)-[:E]->(c)-[:E]->(d) RETURN count(*) AS c', 84);
    exact('MATCH (a:N {i: 7})-[:E]->(b)-[:E]->(c)-[:E]->(d) RETURN count(*) AS c', 4);
    exact('MATCH (a:N)-[:E]->(b)-[:E]->(c)-[:E]->(d) WHERE a.i > 5 RETURN count(*) AS c', 65);
  });

  test('a START gate alongside an interior one', () => {
    exact(
      'MATCH (a:N)-[:E]->(b)-[:E]->(c)-[:E]->(d) WHERE a.i > 5 AND c.i > 5 RETURN count(*) AS c',
      48,
    );
  });

  test('a START gate on a MIXED-direction chain', () => {
    exact('MATCH (a:N)-[:E]->(b)-[:E]->(c)<-[:E]-(d) WHERE a.i > 5 RETURN count(*) AS c', 70);
  });

  test('a LABEL on the start is not a gate, and keeps the product', () => {
    // `(a:A)` seeds a label bucket, which is what the products already do, so it must NOT be
    // mistaken for a constraint that needs this route — the answer is the discriminator either
    // way, but the comment is the point: `plainNode` treats a bare label as plain.
    exact('MATCH (a:A)-[:E]->(b)-[:E]->(c)-[:E]->(d) RETURN count(*) AS c', 28);
  });
});

describe('an END-gated chain is read BACKWARDS, and the reversal is exact', () => {
  // Item 308. A gate on the last position costs twice — it needs a pass of its own (item 303) and
  // every pass before it runs over an unnarrowed frontier — where a gate on the FIRST narrows the
  // seed and the degree tail answers the end. So an end-gated chain is walked backwards, which is
  // `reversedTwoHop`'s argument at any depth: a fixed-length chain read backwards is the same
  // multiset of walks.
  //
  // These are the shapes a REVERSAL specifically breaks, which the plain-forward tests above
  // cannot see: per-hop EDGE TYPES must reverse with the hops, per-hop DIRECTIONS must each flip,
  // and the two ends' LABELS must swap. Each is checked against the enumeration, and each has an
  // ungated twin so the gate is known to have done something.
  const exact = (q: string, want: number): void => {
    expect(countOf(q)).toBe(want);
    expect(enumeratedOf(q.replace('count(*) AS c', 'a.i AS z'))).toBe(want);
  };

  test('per-hop EDGE TYPES reverse with the hops', () => {
    exact('MATCH (a:N)-[:E]->(b)-[:F]->(c)-[:E]->(d)-[:F]->(e) RETURN count(*) AS c', 60);
    exact('MATCH (a:N)-[:E]->(b)-[:F]->(c)-[:E]->(d)-[:F]->(e {i: 7}) RETURN count(*) AS c', 2);
  });

  test('per-hop DIRECTIONS each flip', () => {
    exact('MATCH (a:N)-[:E]->(b)<-[:F]-(c)-[:E]->(d)<-[:F]-(e) RETURN count(*) AS c', 66);
    exact('MATCH (a:N)-[:E]->(b)<-[:F]-(c)-[:E]->(d)<-[:F]-(e {i: 7}) RETURN count(*) AS c', 4);
  });

  test('the ENDS swap, so each label follows its own node', () => {
    // An interior label, which must stay on its own position when the chain turns round.
    exact(
      'MATCH (a:N)-[:E]->(b:A)-[:E]->(c)-[:E]->(d)-[:E]->(e) WHERE e.i > 5 RETURN count(*) AS c',
      30,
    );
    // The START's label, which becomes the LAST position's when the chain is reversed — and so
    // stops being the seed's label and starts being a per-vertex test.
    exact(
      'MATCH (a:A)-[:E]->(b)-[:E]->(c)-[:E]->(d)-[:E]->(e) WHERE e.i > 5 RETURN count(*) AS c',
      33,
    );
  });

  test('BOTH ends gated is NOT reversed, and still exact', () => {
    // Reversing buys nothing here (the extra pass is unavoidable either way), so the chain stays
    // forward — asserted by answer, since the routing itself is a perf claim.
    exact(
      'MATCH (a:N)-[:E]->(b)-[:E]->(c)-[:E]->(d)-[:E]->(e) WHERE a.i > 5 AND e.i > 5 RETURN count(*) AS c',
      80,
    );
  });
});

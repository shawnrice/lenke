// Item 553. `detectGroupedNodeAggregate`'s admission set was `foldFor`'s plus `count(*)`, and its
// own doc comment said why `sum`/`avg` were not in it — _"a grouped sum over floats depends on the
// order values reach their group, and a FILTERED scan may seed from an index … The unfiltered case
// would be safe by the item-466 argument, but a grouped path that takes `sum` only when unfiltered
// is a guard with no test — item 468 recorded how that goes — so it waits for a shape that can be
// demonstrated."_
//
// THIS IS THAT SHAPE. With a range index on `age`:
//
//   WHERE n.age >= 5 RETURN n.tag AS k, collect(n.age)    no index  [7,5,9] / [8,6]
//                                                         indexed   [5,7,9] / [6,8]
//
// The seek visits in INDEX order, so values reach their group in a different order — and the same
// predicate written `n.age + 0 >= 5`, which cannot seed, is unchanged either way, which is what
// isolates the cause to the seed rather than to the filter. BOTH engines give both answers, so the
// reordering is a real contract the rung would have to reproduce and cannot.
//
// So the flag is `unfiltered`, and these are its two sides. ts, 200,000 vertices, one case per
// process, pristine against the change:
//
//   n.age AS k, sum(n.age)                      105.77 ->  9.22 ms   11.5x
//   n.age AS k, collect(n.age)                  100.84 ->  9.73      10.4x
//   n.age AS k, percentile_cont(n.age, 0.5)     111.27 -> 13.69       8.1x
//   n.age AS k, count(*)            (control)     6.42 ->  4.04
//   n.age AS k, max(n.age)          (control)     9.84 ->  9.28
//   WHERE n.age > 1 … sum(n.age)    (refused)   174.67 -> 163.75
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { deserialize as tsDeserialize } from '@lenke/serialization';

import { nativeBackend, nativeReady } from './conformance-harness.js';
import { graphFromNdjson } from './graph.js';

const LINES: string[] = [];

for (let i = 0; i < 10; i++) {
  LINES.push(
    JSON.stringify({
      type: 'node',
      id: `n${i}`,
      labels: ['P'],
      // Two tags, so two groups; ages interleaved, so an index seek reorders WITHIN a group.
      properties: { tag: i % 2 === 0 ? 'a' : 'b', age: (i * 7) % 10, f: ((i * 7) % 10) * 1.7 },
    }),
  );
}

// One node with no `f`, so the nullish rule shows in a collected group.
LINES.push(JSON.stringify({ type: 'node', id: 'z', labels: ['P'], properties: { tag: 'a' } }));

const NDJSON = LINES.join('\n');
const suite = nativeReady ? describe : describe.skip;

suite('the grouped-scan rung collects the non-foldable aggregates (item 553)', () => {
  const ts = (indexed: boolean): Graph => {
    const g = tsDeserialize(NDJSON, 'ndjson', new Graph());

    if (indexed) {
      g.createIndex({ on: 'vertex', kind: 'range', keys: ['age'] });
    }

    return g;
  };
  const nat = (indexed: boolean): ReturnType<typeof graphFromNdjson> => {
    const g = graphFromNdjson(nativeBackend(), NDJSON);

    if (indexed) {
      g.createIndex({ on: 'vertex', kind: 'range', keys: ['age'] });
    }

    return g;
  };

  const plain = ts(false);
  const natPlain = nat(false);

  /** Compared as a SEQUENCE — group order is first-seen and within-group order is the answer. */
  const agree = (q: string): string => {
    const got = JSON.stringify(tsQuery(plain, q));

    expect(`${q} ${got}`).toBe(`${q} ${JSON.stringify(natPlain.query(q))}`);

    return got;
  };

  test('the three widened aggregates agree with native', () => {
    expect(agree('MATCH (n:P) RETURN n.tag AS k, collect(n.age) AS m')).toBe(
      '[{"k":"a","m":[0,4,8,2,6]},{"k":"b","m":[7,1,5,9,3]}]',
    );
    agree('MATCH (n:P) RETURN n.tag AS k, sum(n.f) AS m');
    agree('MATCH (n:P) RETURN n.tag AS k, avg(n.f) AS m');
    agree('MATCH (n:P) RETURN n.tag AS k, stddev_pop(n.f) AS m');
    agree('MATCH (n:P) RETURN n.tag AS k, stddev_samp(n.f) AS m');
    agree('MATCH (n:P) RETURN n.tag AS k, collect_list(n.f) AS m');
    agree('MATCH (n:P) RETURN n.tag AS k, percentile_cont(n.age, 0.5) AS m');
    agree('MATCH (n:P) RETURN n.tag AS k, percentile_disc(n.age, 0.25) AS m');
    // Several at once, mixing all three accumulator kinds.
    agree('MATCH (n:P) RETURN n.tag AS k, count(*) AS c, max(n.age) AS x, collect(n.age) AS l');
    // `z` has no `f`, so its group collects one fewer value than it has rows.
    agree('MATCH (n:P) RETURN n.tag AS k, count(*) AS c, collect(n.f) AS l');
  });

  test('a FILTER declines the rung, and both engines keep the general order', () => {
    agree('MATCH (n:P) WHERE n.age >= 5 RETURN n.tag AS k, collect(n.age) AS m');
    agree('MATCH (n:P) WHERE n.age >= 5 RETURN n.tag AS k, sum(n.f) AS m');
    agree("MATCH (n:P {tag: 'a'}) RETURN n.tag AS k, collect(n.age) AS m");
    // The foldable aggregates are unaffected by the flag and must still take the rung.
    agree('MATCH (n:P) WHERE n.age >= 5 RETURN n.tag AS k, max(n.age) AS m');
    agree('MATCH (n:P) WHERE n.age >= 5 RETURN n.tag AS k, count(*) AS c');
  });

  test('THE DEMONSTRATION: an index reorders the filtered answer, in both engines', () => {
    const q = 'MATCH (n:P) WHERE n.age >= 5 RETURN n.tag AS k, collect(n.age) AS m';
    const noIndex = JSON.stringify(tsQuery(ts(false), q));
    const withIndex = JSON.stringify(tsQuery(ts(true), q));

    // The two differ — which is why an order-sensitive aggregate may not ride a FILTERED scan.
    expect(noIndex).toBe('[{"k":"b","m":[7,5,9]},{"k":"a","m":[8,6]}]');
    expect(withIndex).toBe('[{"k":"b","m":[5,7,9]},{"k":"a","m":[6,8]}]');
    // And native agrees with each, so both orders are a real contract.
    expect(JSON.stringify(nat(false).query(q))).toBe(noIndex);
    expect(JSON.stringify(nat(true).query(q))).toBe(withIndex);
    // The SAME predicate written so it cannot seed is unchanged by the index — which isolates the
    // cause to the seed rather than to the filter.
    const unseekable = 'MATCH (n:P) WHERE n.age + 0 >= 5 RETURN n.tag AS k, collect(n.age) AS m';

    expect(JSON.stringify(tsQuery(ts(true), unseekable))).toBe(noIndex);
    // An UNFILTERED grouped collect — the shape the rung now takes — is index-independent, which
    // is the whole argument for admitting it.
    const open = 'MATCH (n:P) RETURN n.tag AS k, collect(n.age) AS m';

    expect(JSON.stringify(tsQuery(ts(true), open))).toBe(JSON.stringify(tsQuery(ts(false), open)));
    expect(JSON.stringify(nat(true).query(open))).toBe(JSON.stringify(tsQuery(ts(false), open)));
  });

  test('the refusals that are not about order', () => {
    // A DISTINCT argument has no fold and is not admitted.
    agree('MATCH (n:P) RETURN n.tag AS k, count(DISTINCT n.age) AS d');
    // An aggregate reading a variable the key does not — refused by `refsOnlyVar`, which now
    // covers the collected accumulators too.
    agree('MATCH (n:P) RETURN n.tag AS k, collect(n.tag) AS l');
    // ORDER BY and paging stay with the general path (items 190, 199).
    agree('MATCH (n:P) RETURN n.tag AS k, collect(n.age) AS l ORDER BY k');
    agree('MATCH (n:P) RETURN n.tag AS k, collect(n.age) AS l LIMIT 1');
  });
});

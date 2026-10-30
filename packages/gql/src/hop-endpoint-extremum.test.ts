// The regression tests for item 1246's per-endpoint extremum fold.
//
// ⚠️ EVERY CASE HERE WAS WRITTEN TO KILL A MUTANT, and one of them was written because the mutant
// SURVIVED the whole suite first. The fold replaces a per-row walk with a per-distinct-endpoint
// one, which is answer-equivalent when admitted — so nothing that merely checks results can see it
// start firing on a shape it should refuse. The fixture is therefore built so that each refusal has
// a DIFFERENT answer from the admission:
//
//   - two ISOLATED vertices carry the global extremes, so folding an unreached endpoint changes
//     both `min` and `max` (mutant `reach-always-true`, which SURVIVED the suite before this file
//     existed — the other fixtures give every vertex a qualifying in-edge, so "always reached"
//     answered correctly everywhere);
//   - one vertex is reached only by the WRONG edge type, so ignoring the type filter changes `min`;
//   - the sources carry mid-range values, so an argument wrongly read off the START vertex is
//     visible rather than coincidentally equal;
//   - a non-universal start label must DECLINE to the row walk, so a graph where one vertex lacks
//     the label answers differently from one where none does.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';
import { deserialize } from '@lenke/serialization';

import { query } from './index.js';

/**
 * `m1..m3` are the only endpoints a `(:P)-[:KNOWS]->` hop reaches. `lo`/`hi` are isolated and hold
 * the global extremes; `wrong` is reached only by `LIKES`; `s1`/`s2` are sources with mid values.
 */
const NDJSON = [
  '{"type":"node","id":"s1","labels":["P"],"properties":{"n":"s1","k":50}}',
  '{"type":"node","id":"s2","labels":["P"],"properties":{"n":"s2","k":51}}',
  '{"type":"node","id":"m1","labels":["P"],"properties":{"n":"m1","k":10}}',
  '{"type":"node","id":"m2","labels":["P"],"properties":{"n":"m2","k":20}}',
  '{"type":"node","id":"m3","labels":["P"],"properties":{"n":"m3","k":30}}',
  '{"type":"node","id":"lo","labels":["P"],"properties":{"n":"aaa","k":-999}}',
  '{"type":"node","id":"hi","labels":["P"],"properties":{"n":"zzz","k":999}}',
  '{"type":"node","id":"wrong","labels":["P"],"properties":{"n":"bbb","k":-5}}',
  '{"type":"edge","id":"e1","labels":["KNOWS"],"from":"s1","to":"m1","properties":{}}',
  '{"type":"edge","id":"e2","labels":["KNOWS"],"from":"s2","to":"m2","properties":{}}',
  '{"type":"edge","id":"e3","labels":["KNOWS"],"from":"s1","to":"m3","properties":{}}',
  // A SECOND edge onto m2, so the admitted fold throws away a real multiplicity: `count(*)` is 4
  // while the distinct endpoints are 3.
  '{"type":"edge","id":"e4","labels":["KNOWS"],"from":"s2","to":"m2","properties":{}}',
  '{"type":"edge","id":"e5","labels":["LIKES"],"from":"s1","to":"wrong","properties":{}}',
].join('\n');

const graph = (): Graph => deserialize(NDJSON, 'ndjson', new Graph());

describe('the per-endpoint extremum fold (item 1246)', () => {
  test('folds only the endpoints the hop actually reaches', () => {
    // `lo`/`hi` hold 'aaa'/'zzz' and -999/999 and are UNREACHED; `wrong` holds 'bbb'/-5 and is
    // reached only by LIKES. Every one of those would move an answer below.
    expect(
      query(graph(), 'MATCH (a:P)-[:KNOWS]->(x) RETURN min(x.n) AS lo, max(x.n) AS hi'),
    ).toEqual([{ lo: 'm1', hi: 'm3' }]);

    expect(
      query(graph(), 'MATCH (a:P)-[:KNOWS]->(x) RETURN min(x.k) AS lo, max(x.k) AS hi'),
    ).toEqual([{ lo: 10, hi: 30 }]);
  });

  test('a single extremum answers the same as the pair', () => {
    expect(query(graph(), 'MATCH (a:P)-[:KNOWS]->(x) RETURN min(x.k) AS v')).toEqual([{ v: 10 }]);
    expect(query(graph(), 'MATCH (a:P)-[:KNOWS]->(x) RETURN max(x.k) AS v')).toEqual([{ v: 30 }]);
  });

  test('count(*) keeps the MULTIPLICITY the endpoint fold discards', () => {
    // m2 has two in-edges, so there are 4 rows over 3 distinct endpoints. A fold that rode the
    // per-endpoint walk would answer 3. This is the `allExtrema` refusal, end to end.
    expect(
      query(graph(), 'MATCH (a:P)-[:KNOWS]->(x) RETURN count(*) AS c, max(x.k) AS hi'),
    ).toEqual([{ c: 4, hi: 30 }]);
  });

  test('a SINGLE non-extremum aggregate keeps the multiplicity too (item 1247)', () => {
    // The single-aggregate rung got the fold at item 1247, so it needs `count`'s refusal asserted
    // on its own terms: `count(x.k)` is foldable but NOT idempotent. 4 rows over 3 distinct
    // endpoints — a mutant forcing `isExtremum` true answers 3.
    expect(query(graph(), 'MATCH (a:P)-[:KNOWS]->(x) RETURN count(x.k) AS c')).toEqual([{ c: 4 }]);
  });

  test('the two SPELLINGS of one extremum cost the same shape (item 1247)', () => {
    // Not a timing test — an ANSWER test that the two rungs agree, which is the invariant behind
    // the 1.42x inversion item 1247 fixed: `min(x.k)` alone was claimed by `detectHopAggregate`
    // and `min(x.k), max(x.k)` by `detectMultiHopAggregate`, and only the second had the fold.
    const one = query(graph(), 'MATCH (a:P)-[:KNOWS]->(x) RETURN min(x.k) AS lo');
    const pair = query(graph(), 'MATCH (a:P)-[:KNOWS]->(x) RETURN min(x.k) AS lo, max(x.k) AS hi');

    expect(one).toEqual([{ lo: 10 }]);
    expect((pair as { lo: unknown }[])[0].lo).toEqual((one as { lo: unknown }[])[0].lo);
  });

  test('an extremum over the START vertex is not folded per endpoint', () => {
    // The per-endpoint walk binds only `x`, so reading `a` must take the row walk. `s1` appears on
    // three rows and `s2` on one; the extremes are over the SOURCES, not the endpoints.
    expect(
      query(graph(), 'MATCH (a:P)-[:KNOWS]->(x) RETURN min(a.n) AS lo, max(a.n) AS hi'),
    ).toEqual([{ lo: 's1', hi: 's2' }]);
  });

  test('a start label NOT carried by every vertex declines to the row walk', () => {
    // `s1` loses the label, so `(a:P)` is no longer vacuous and the bucket-size reachability test
    // would be wrong: m1 and m3 are reached ONLY from s1. Correct answer is m2 alone.
    const narrowed = NDJSON.replace(
      '{"type":"node","id":"s1","labels":["P"],"properties":{"n":"s1","k":50}}',
      '{"type":"node","id":"s1","labels":["Q"],"properties":{"n":"s1","k":50}}',
    );
    const g = deserialize(narrowed, 'ndjson', new Graph());

    expect(query(g, 'MATCH (a:P)-[:KNOWS]->(x) RETURN min(x.k) AS lo, max(x.k) AS hi')).toEqual([
      { lo: 20, hi: 20 },
    ]);
  });

  test('a far LABEL still filters the endpoints', () => {
    // m2 keeps the label, m1/m3 lose it, so a labelled far end answers 20/20 rather than 10/30.
    const relabelled = NDJSON.replace(
      '{"type":"node","id":"m1","labels":["P"],"properties":{"n":"m1","k":10}}',
      '{"type":"node","id":"m1","labels":["P","R"],"properties":{"n":"m1","k":10}}',
    );
    const g = deserialize(relabelled, 'ndjson', new Graph());

    expect(query(g, 'MATCH (a:P)-[:KNOWS]->(x:R) RETURN min(x.k) AS lo, max(x.k) AS hi')).toEqual([
      { lo: 10, hi: 10 },
    ]);
  });

  test('a hop matching nothing still answers one row of nulls', () => {
    // `finish` over an untouched accumulator, which is the general path's answer too.
    expect(
      query(graph(), 'MATCH (a:P)-[:NOSUCH]->(x) RETURN min(x.k) AS lo, max(x.k) AS hi'),
    ).toEqual([{ lo: null, hi: null }]);
  });
});

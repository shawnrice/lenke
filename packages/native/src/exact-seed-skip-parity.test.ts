// Byte-identity for the EXACT-SEED skip — item 1607, where a seeded count stops re-validating.
//
// ⚠️ THE RISK IS THE LABEL, which is why this fixture shares `team` values ACROSS labels: a value
// bucket for `t1` holds `User`s, `Admin`s and both-labelled vertices, so a skip that dropped the
// label test would over-count and a same-label fixture could never see it. Item 149 names that as
// the first of the two risks of seeking at all.
//
// No fuzzer covers it: `differential-fuzz` builds no property INDEX, and the index is what creates
// the seeded route this item changes. So the TS-vs-native check has to be written out.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { deserialize as tsDeserialize } from '@lenke/serialization';

import { nativeBackend, nativeReady } from './conformance-harness.js';
import { graphFromNdjson } from './graph.js';

/** Labels by index, so each `team` value spans several labels — see the block comment. */
const labelsFor = (i: number): string[] => {
  if (i % 3 === 0) {
    return ['Admin'];
  }

  return i % 3 === 1 ? ['User'] : ['User', 'Admin'];
};

/** 12 vertices: team = t<i % 3>, n = i, labels cycling so each team value spans labels. */
const NDJSON = Array.from({ length: 12 }, (_, i) => {
  const labels = labelsFor(i);
  const props: Record<string, unknown> = { team: `t${i % 3}`, n: i };

  if (i % 5 === 0) {
    props.flag = true;
  }

  return JSON.stringify({
    type: 'node',
    id: String(i + 1),
    labels,
    properties: props,
  });
}).join('\n');

const suite = nativeReady ? describe : describe.skip;

suite('an exact seed skipping re-validation: TS vs native', () => {
  const backend = nativeBackend();
  const nativeGraph = graphFromNdjson(backend, NDJSON);
  const tsGraph = tsDeserialize(NDJSON, 'ndjson', new Graph());

  for (const key of ['team', 'n']) {
    tsGraph.createIndex({ on: 'vertex', kind: 'hash', keys: [key] });
    nativeGraph.createIndex({ on: 'vertex', kind: 'hash', keys: [key] });
  }

  const QUERIES: readonly [string, Record<string, unknown>][] = [
    // Exact, labelled — the bucket spans labels, so the label test is load-bearing.
    ['MATCH (u:User) WHERE u.team = $v RETURN count(*) AS c', { v: 't1' }],
    ['MATCH (u:Admin) WHERE u.team = $v RETURN count(*) AS c', { v: 't1' }],
    ['MATCH (u:User&Admin) WHERE u.team = $v RETURN count(*) AS c', { v: 't1' }],
    ['MATCH (u:User|Admin) WHERE u.team = $v RETURN count(*) AS c', { v: 't1' }],
    ['MATCH (u:!Admin) WHERE u.team = $v RETURN count(*) AS c', { v: 't1' }],
    // Exact, unlabelled.
    ['MATCH (u) WHERE u.team = $v RETURN count(*) AS c', { v: 't1' }],
    // Exact, the inline spelling.
    ['MATCH (u:User {team: $v}) RETURN count(*) AS c', { v: 't1' }],
    // Exact on a UNIQUE key, and on a value nothing holds.
    ['MATCH (u:User) WHERE u.n = $v RETURN count(*) AS c', { v: 4 }],
    ['MATCH (u:User) WHERE u.n = $v RETURN count(*) AS c', { v: 3 }],
    ['MATCH (u:User) WHERE u.team = $v RETURN count(*) AS c', { v: 'nope' }],
    // NOT exact: a second conjunct, an ordering, a membership, a null test.
    ['MATCH (u:User) WHERE u.team = $v AND u.flag = true RETURN count(*) AS c', { v: 't1' }],
    ['MATCH (u:User) WHERE u.n > $v RETURN count(*) AS c', { v: 5 }],
    ['MATCH (u:User) WHERE u.team IN [$v] RETURN count(*) AS c', { v: 't1' }],
    ['MATCH (u:User) WHERE u.flag IS NULL RETURN count(*) AS c', {}],
    // The ROWS spelling of the exact shape, which does not take the tally at all.
    ['MATCH (u:User) WHERE u.team = $v RETURN u.n AS n', { v: 't1' }],
  ];

  for (const [text, params] of QUERIES) {
    test(`${text}${Object.keys(params).length > 0 ? ` ${JSON.stringify(params)}` : ''}`, () => {
      expect(JSON.stringify(tsQuery(tsGraph, text, params))).toBe(
        JSON.stringify(nativeGraph.query(text, params)),
      );
    });
  }

  test('and both answer the hand-counted numbers', () => {
    /**
     * 12 vertices, `team = t<i % 3>`, labels by `i % 3` — so every `t1` vertex has `i % 3 === 1`
     * and is therefore EXACTLY the `[User]`-only population. Four of them (i = 1, 4, 7, 10).
     * `Admin` and `t1` share no vertex at all, which is the sharpest form of the label test: an
     * exact seed that skipped it would answer 4 instead of 0.
     */
    const pairs: readonly [string, Record<string, unknown>, number][] = [
      ['MATCH (u) WHERE u.team = $v RETURN count(*) AS c', { v: 't1' }, 4],
      ['MATCH (u:User) WHERE u.team = $v RETURN count(*) AS c', { v: 't1' }, 4],
      ['MATCH (u:Admin) WHERE u.team = $v RETURN count(*) AS c', { v: 't1' }, 0],
      ['MATCH (u:User&Admin) WHERE u.team = $v RETURN count(*) AS c', { v: 't1' }, 0],
      ['MATCH (u) WHERE u.team = $v RETURN count(*) AS c', { v: 't2' }, 4],
      ['MATCH (u:Admin) WHERE u.team = $v RETURN count(*) AS c', { v: 't2' }, 4],
      ['MATCH (u:User) WHERE u.n = $v RETURN count(*) AS c', { v: 4 }, 1],
      ['MATCH (u:User) WHERE u.n = $v RETURN count(*) AS c', { v: 3 }, 0],
    ];

    for (const [text, params, want] of pairs) {
      expect(Number((tsQuery(tsGraph, text, params)[0] as { c: unknown }).c)).toBe(want);
      expect(Number((nativeGraph.query(text, params)[0] as unknown as { c: unknown }).c)).toBe(
        want,
      );
    }
  });
});

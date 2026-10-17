// `VALUE { … RETURN <agg>(x) }` — a correlated scalar subquery whose RETURN is an aggregate.
//
// The native engine PANICKED on this (`index out of bounds` inside `Batch::slot`, surfacing as
// `E_INVALID_VALUE: query evaluation panicked`) while the TS engine answered it, so the two
// disagreed on every shape below. Item 498 found it while pricing the subquery enum, not from a
// failing test: the GQL corpus covers `VALUE { … RETURN count(*) }` and `VALUE { … RETURN b.name }`
// and nothing in between, and the differential fuzzer does not generate the form at all.
//
// Its own file rather than a corpus line, because the corpus is a frozen single-engine snapshot
// — what was missing here is the statement that the two engines AGREE, which only a differential
// can make.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { deserialize as tsDeserialize } from '@lenke/serialization';

import { nativeBackend, nativeReady } from './conformance-harness.js';
import { graphFromNdjson } from './graph.js';

const NDJSON = [
  '{"type":"node","id":"a","labels":["P"],"properties":{"age":1}}',
  '{"type":"node","id":"b","labels":["P"],"properties":{"age":5}}',
  '{"type":"node","id":"c","labels":["P"],"properties":{"age":9}}',
  // `d` has an edge to a node with NO `age`, so the group is non-empty but all-null — a
  // different case from the empty group that `b` and `c` give.
  '{"type":"node","id":"d","labels":["P"],"properties":{"age":2}}',
  '{"type":"node","id":"n","labels":["P"],"properties":{}}',
  '{"type":"edge","id":"e1","labels":["T"],"from":"a","to":"b","properties":{}}',
  '{"type":"edge","id":"e2","labels":["T"],"from":"a","to":"c","properties":{}}',
  '{"type":"edge","id":"e3","labels":["T"],"from":"d","to":"n","properties":{}}',
].join('\n');

const suite = nativeReady ? describe : describe.skip;

suite('VALUE { … RETURN <agg>(…) }: the TS and native engines agree', () => {
  const nativeGraph = graphFromNdjson(nativeBackend(), NDJSON);
  const tsGraph = tsDeserialize(NDJSON, 'ndjson', new Graph());

  const codeOf = (e: unknown): string => (e as { code?: string } | undefined)?.code ?? 'NO_CODE';

  const outcome = (engine: 'ts' | 'native', q: string): string => {
    try {
      const r = (engine === 'ts' ? tsQuery(tsGraph, q) : nativeGraph.query(q)) as unknown[];

      return `ok [${[...r]
        .map((x) => JSON.stringify(x))
        .sort()
        .join('|')}]`;
    } catch (e) {
      return `ERR ${codeOf(e)}`;
    }
  };

  const agree = (q: string): string => {
    const ts = outcome('ts', q);
    const nat = outcome('native', q);

    expect(`${q}\n  ${ts}`).toBe(`${q}\n  ${nat}`);

    return ts;
  };

  const forAgg = (f: string) =>
    `MATCH (u:P) RETURN u.age AS a, VALUE { MATCH (u)-[:T]->(x) RETURN ${f}(x.age) } AS m ORDER BY a`;

  test('every reducing aggregate agrees, over a group that is full, empty and all-null', () => {
    // `a` has two aged neighbours; `d` has one with no `age`; `b`, `c` and `n` have none.
    expect(agree(forAgg('max'))).toContain('"m":9');
    expect(agree(forAgg('min'))).toContain('"m":5');
    expect(agree(forAgg('sum'))).toContain('"m":14');
    expect(agree(forAgg('avg'))).toContain('"m":7');
  });

  test('`count(*)` keeps its own lowering and still agrees', () => {
    expect(
      agree(
        'MATCH (u:P) RETURN u.age AS a, VALUE { MATCH (u)-[:T]->(x) RETURN count(*) } AS m ORDER BY a',
      ),
    ).toContain('"m":2');
  });

  test('a plain scalar RETURN is unchanged', () => {
    agree('MATCH (u:P) RETURN u.age AS a, VALUE { MATCH (u)-[:T]->(x) RETURN x.age } AS m');
  });

  // The three forms native REFUSES. Each one PANICKED before item 498 (the hoisted aggregate
  // indexed a slot the outer batch does not have), so a refusal is already the improvement; this
  // records which of them the TS engine still answers, because that is an OPEN divergence and
  // not a thing to discover twice.
  test('the refused forms are refused, and the remaining divergence is recorded', () => {
    const refused = [
      'MATCH (u:P) RETURN VALUE { MATCH (u)-[:T]->(x) RETURN max(DISTINCT x.age) } AS m',
      'MATCH (u:P) RETURN VALUE { MATCH (u)-[:T]->(x) RETURN max(x.age) + 1 } AS m',
      'MATCH (u:P) RETURN VALUE { MATCH (u)-[:T]->(x) RETURN collect(x.age) } AS m',
    ];

    for (const q of refused) {
      expect(outcome('native', q)).toStartWith('ERR');
    }

    // What TS does with each, verbatim. When native grows `DISTINCT` in a subquery aggregate
    // (it needs a field on `Expr::AggSubquery`), this is the line that should start agreeing.
    expect(refused.map((q) => outcome('ts', q).slice(0, 2))).toEqual(['ok', 'ok', 'ok']);
  });
});

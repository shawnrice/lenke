// Item 549 drops a vacuous `ORDER BY` / `OFFSET 0` STATEMENT standing in front of the projection.
// BOTH engines had the cliff (0.00 vs 126.60 ms in TS, 0.01 vs 10.07 in native), so the rewrite's
// correctness argument is the same on both sides and every shape below is asked of both: the
// dropped ones, the four refusals, and the faulting key that must keep raising.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { deserialize as tsDeserialize } from '@lenke/serialization';

import { nativeBackend, nativeReady } from './conformance-harness.js';
import { graphFromNdjson } from './graph.js';

const NDJSON = [
  '{"type":"node","id":"a","labels":["P"],"properties":{"n":1}}',
  '{"type":"node","id":"b","labels":["P"],"properties":{"n":2}}',
  '{"type":"node","id":"c","labels":["P"],"properties":{"n":3}}',
].join('\n');

const suite = nativeReady ? describe : describe.skip;

suite('a vacuous ORDER BY / OFFSET statement: the two engines agree (item 549)', () => {
  const nativeGraph = graphFromNdjson(nativeBackend(), NDJSON);
  const tsGraph = tsDeserialize(NDJSON, 'ndjson', new Graph());

  const bag = (rows: unknown[]): string =>
    JSON.stringify([...rows].map((r) => JSON.stringify(r)).sort());

  const agree = (q: string, want: string): void => {
    expect(`${q}\n  ${bag(tsQuery(tsGraph, q) as unknown[])}`).toBe(
      `${q}\n  ${bag(nativeGraph.query(q) as unknown[])}`,
    );
    expect(bag(tsQuery(tsGraph, q) as unknown[])).toBe(want);
  };

  /** An ORDERED result: compared as a SEQUENCE, since the statement is what orders it. */
  const agreeOrdered = (q: string, want: readonly Record<string, unknown>[]): void => {
    expect(JSON.stringify(tsQuery(tsGraph, q))).toBe(JSON.stringify(want));
    expect(JSON.stringify(nativeGraph.query(q))).toBe(JSON.stringify(want));
  };

  test('the dropped spellings', () => {
    agree('MATCH (n:P) RETURN count(*) AS c', '["{\\"c\\":3}"]');
    agree('MATCH (n:P) OFFSET 0 RETURN count(*) AS c', '["{\\"c\\":3}"]');
    agree('MATCH (n:P) ORDER BY n.n RETURN count(*) AS c', '["{\\"c\\":3}"]');
    agree('MATCH (n:P) ORDER BY n.n DESC RETURN count(*) AS c', '["{\\"c\\":3}"]');
    agree('MATCH (n:P) ORDER BY n.n OFFSET 0 RETURN count(*) AS c', '["{\\"c\\":3}"]');
    agree('MATCH (n:P) ORDER BY n.n RETURN max(n.n) AS m', '["{\\"m\\":3}"]');
    agree('MATCH (n:P) ORDER BY n.missing RETURN count(*) AS c', '["{\\"c\\":3}"]');
    agree(
      'MATCH (n:P) ORDER BY n.n RETURN count(*) AS c, max(n.n) + 1 AS m',
      '["{\\"c\\":3,\\"m\\":4}"]',
    );
  });

  test('the refusals, where the clause changes the answer', () => {
    agree('MATCH (n:P) ORDER BY n.n LIMIT 2 RETURN count(*) AS c', '["{\\"c\\":2}"]');
    agree('MATCH (n:P) OFFSET 1 RETURN count(*) AS c', '["{\\"c\\":2}"]');
    agree('MATCH (n:P) ORDER BY n.n LIMIT 1 RETURN max(n.n) AS m', '["{\\"m\\":1}"]');
    agree('MATCH (n:P) ORDER BY n.n DESC LIMIT 1 RETURN max(n.n) AS m', '["{\\"m\\":3}"]');
    // `collect` READS the order, so the two directions must stay different in both engines.
    agreeOrdered('MATCH (n:P) ORDER BY n.n RETURN collect(n.n) AS m', [{ m: [1, 2, 3] }]);
    agreeOrdered('MATCH (n:P) ORDER BY n.n DESC RETURN collect(n.n) AS m', [{ m: [3, 2, 1] }]);
    agree('MATCH (n:P) ORDER BY n.n RETURN sum(n.n) AS s', '["{\\"s\\":6}"]');
  });

  test('a projection that is not one row keeps the statement that orders it', () => {
    agreeOrdered('MATCH (n:P) ORDER BY n.n DESC RETURN n.n AS k', [{ k: 3 }, { k: 2 }, { k: 1 }]);
    agreeOrdered('MATCH (n:P) ORDER BY n.n DESC RETURN n.n AS k, count(*) AS c', [
      { k: 3, c: 1 },
      { k: 2, c: 1 },
      { k: 1, c: 1 },
    ]);
  });

  test('a faulting sort key raises on both engines', () => {
    expect(() => tsQuery(tsGraph, 'MATCH (n:P) ORDER BY 1 / 0 RETURN count(*) AS c')).toThrow();
    expect(() => nativeGraph.query('MATCH (n:P) ORDER BY 1 / 0 RETURN count(*) AS c')).toThrow();
    // The control: a fault-free key on the same query is answered by both.
    agree('MATCH (n:P) ORDER BY n.n RETURN count(*) AS c', '["{\\"c\\":3}"]');
  });
});

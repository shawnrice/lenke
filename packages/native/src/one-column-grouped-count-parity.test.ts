// Byte-identity for the ONE-COLUMN GROUPED COUNT, which NO fuzzer generates (item 1582).
//
// ⚠️ WHY THIS FILE EXISTS RATHER THAN A FUZZER SEED. Item 1582 admitted
// `RETURN count(*) AS c GROUP BY n.k` — a grouped count that does not project its key — to the
// TS grouped-count tally, which changed WHICH COLUMNS the rung emits. That is exactly the kind
// of change byte-identity exists to catch, and `bun run fuzz` was green BEFORE this file was
// written while saying nothing about it: every fuzzer's grouped shape is the TWO-column
// `RETURN k, count(*) AS c GROUP BY k` (see `genQuery` in `backend-parity-fuzz`, and the
// `simpleGroup` counter in `differential-fuzz`). A green sweep over a shape nobody generates is
// the failure mode CLAUDE.md names: "a generative test whose teeth were never verified is worse
// than no test, because it is believed."
//
// So the shape gets explicit TS-vs-native coverage, compared IN COLUMN ORDER, because column
// order is bytes here even though row order is not.
import { describe, expect, test } from 'bun:test';

import { Graph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { deserialize as tsDeserialize } from '@lenke/serialization';

import { columnOrderOf, nativeBackend, nativeReady } from './conformance-harness.js';
import { graphFromNdjson } from './graph.js';

const NDJSON = [
  '{"type":"node","id":"1","labels":["P"],"properties":{"k":"a","n":1}}',
  '{"type":"node","id":"2","labels":["P"],"properties":{"k":"b","n":2}}',
  '{"type":"node","id":"3","labels":["P"],"properties":{"k":"a","n":3}}',
  '{"type":"node","id":"4","labels":["P"],"properties":{"k":"c","n":4}}',
  '{"type":"node","id":"5","labels":["P"],"properties":{"k":"b","n":5}}',
  '{"type":"node","id":"6","labels":["P"],"properties":{"k":"a","n":6}}',
  // A node with NO `k` at all, so the missing-property group is covered.
  '{"type":"node","id":"7","labels":["P"],"properties":{"n":7}}',
  // An explicit null `k`, which must land in the SAME group as the missing one.
  '{"type":"node","id":"8","labels":["P"],"properties":{"k":null,"n":8}}',
  '{"type":"node","id":"9","labels":["Q"],"properties":{"k":"a","n":9}}',
  '{"type":"edge","id":"e1","labels":["R"],"from":"1","to":"2","properties":{"w":1}}',
  '{"type":"edge","id":"e2","labels":["R"],"from":"1","to":"3","properties":{"w":2}}',
  '{"type":"edge","id":"e3","labels":["R"],"from":"2","to":"3","properties":{"w":3}}',
  '{"type":"edge","id":"e4","labels":["R"],"from":"3","to":"4","properties":{"w":4}}',
].join('\n');

const suite = nativeReady ? describe : describe.skip;

suite('one-column grouped count: TS vs native', () => {
  const backend = nativeBackend();
  const nativeGraph = graphFromNdjson(backend, NDJSON);
  const tsGraph = tsDeserialize(NDJSON, 'ndjson', new Graph());

  const QUERIES = [
    // The two spellings item 1582 admitted, and the two-column form they must stay consistent
    // with. All three are the same question over the same scan.
    'MATCH (n:P) RETURN count(*) AS c GROUP BY n.k',
    'MATCH (n:P) LET a = n.k RETURN count(*) AS c GROUP BY a',
    'MATCH (n:P) RETURN n.k AS a, count(*) AS c GROUP BY n.k',
    // Unlabelled, so the scan is every vertex.
    'MATCH (n) RETURN count(*) AS c GROUP BY n.k',
    // The filters, both spellings — these compose with the rung's gate.
    "MATCH (n:P) WHERE n.k <> 'c' RETURN count(*) AS c GROUP BY n.k",
    "MATCH (n:P {k: 'a'}) RETURN count(*) AS c GROUP BY n.k",
    'MATCH (n:P) WHERE n.n > 3 RETURN count(*) AS c GROUP BY n.k',
    // The window, which rides along on the tally's own rows.
    'MATCH (n:P) RETURN count(*) AS c GROUP BY n.k LIMIT 2',
    'MATCH (n:P) RETURN count(*) AS c GROUP BY n.k SKIP 1 LIMIT 2',
    // Grouping by a NUMERIC key, so every row is its own group.
    'MATCH (n:P) RETURN count(*) AS c GROUP BY n.n',
    // HAVING, which is a SELECT-spelling clause and not a RETURN one.
    'SELECT count(*) AS c FROM MATCH (n:P) GROUP BY n.k HAVING count(*) > 1',
    // ORDER BY, which the one-column rung DECLINES — so this pair pins that the general path
    // still agrees with native, which is what "declining" has to mean.
    'MATCH (n:P) RETURN count(*) AS c GROUP BY n.k ORDER BY c',
    'MATCH (n:P) RETURN count(*) AS c GROUP BY n.k ORDER BY c DESC',
    // The HOP twin, which shares `groupedProjection` and so was admitted by the same change.
    'MATCH (a:P)-[:R]->(b) RETURN count(*) AS c GROUP BY b.k',
    'MATCH (a:P)-[:R]->(b) RETURN count(*) AS c GROUP BY a.k',
    'MATCH (a:P)-[:R]->(b) LET x = b.k RETURN count(*) AS c GROUP BY x',
    'MATCH (a:P)-[:R]->(b) RETURN b.k AS x, count(*) AS c GROUP BY b.k',
    // Shapes that must NOT be captured by the new gate.
    'MATCH (n:P) RETURN count(*) AS c',
    'MATCH (n:P) RETURN count(DISTINCT n.k) AS c GROUP BY n.k',
    'MATCH (n:P) RETURN n.k AS a GROUP BY n.k',
  ];

  for (const q of QUERIES) {
    test(q, () => {
      const ts = tsQuery(tsGraph, q) as Array<Record<string, unknown>>;
      const nat = nativeGraph.query(q) as Array<Record<string, unknown>>;

      // ⚠️ Compared as MULTISETS of rows, because unordered row order is unspecified in this
      // engine and deliberately so — but COLUMN order is bytes, so it is asserted exactly.
      // `columnOrderOf` reads the first row's key sequence out of a JSON STRING, which is the
      // form the differential fuzzer hands it (`ts.json`), so both sides are stringified here.
      expect(columnOrderOf(JSON.stringify(ts))).toEqual(columnOrderOf(JSON.stringify(nat)));
      expect([...ts].map((r) => JSON.stringify(r)).sort()).toEqual(
        [...nat].map((r) => JSON.stringify(r)).sort(),
      );
      // And the row COUNT, so a path that silently dropped or duplicated a group cannot pass by
      // having the same distinct rows.
      expect(ts.length).toBe(nat.length);
    });
  }

  // ⚠️⚠️ A WRONG ANSWER IN THE RUST ENGINE, found by this file and PRE-EXISTING — item 1582 did
  // not cause it and does not fix it.
  //
  //     SELECT count(*) AS c FROM MATCH (n:P) GROUP BY n.k
  //         ts   [{"c":2},{"c":1},{"c":1}]     3 groups, correct
  //         nat  [{"c":4}]                     ONE group: the GROUP BY is dropped
  //
  // Native drops the grouping exactly when the form is SELECT, the grouping key is NOT in the
  // select list, and there is no HAVING. Each of those matters: the `RETURN` spelling of the same
  // question agrees, adding `HAVING count(*) >= 1` makes native correct, and the two-column
  // SELECT agrees. Per ISO a select list holding only an aggregate still yields one row per
  // group, so TS is right and native is wrong.
  //
  // THAT IT PREDATES THIS CHANGE IS MEASURED, not assumed: `ORDER BY` declines item 1582's rung,
  // so `… GROUP BY n.k ORDER BY c` runs the TS GENERAL path — the code that answered this shape
  // before the change — and it diverges identically. (`select-group-probe-1582.mjs` prints the
  // five-way comparison.)
  //
  // NOT REGISTERED, deliberately. `divergence-registry` refuses a `value` axis on purpose: "if
  // the engines disagree about the answer to a determinate question, that is a bug in one of
  // them, and no entry may excuse it." So it is encoded as an EXPECTED FAILURE instead, which
  // documents it and turns red the moment native is fixed — rather than a skip, which would go
  // quiet and stay quiet. Fixing it is Rust-side work and out of this item's scope.
  test.failing('native drops GROUP BY on an unprojected SELECT aggregate (pre-existing)', () => {
    const q = 'SELECT count(*) AS c FROM MATCH (n:P) GROUP BY n.k';
    const ts = tsQuery(tsGraph, q) as Array<Record<string, unknown>>;
    const nat = nativeGraph.query(q) as Array<Record<string, unknown>>;

    expect([...ts].map((r) => JSON.stringify(r)).sort()).toEqual(
      [...nat].map((r) => JSON.stringify(r)).sort(),
    );
  });

  // The same shape with HAVING, which native answers CORRECTLY — the pair that localizes the bug
  // above to "no HAVING" rather than to the SELECT form in general.
  test('the same SELECT shape WITH having agrees, which localizes the bug', () => {
    const q = 'SELECT count(*) AS c FROM MATCH (n:P) GROUP BY n.k HAVING count(*) >= 1';
    const ts = tsQuery(tsGraph, q) as Array<Record<string, unknown>>;
    const nat = nativeGraph.query(q) as Array<Record<string, unknown>>;

    expect(ts.length).toBeGreaterThan(1);
    expect([...ts].map((r) => JSON.stringify(r)).sort()).toEqual(
      [...nat].map((r) => JSON.stringify(r)).sort(),
    );
  });
});

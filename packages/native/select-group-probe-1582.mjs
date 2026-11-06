// Is the SELECT-form divergence mine, or was it already there?
//
// `ORDER BY` DECLINES item 1582's rung, so it forces the TS general path — the same code that
// answered this shape before the change. If the general path and the new rung agree, TS's
// behaviour is unchanged by item 1582 and the disagreement is native's.
import { Graph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { deserialize as tsDeserialize } from '@lenke/serialization';

import { nativeBackend } from './src/conformance-harness.ts';
import { graphFromNdjson } from './src/graph.ts';

const NDJSON = [
  '{"type":"node","id":"1","labels":["P"],"properties":{"k":"a"}}',
  '{"type":"node","id":"2","labels":["P"],"properties":{"k":"b"}}',
  '{"type":"node","id":"3","labels":["P"],"properties":{"k":"a"}}',
  '{"type":"node","id":"4","labels":["P"],"properties":{"k":"c"}}',
].join('\n');

const nat = graphFromNdjson(nativeBackend(), NDJSON);
const ts = tsDeserialize(NDJSON, 'ndjson', new Graph());

const QS = [
  // The RETURN spelling, which the parity test says both engines agree on.
  'MATCH (n:P) RETURN count(*) AS c GROUP BY n.k',
  // The SELECT spelling, one column — the failing pair.
  'SELECT count(*) AS c FROM MATCH (n:P) GROUP BY n.k',
  // The same SELECT, with ORDER BY so item 1582's rung DECLINES and TS runs the general path.
  'SELECT count(*) AS c FROM MATCH (n:P) GROUP BY n.k ORDER BY c',
  // The same SELECT with HAVING, which the parity test says both engines agree on.
  'SELECT count(*) AS c FROM MATCH (n:P) GROUP BY n.k HAVING count(*) >= 1',
  // And the TWO-column SELECT, long supported by both.
  'SELECT n.k AS a, count(*) AS c FROM MATCH (n:P) GROUP BY n.k',
];

for (const q of QS) {
  const t = JSON.stringify(tsQuery(ts, q));
  let n;

  try {
    n = JSON.stringify(nat.query(q));
  } catch (e) {
    n = `THREW ${e.message}`;
  }

  console.log(`${t === n ? 'AGREE   ' : 'DIVERGE '} ts=${t}\n         nat=${n}\n         ${q}\n`);
}

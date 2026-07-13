import { Graph, parseDateTime } from '@lenke/core';
import { query } from '@lenke/gql';
const g = new Graph();
// two days, same hour-of-day 10
for (const ts of ['2026-07-01T10:15:00', '2026-07-02T10:45:00', '2026-07-01T14:00:00'])
  g.addVertex({ labels: ['R'], properties: { ts: parseDateTime(ts), v: 1 } });
const p = (l: string, q: string) => {
  try {
    console.log(l, 'OK', JSON.stringify(query(g, q)));
  } catch (e: any) {
    console.log(l, 'ERR', (e.message || '').split('\n')[0]);
  }
};
// hour-of-day = chars 12..13 of "2026-07-01T10:15:00"
p(
  'hour-of-day substring(s,12,2):',
  `MATCH (r:R) RETURN substring(to_string(r.ts),12,2) AS hod, count(r) AS c ORDER BY hod`,
);
// arbitrary 4-hour bucket / 15-min tumbling window: no arithmetic path — confirm no floor-div on datetime
p(
  'epoch arithmetic attempt:',
  `MATCH (r:R) RETURN r.ts - DATETIME '1970-01-01T00:00:00' AS d LIMIT 1`,
);

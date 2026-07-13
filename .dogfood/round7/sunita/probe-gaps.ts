// Probe the known telemetry gaps + hunt silent-wrong-result hazards.
import { Graph, parseDateTime } from '@lenke/core';
import { query } from '@lenke/gql';

const p = (l: string, q: string, params?: any) => {
  try {
    console.log(l, 'OK', JSON.stringify(query(new Graph(), q, params)));
  } catch (e: any) {
    console.log(l, 'ERR', (e.message || '').split('\n')[0]);
  }
};

console.log('--- GAP: date-part extraction functions (expect all ERR/unknown-fn) ---');
p('extract:', `RETURN extract(HOUR FROM DATETIME '2026-07-01T10:00:00') AS x`);
p('date_trunc:', `RETURN date_trunc('hour', DATETIME '2026-07-01T10:00:00') AS x`);
p('hour():', `RETURN hour(DATETIME '2026-07-01T10:00:00') AS x`);
p('year():', `RETURN year(DATE '2026-07-01') AS x`);
p('.hour prop:', `RETURN (DATETIME '2026-07-01T10:00:00').hour AS x`);
p('datetime.epochSeconds:', `RETURN (DATETIME '2026-07-01T10:00:00').epochSeconds AS x`);

console.log('\n--- GAP: duration -> number (rate math) ---');
p(
  'dur as number *:',
  `RETURN duration_between(DATETIME '2026-07-01T00:00:00', DATETIME '2026-07-01T02:00:00') * 1 AS x`,
);
p(
  'seconds from dur:',
  `RETURN seconds(duration_between(DATETIME '2026-07-01T00:00:00', DATETIME '2026-07-01T02:00:00')) AS x`,
);
p(
  'to_string(dur):',
  `RETURN to_string(duration_between(DATETIME '2026-07-01T00:00:00', DATETIME '2026-07-01T02:00:00')) AS x`,
);
p(
  'dur / dur:',
  `RETURN duration_between(DATETIME '2026-07-01T00:00:00', DATETIME '2026-07-01T02:00:00') / DURATION 'PT1H' AS x`,
);

console.log('\n--- GAP: no percentile/median aggregate ---');
p('percentile_cont:', `MATCH (n) RETURN percentile_cont(n.v, 0.5) AS x`);
p('median:', `MATCH (n) RETURN median(n.v) AS x`);

console.log('\n--- HAZARD: string-typed timestamp silently nulls comparisons ---');
{
  const g = new Graph();
  // stored as STRING (forgot date()/datetime() conversion)
  g.addVertex({ labels: ['R'], properties: { ts: '2026-07-01T10:00:00', v: 5 } });
  g.addVertex({ labels: ['R'], properties: { ts: '2026-07-01T08:00:00', v: 3 } });
  // proper DATETIME
  const g2 = new Graph();
  g2.addVertex({ labels: ['R'], properties: { ts: parseDateTime('2026-07-01T10:00:00'), v: 5 } });
  g2.addVertex({ labels: ['R'], properties: { ts: parseDateTime('2026-07-01T08:00:00'), v: 3 } });

  const q = `MATCH (r:R) WHERE r.ts >= DATETIME '2026-07-01T09:00:00' RETURN count(r) AS c`;
  console.log('string-ts window count (expect 1, HAZARD if 0):', JSON.stringify(query(g, q)));
  console.log('datetime-ts window count (expect 1):', JSON.stringify(query(g2, q)));
  // does string vs DATETIME even error, or silently drop?
  console.log(
    'string>=datetime scalar:',
    JSON.stringify(query(g, `MATCH (r:R) RETURN r.ts >= DATETIME '2026-07-01T09:00:00' AS cmp`)),
  );
  // workaround: convert at query time
  console.log(
    'workaround datetime(r.ts):',
    JSON.stringify(
      query(
        g,
        `MATCH (r:R) WHERE datetime(r.ts) >= DATETIME '2026-07-01T09:00:00' RETURN count(r) AS c`,
      ),
    ),
  );
}

console.log('\n--- HAZARD: string-prefix bucketing across sub-second / precision drift ---');
{
  const g = new Graph();
  // one reading with sub-second, one without — same hour, do buckets still merge?
  g.addVertex({ labels: ['R'], properties: { ts: parseDateTime('2026-07-01T10:15:00'), v: 1 } });
  g.addVertex({ labels: ['R'], properties: { ts: parseDateTime('2026-07-01T10:45:00.5'), v: 2 } });
  console.log(
    'to_string of each:',
    JSON.stringify(query(g, `MATCH (r:R) RETURN to_string(r.ts) AS s ORDER BY r.ts`)),
  );
  console.log(
    'hour buckets (expect single 2026-07-01T10):',
    JSON.stringify(
      query(
        g,
        `MATCH (r:R) RETURN substring(to_string(r.ts),1,13) AS hr, count(r) AS c ORDER BY hr`,
      ),
    ),
  );
}

console.log('\n--- REGRESSION recheck ---');
const now = { __now: parseDateTime('2026-07-12T10:30:45') };
p('current_timestamp DATETIME now:', `RETURN current_timestamp AS d`, now);
p('DURATION P10D * 1.5:', `RETURN DURATION 'P10D' * 1.5 AS d`);
p('DURATION P10D * 2:', `RETURN DURATION 'P10D' * 2 AS d`);

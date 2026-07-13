import { Graph, parseDate, parseDateTime } from '@lenke/core';
import { query } from '@lenke/gql';
const g = new Graph();
const now = { __now: parseDateTime('2026-07-12T10:30:45') };
const j = (r: any) => JSON.stringify(r, (_k, v) => (v && v.kind ? String(v) : v));
// string-typed date footgun: silent null / UNKNOWN, no error
g.addVertex({ labels: ['S'], properties: { d: '2019-02-01' } });
console.log(
  'duration_between(string, DATE) =>',
  j(query(g, `MATCH (n:S) RETURN duration_between(n.d, current_date) AS x`, now)),
);
console.log('string + duration =>', j(query(g, `MATCH (n:S) RETURN (n.d + DURATION 'P5Y') AS x`)));
console.log('string < DATE =>', j(query(g, `MATCH (n:S) RETURN (n.d < DATE '2020-01-01') AS x`)));
console.log('date(string) convert =>', j(query(g, `MATCH (n:S) RETURN date(n.d) AS x`)));
console.log(
  'duration_between(date(string), DATE) =>',
  j(query(g, `MATCH (n:S) RETURN duration_between(date(n.d), current_date) AS x`, now)),
);

// Now proper DATE-typed: verify age arithmetic
const g2 = new Graph();
const v = g2.addVertex({ labels: ['E'], properties: {} });
v.setProperty('bd', parseDate('1990-03-15'));
v.setProperty('hire', parseDate('2019-02-01'));
console.log('\n--- proper DATE typed ---');
console.log(
  'bd + P40Y <= today =>',
  j(query(g2, `MATCH (e:E) RETURN (e.bd + DURATION 'P40Y' <= current_date) AS x`, now)),
); // 1990+40=2030 > 2026 => false (36yo)
console.log(
  'bd + P36Y <= today =>',
  j(query(g2, `MATCH (e:E) RETURN (e.bd + DURATION 'P36Y' <= current_date) AS x`, now)),
); // 2026-03-15 <= 2026-07-12 => true
console.log(
  'hire tenure days =>',
  j(query(g2, `MATCH (e:E) RETURN duration_between(e.hire, current_date) AS x`, now)),
);
console.log(
  'hire + P5Y <= today =>',
  j(query(g2, `MATCH (e:E) RETURN (e.hire + DURATION 'P5Y' <= current_date) AS x`, now)),
); // 2024-02-01 <= 2026-07-12 true
// age in years via subtracting: try duration(months) approach
console.log(
  'duration_between then is it days? =>',
  j(query(g2, `MATCH (e:E) RETURN to_string(duration_between(e.bd, current_date)) AS x`, now)),
);

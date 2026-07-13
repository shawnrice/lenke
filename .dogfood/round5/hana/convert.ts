import { parseDate, parseDateTime, Duration } from '@lenke/core';
import { query } from '@lenke/gql';

import { buildGraph } from './build-data';
const g = buildGraph();
const now = { __now: parseDateTime('2026-07-12T10:30:45') };
const j = (r: any) => JSON.stringify(r, (_k, v) => (v && v.kind ? String(v) : v), 2);

// Documented bulk conversion path: SET n.k = date(n.k). Convert all string dates.
query(g, `MATCH (e:Employee) SET e.birthdate = date(e.birthdate), e.hired = date(e.hired)`);
query(g, `MATCH (a:Assignment) SET a.vfrom = date(a.vfrom), a.vto = date(a.vto)`);
query(g, `MATCH (c:Comp) SET c.vfrom = date(c.vfrom), c.vto = date(c.vto)`);
// ttfrom/ttto stored as strings for random emps -> datetime
query(g, `MATCH (a:Assignment) SET a.ttfrom = datetime(a.ttfrom)`);
query(g, `MATCH (c:Comp) SET c.ttfrom = datetime(c.ttfrom)`);

// Sanity: did date(null) on Priya's open vto stay null, and did already-DATE values survive re-conversion?
console.log(
  'Priya assignments after convert:',
  j(
    query(
      g,
      `MATCH (e:Employee)-[:HAS_ASSIGNMENT]->(a:Assignment) WHERE e.name='Priya Sharma' RETURN a.vfrom AS vfrom, a.vto AS vto ORDER BY a.vfrom`,
    ),
  ),
);

// Q2 real tenure now
const tenure = query(
  g,
  `MATCH (e:Employee)-[:HAS_ASSIGNMENT]->(a:Assignment)-[:AS_POSITION]->(p:Position)
  WHERE a.vto IS NULL AND a.ttto IS NULL
  RETURN e.name AS name, p.title AS title, duration_between(a.vfrom, current_date) AS tenure
  ORDER BY duration_between(a.vfrom, current_date) DESC LIMIT 5`,
  now,
);
console.log('\nQ2 longest current tenures:', j(tenure));
for (const r of tenure as any[]) {
  const d = r.tenure as Duration;
  console.log(`   ${r.name}: ${d?.days}d ~= ${(d.days / 365.25).toFixed(1)}y`);
}

// Q3 anniversaries next 30d
const anniv = query(
  g,
  `MATCH (e:Employee)
  WHERE substring(to_string(e.hired),6,5) >= substring(to_string(current_date),6,5)
    AND substring(to_string(e.hired),6,5) <= substring(to_string(current_date + DURATION 'P30D'),6,5)
  RETURN count(*) AS n`,
  now,
);
console.log('\nQ3 anniversaries next 30d count:', j(anniv));

// Q5 age filter now works
console.log(
  '\nQ5b employees >=40y (birthdate + P40Y <= today):',
  j(
    query(
      g,
      `MATCH (e:Employee) WHERE (e.birthdate + DURATION 'P40Y') <= current_date RETURN count(*) AS n`,
      now,
    ),
  ),
);

// Q6b tenure>5y current role now works
console.log(
  'Q6b current-role tenure >5y:',
  j(
    query(
      g,
      `MATCH (e:Employee)-[:HAS_ASSIGNMENT]->(a:Assignment) WHERE a.vto IS NULL AND (a.vfrom + DURATION 'P5Y') <= current_date RETURN count(*) AS n`,
      now,
    ),
  ),
);

// Verify: does SET x = date(x) on an ALREADY-date value work (idempotent)? Priya's were DATE.
console.log(
  '\nidempotent re-convert (Priya vfrom still valid):',
  j(
    query(
      g,
      `MATCH (e:Employee)-[:HAS_ASSIGNMENT]->(a:Assignment) WHERE e.name='Priya Sharma' RETURN duration_between(a.vfrom, current_date) AS t ORDER BY a.vfrom LIMIT 1`,
      now,
    ),
  ),
);

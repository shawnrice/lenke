// Narrative HRIS queries against the bitemporal graph. Each is verified by hand.
import { parseDateTime, Duration } from '@lenke/core';
import { query } from '@lenke/gql';

import { buildGraph } from './build-data';

const g = buildGraph();
const NOW = parseDateTime('2026-07-12T10:30:45');
const now = { __now: NOW };

const show = (label: string, rows: unknown) =>
  console.log(
    `\n### ${label}\n` + JSON.stringify(rows, (_k, v) => (v && (v as any).kind ? String(v) : v), 2),
  );

// ---------------------------------------------------------------------------
// Q1. "What was Priya's department and salary as of 2023-06-01?" (valid-time)
//     Current belief (transaction-time = now => ttto IS NULL).
//     Expected: dept Engineering, position Senior Engineer, salary 158000 (corrected).
// ---------------------------------------------------------------------------
show(
  'Q1 as-of valid 2023-06-01 (current belief)',
  query(
    g,
    `MATCH (e:Employee)-[:HAS_ASSIGNMENT]->(a:Assignment)-[:AS_POSITION]->(p:Position),
           (a)-[:IN_DEPT]->(d:Department),
           (e)-[:HAS_COMP]->(c:Comp)
     WHERE e.name = 'Priya Sharma'
       AND a.vfrom <= $asof AND (a.vto IS NULL OR $asof < a.vto)
       AND c.vfrom <= $asof AND (c.vto IS NULL OR $asof < c.vto)
       AND c.ttto IS NULL
     RETURN d.name AS dept, p.title AS title, c.salary AS salary`,
    { asof: (await import('@lenke/core')).parseDate('2023-06-01') },
  ),
);

// ---------------------------------------------------------------------------
// Q1b. Same as-of valid-time, but "as recorded on 2024-01-01" (before the
//      correction). Expected salary 150000 (the pre-correction belief).
// ---------------------------------------------------------------------------
const { parseDate } = await import('@lenke/core');
show(
  'Q1b as-of valid 2023-06-01, as-recorded 2024-01-01 (pre-correction)',
  query(
    g,
    `MATCH (e:Employee)-[:HAS_COMP]->(c:Comp)
     WHERE e.name = 'Priya Sharma'
       AND c.vfrom <= $asof AND (c.vto IS NULL OR $asof < c.vto)
       AND c.ttfrom <= $asrec AND (c.ttto IS NULL OR $asrec < c.ttto)
     RETURN c.salary AS salary`,
    { asof: parseDate('2023-06-01'), asrec: parseDateTime('2024-01-01T00:00:00') },
  ),
);

// ---------------------------------------------------------------------------
// Q2. Current role tenure for currently-employed people (vto IS NULL).
//     tenure = duration_between(vfrom, current_date). Duration -> read .days in JS.
// ---------------------------------------------------------------------------
const tenureRows = query(
  g,
  `MATCH (e:Employee)-[:HAS_ASSIGNMENT]->(a:Assignment)-[:AS_POSITION]->(p:Position)
   WHERE a.vto IS NULL AND a.ttto IS NULL
   RETURN e.name AS name, p.title AS title,
          duration_between(a.vfrom, current_date) AS tenure
   ORDER BY e.name LIMIT 5`,
  now,
);
show('Q2 current-role tenure (first 5)', tenureRows);
// Convert to human years in JS (host-side date math, per README guidance).
for (const r of tenureRows as any[]) {
  const d = r.tenure as Duration;
  console.log(`   ${r.name}: ${d?.days} days ~= ${(d?.days / 365.25).toFixed(1)} yrs`);
}

// ---------------------------------------------------------------------------
// Q3. Work anniversary in the next 30 days. Hire month-day within [today, today+30d].
//     No date-part fns, so use substring(to_string(date),6,5) => 'MM-DD'.
//     Handle year wrap by comparing MM-DD windows.
// ---------------------------------------------------------------------------
const anniv = query(
  g,
  `MATCH (e:Employee)
   WHERE substring(to_string(e.hired), 6, 5) >= substring(to_string(current_date), 6, 5)
     AND substring(to_string(e.hired), 6, 5) <= substring(to_string(current_date + DURATION 'P30D'), 6, 5)
   RETURN e.name AS name, e.hired AS hired
   ORDER BY substring(to_string(e.hired), 6, 5) LIMIT 8`,
  now,
);
show('Q3 anniversaries in next 30d (naive MM-DD, no wrap)', anniv);

// ---------------------------------------------------------------------------
// Q4. Total tenure across ALL roles (sum of per-role durations).
//     Try sum(duration_between(...)) directly.
// ---------------------------------------------------------------------------
try {
  show(
    'Q4 total tenure via sum(duration) [expect: works?]',
    query(
      g,
      `MATCH (e:Employee)-[:HAS_ASSIGNMENT]->(a:Assignment)
       WHERE e.name = 'Priya Sharma'
       RETURN sum(duration_between(a.vfrom, coalesce(a.vto, current_date))) AS total`,
      now,
    ),
  );
} catch (e: any) {
  console.log('Q4 sum(duration) ERR:', e.code, e.message);
}
// Workaround: collect the durations and fold in JS.
const durs = query(
  g,
  `MATCH (e:Employee)-[:HAS_ASSIGNMENT]->(a:Assignment)
   WHERE e.name = 'Priya Sharma'
   RETURN collect_list(duration_between(a.vfrom, coalesce(a.vto, current_date))) AS ds`,
  now,
);
const list = (durs as any[])[0].ds as Duration[];
const totalDays = list.reduce((s, d) => s + d.days, 0);
console.log(
  `   Q4 workaround: total tenure ${totalDays} days ~= ${(totalDays / 365.25).toFixed(1)} yrs across ${list.length} roles`,
);

// ---------------------------------------------------------------------------
// Q5. Age from birthdate. duration_between(date,date) gives DAYS only.
//     In-query age-in-years is not directly expressible; show the failure and workaround.
// ---------------------------------------------------------------------------
show(
  'Q5 age as duration_between (days, not years)',
  query(
    g,
    `MATCH (e:Employee) WHERE e.name = 'Priya Sharma'
     RETURN duration_between(e.birthdate, current_date) AS age`,
    now,
  ),
);
// Workaround A: date arithmetic to check "is at least N years old".
show(
  'Q5b employees at least 40y old (via birthdate + P40Y <= today)',
  query(
    g,
    `MATCH (e:Employee)
     WHERE e.birthdate IS NOT NULL AND (e.birthdate + DURATION 'P40Y') <= current_date
     RETURN count(*) AS n`,
    now,
  ),
);

// ---------------------------------------------------------------------------
// Q6. "Tenure > 5 years" filter via duration relational comparison (docs: UNKNOWN).
// ---------------------------------------------------------------------------
show(
  'Q6a tenure>5y via duration comparison (expect: silently empty)',
  query(
    g,
    `MATCH (e:Employee)-[:HAS_ASSIGNMENT]->(a:Assignment)
     WHERE a.vto IS NULL AND duration_between(a.vfrom, current_date) > DURATION 'P5Y'
     RETURN count(*) AS n`,
    now,
  ),
);
show(
  'Q6b tenure>5y via date arithmetic (correct)',
  query(
    g,
    `MATCH (e:Employee)-[:HAS_ASSIGNMENT]->(a:Assignment)
     WHERE a.vto IS NULL AND (a.vfrom + DURATION 'P5Y') <= current_date
     RETURN count(*) AS n`,
    now,
  ),
);

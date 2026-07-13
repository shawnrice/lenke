import { parseDate, parseDateTime, Duration } from '@lenke/core';
import { query } from '@lenke/gql';

import { buildGraph } from './build-data';
const g = buildGraph();
const now = { __now: parseDateTime('2026-07-12T10:30:45') };
const j = (r: any) => JSON.stringify(r, (_k, v) => (v && v.kind ? String(v) : v));

// Boundary: as-of EXACTLY 2021-01-01 => second role (starts that day), half-open [vfrom,vto)
console.log(
  'as-of boundary 2021-01-01 (expect Senior Engineer, second role):',
  j(
    query(
      g,
      `MATCH (e:Employee)-[:HAS_ASSIGNMENT]->(a:Assignment)-[:AS_POSITION]->(p:Position)
    WHERE e.name='Priya Sharma' AND a.vfrom <= $d AND (a.vto IS NULL OR $d < a.vto) RETURN p.title AS title`,
      { d: parseDate('2021-01-01') },
    ),
  ),
);

// Cross-kind silent UNKNOWN: as-of a DATETIME against a DATE vfrom
console.log(
  '\ncross-kind DATE vfrom < DATETIME asof (silent UNKNOWN => empty):',
  j(
    query(
      g,
      `MATCH (e:Employee)-[:HAS_ASSIGNMENT]->(a:Assignment)
    WHERE e.name='Priya Sharma' AND a.vfrom <= $d AND (a.vto IS NULL OR $d < a.vto) RETURN a.aid AS aid`,
      { d: parseDateTime('2021-06-01T00:00:00') },
    ),
  ),
);

// aggregates over durations
g.addVertex({ labels: ['X'], properties: {} }); // ensure nonempty
console.log(
  '\navg(duration):',
  (() => {
    try {
      return j(query(g, `FOR d IN [DURATION 'P2D', DURATION 'P4D'] RETURN avg(d) AS a`));
    } catch (e: any) {
      return 'ERR ' + e.code + ' ' + e.message;
    }
  })(),
);
console.log(
  'min(duration):',
  j(query(g, `FOR d IN [DURATION 'P5D', DURATION 'P2D'] RETURN min(d) AS a`)),
);
console.log(
  'sum(duration):',
  j(query(g, `FOR d IN [DURATION 'P5D', DURATION 'P2D'] RETURN sum(d) AS a`)),
);
console.log('sum(int) sanity:', j(query(g, `FOR d IN [1,2,3] RETURN sum(d) AS a`)));

// current_timestamp kind when __now is a DATE (misuse) — does it wrongly return a DATE?
console.log(
  '\ncurrent_timestamp w/ DATE __now:',
  j(query(g, `RETURN current_timestamp AS x`, { __now: parseDate('2026-07-12') })),
);

// as-of using current_date directly (today) for "who is currently in Engineering"
console.log(
  '\ncurrently in Engineering (count):',
  j(
    query(
      g,
      `MATCH (e:Employee)-[:HAS_ASSIGNMENT]->(a:Assignment)-[:IN_DEPT]->(d:Department {name:'Engineering'})
    WHERE a.vto IS NULL AND a.ttto IS NULL RETURN count(*) AS n`,
    ),
  ),
);

// TIMESTAMP alias literal
console.log('\nTIMESTAMP literal:', j(query(g, `RETURN TIMESTAMP '2020-01-01T10:15:30' AS x`)));
console.log(
  'DATETIME w/ space sep:',
  (() => {
    try {
      return j(query(g, `RETURN DATETIME '2020-01-01 10:15:30' AS x`));
    } catch (e: any) {
      return 'ERR ' + e.code;
    }
  })(),
);

import { Graph, parseDate, parseDateTime, Duration } from '@lenke/core';
import { query } from '@lenke/gql';

const g = new Graph();
g.addVertex({ labels: ['Person'], properties: { name: 'Priya' } });
console.log('basic:', query(g, `MATCH (p:Person) RETURN p.name AS n`));
console.log('date lit:', query(g, `RETURN DATE '2020-01-01' AS d`));
console.log(
  'dur between:',
  query(g, `RETURN duration_between(DATE '2020-01-15', DATE '2020-04-20') AS d`),
);
console.log(
  'current_date:',
  query(g, `RETURN current_date AS today`, { __now: parseDateTime('2026-07-12T10:30:45') }),
);
console.log('current_date no now:', query(g, `RETURN current_date AS today`));
console.log('date arith:', query(g, `RETURN DATE '2020-01-31' + DURATION 'P1M' AS d`));

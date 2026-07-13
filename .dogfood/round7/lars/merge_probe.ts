// Crown-jewel probe: does _MERGE build a CORRECT golden record?
// Survivorship rule under test: per-field "most recent non-empty value".
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const g = new Graph();
g.createUniqueConstraint('Golden', 'gid');

// A controlled 3-record cluster with KNOWN correct survivorship:
//  - name: most recent non-empty  -> "Robert Brown" (2023, newest non-empty)
//  - phone: most recent non-empty  -> "555-0002" (2022; 2023 rec has empty phone)
//  - city: most recent non-empty   -> "Denver" (2023)
//  - email: most recent non-empty  -> "rob@x.io" (2023)
const cluster = [
  {
    updated: '2021-01-01',
    name: 'Bob Brown',
    email: 'bob@x.io',
    phone: '555-0001',
    city: 'Austin',
  },
  { updated: '2022-06-01', name: 'Robert Brown', email: '', phone: '555-0002', city: '' },
  { updated: '2023-03-01', name: 'Robert Brown', email: 'rob@x.io', phone: '', city: 'Denver' },
];
const expected = { name: 'Robert Brown', email: 'rob@x.io', phone: '555-0002', city: 'Denver' };

const gid = 'G1';
// feed ASCENDING by updated so "later = more recent"
for (const rec of cluster) {
  query(
    g,
    `
    _MERGE (x:Golden {gid: $gid, name: $name, email: $email, phone: $phone, city: $city, updated: $updated})
      _ON_UPDATE SET
        x.name    = coalesce(nullif($name, ''),  x.name),
        x.email   = coalesce(nullif($email, ''), x.email),
        x.phone   = coalesce(nullif($phone, ''), x.phone),
        x.city    = coalesce(nullif($city, ''),  x.city),
        x.updated = $updated
      WHERE x.updated <= $updated
  `,
    { gid, ...rec },
  );
}

const got = query(
  g,
  `MATCH (x:Golden {gid:'G1'}) RETURN x.name AS name, x.email AS email, x.phone AS phone, x.city AS city, x.updated AS updated`,
)[0];
console.log('golden  =', JSON.stringify(got));
console.log('expected=', JSON.stringify(expected));
let ok = true;
for (const k of ['name', 'email', 'phone', 'city'] as const) {
  if ((got as any)[k] !== (expected as any)[k]) {
    ok = false;
    console.log(
      `  MISMATCH ${k}: got ${JSON.stringify((got as any)[k])} want ${JSON.stringify((expected as any)[k])}`,
    );
  }
}
console.log(
  'golden count (constraint holds unique?):',
  query(g, `MATCH (x:Golden) RETURN count(*) AS c`)[0],
);
console.log(ok ? 'PASS survivorship' : 'FAIL survivorship');

// -- also test: does a bare _MERGE (no _ON_UPDATE) CLOBBER (silently drop fields)? --
const g2 = new Graph();
g2.createUniqueConstraint('Golden', 'gid');
query(g2, `_MERGE (x:Golden {gid:'A', name:'Full Name', email:'e@x.io', phone:'555'})`);
query(g2, `_MERGE (x:Golden {gid:'A', name:'Full Name'})`); // no email/phone in payload
console.log(
  '\nbare re-merge with fewer fields =>',
  JSON.stringify(
    query(g2, `MATCH (x:Golden {gid:'A'}) RETURN x.name AS n, x.email AS e, x.phone AS p`)[0],
  ),
);

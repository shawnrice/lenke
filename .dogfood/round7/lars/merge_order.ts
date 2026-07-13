import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';
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
function build(order: typeof cluster, label: string) {
  const g = new Graph();
  g.createUniqueConstraint('Golden', 'gid');
  for (const rec of order)
    query(
      g,
      `
    _MERGE (x:Golden {gid:'G', name:$name, email:$email, phone:$phone, city:$city, updated:$updated})
      _ON_UPDATE SET x.name=coalesce(nullif($name,''),x.name), x.email=coalesce(nullif($email,''),x.email),
        x.phone=coalesce(nullif($phone,''),x.phone), x.city=coalesce(nullif($city,''),x.city), x.updated=$updated
      WHERE x.updated <= $updated
  `,
      { ...rec },
    );
  const got = query(
    g,
    `MATCH (x:Golden{gid:'G'}) RETURN x.name AS name,x.email AS email,x.phone AS phone,x.city AS city`,
  )[0] as any;
  const ok = (['name', 'email', 'phone', 'city'] as const).every(
    (k) => got[k] === (expected as any)[k],
  );
  console.log(`${label}: ${JSON.stringify(got)} -> ${ok ? 'CORRECT' : 'WRONG'}`);
}
build(cluster, 'ascending  by updated ');
build([...cluster].reverse(), 'descending by updated ');
build([cluster[2], cluster[0], cluster[1]], 'shuffled            ');

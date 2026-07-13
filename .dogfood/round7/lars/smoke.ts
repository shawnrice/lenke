import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';
import { deserialize, decodeNodes } from '@lenke/serialization';

const g = new Graph();
const a = g.addVertex({
  labels: ['Rec'],
  properties: { name: '  John SMITH ', email: 'J@X.io', phone: '(555) 123-4567' },
});

// string fn probe
console.log('lower/trim:', query(g, `MATCH (r:Rec) RETURN lower(trim(r.name)) AS k`));
console.log(
  'replace/split:',
  query(g, `MATCH (r:Rec) RETURN replace(r.phone,'-','') AS p, split(r.email,'@') AS parts`),
);
console.log(
  'concat ||:',
  query(g, `MATCH (r:Rec) RETURN lower(trim(r.name)) || '|' || lower(r.email) AS block`),
);
console.log('substring:', query(g, `MATCH (r:Rec) RETURN substring(trim(r.name),1,4) AS s`));

// CSV plain header regression check: id,name,email
const csv = `id,name,email
1,Alice,alice@x.io
2,Bob,bob@y.io`;
const g2 = new Graph();
try {
  decodeNodes(csv, g2);
  for (const v of g2.vertices) {
    console.log(
      'CSV node props keys:',
      Object.keys((v as any).properties),
      JSON.stringify((v as any).properties),
    );
  }
} catch (e) {
  console.log('CSV decodeNodes ERR:', (e as Error).message);
}

// deeper CSV inspection
const csv2 = `id,name,email,phone
1,Alice,alice@x.io,555
2,Bob,bob@y.io,556`;
const g3 = new Graph();
decodeNodes(csv2, g3);
for (const v of g3.vertices) {
  console.log(
    'id=',
    (v as any).id,
    'labels=',
    JSON.stringify((v as any).labels),
    'props=',
    JSON.stringify((v as any).properties),
  );
}

console.log('--- labels as array ---');
const g4 = new Graph();
decodeNodes(
  `id,name,email,phone
1,Alice,alice@x.io,555`,
  g4,
);
for (const v of g4.vertices)
  console.log(
    'labels array=',
    [...(v as any).labels],
    'props=',
    JSON.stringify((v as any).properties),
  );

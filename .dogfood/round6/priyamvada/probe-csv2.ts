import { tsDeserialize, Graph } from './harness.ts';
import { tsQuery } from './harness.ts';
const g = tsDeserialize(':ID,:LABEL,name\n1,A,hello', 'csv', new Graph());
// query the keys
console.log('keys via GQL:', JSON.stringify(tsQuery(g, 'MATCH (n) RETURN properties(n) AS p')));
// direct introspection
for (const v of (g as any).vertices?.() ?? []) {
  console.log('vertex props:', JSON.stringify([...(v.properties?.entries?.() ?? [])]));
}
// Try with trailing newline
const g2 = tsDeserialize(':ID,:LABEL,name\n1,A,hello\n', 'csv', new Graph());
console.log(
  'with trailing NL:',
  JSON.stringify(tsQuery(g2, 'MATCH (n) RETURN properties(n) AS p')),
);
// Try CRLF
const g3 = tsDeserialize(':ID,:LABEL,name\r\n1,A,hello\r\n', 'csv', new Graph());
console.log('CRLF:', JSON.stringify(tsQuery(g3, 'MATCH (n) RETURN properties(n) AS p')));

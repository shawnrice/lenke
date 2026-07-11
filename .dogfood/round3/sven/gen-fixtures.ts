/**
 * Generate realistic Neo4j-admin-import-style paired CSVs by hand (as if dumped
 * from Neo4j) so the importer genuinely exercises lenke's decodeNodes/decodeEdges
 * PARSER — not just a round trip of lenke's own encoder.
 *
 * Header conventions (from packages/serialization/src/csv/index.ts):
 *   nodes:  id, :LABEL (`;`-joined multi-label), then `key:type` typed columns
 *           where type ∈ string|integer|float|boolean, list = `key:type[]`.
 *   edges:  id, :START_ID, :END_ID, :TYPE, then typed property columns.
 *   absent cell = empty unquoted;  null = `\N`;  present "" = quoted empty.
 */
import { mkdirSync, writeFileSync } from 'node:fs';

const DIR = new URL('./data/', import.meta.url).pathname;
mkdirSync(DIR, { recursive: true });

// --- Clean dataset: labels, every scalar type, a list, quoted commas+newlines,
//     null (\N) and present-empty-string ("") cells. -------------------------
const nodes = [
  'id,:LABEL,name:string,age:integer,score:float,active:boolean,tags:string[]',
  // quoted comma + doubled-quote inside a string value
  'u1,Person,"Alice, the ""Great""",34,9.5,true,admin;dev;ops',
  // multi-label (Person;Admin)
  'u2,Person;Admin,Bob,28,7.25,false,ops',
  // embedded newline inside a quoted field; trailing empties = absent columns
  'u3,Company,"Acme, Inc.\nNewline Division",,,,',
  // \N = explicit null for score; "" = present empty-string name
  'u4,Person,"",41,\\N,true,',
].join('\n');

const edges = [
  'id,:START_ID,:END_ID,:TYPE,since:integer,weight:float,note:string',
  'e1,u1,u2,KNOWS,2020,0.8,"met at a, conference"',
  // multi-line quoted note + a \N null weight
  'e2,u1,u3,WORKS_AT,2019,\\N,"role: ""Engineer""\npromoted 2021"',
  'e3,u2,u3,WORKS_AT,2021,1,',
  'e4,u4,u1,KNOWS,2022,0.5,mentor',
].join('\n');

writeFileSync(DIR + 'nodes.csv', nodes);
writeFileSync(DIR + 'edges.csv', edges);

// --- Malformed dataset: exercises the validator. ---------------------------
// - u1 appears twice (duplicate id — core silently dedupes, so the tool must
//   catch it itself).
// - x9 is a Person with NO name (violates a required-property rule).
const nodesBad = [
  'id,:LABEL,name:string,age:integer',
  'u1,Person,Alice,34',
  'u1,Person,Alice AGAIN,99', // duplicate id
  'x9,Person,,50', // Person missing required `name`
].join('\n');

// - e9 points at ghost99, which is not in nodesBad → dangling edge.
const edgesBad = [
  'id,:START_ID,:END_ID,:TYPE,since:integer',
  'e1,u1,x9,KNOWS,2020',
  'e9,u1,ghost99,KNOWS,2021', // dangling endpoint
].join('\n');

writeFileSync(DIR + 'nodes.bad.csv', nodesBad);
writeFileSync(DIR + 'edges.bad.csv', edgesBad);

console.log('wrote fixtures to', DIR);

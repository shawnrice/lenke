// eslint-disable-next-line boundaries/no-cross-package-relative-import -- internal planner entry point, read pre-build; see above
import { compileLinear } from '../gql/src/executor/rewrites.ts';
/**
 * WHICH RUNG answers each `count(DISTINCT …)` spelling? (item 1583)
 *
 * `hop-distinct-probe` timed the spellings and could not say whether a slow arm DECLINED the
 * dedup-while-walking rung or merely had 150,000 edges to walk instead of 50,000 vertices. Time
 * cannot answer that; `compileLinear` can. It runs all nineteen detectors and returns the set, so
 * reading its fields names the rung directly.
 *
 * This is the oracle item 1582 had to add after three mutants survived: a route choice is
 * answer-equivalent, so it needs a test of the CHOICE and not of the answer.
 */
// WHY THE REACH-IN BELOW IS DELIBERATE. `parse` and `compileLinear` are INTERNAL planner entry
// points with no public export, and widening the package's API to satisfy a diagnostic would be the
// wrong trade. The probe also has to read SRC rather than dist: its whole job is to answer "which
// rung would answer this query" while a rung change is being iterated on, which is before a build
// has happened.
//
// ⚠️ The directive has to be ONE line. Written across several, `eslint-disable-next-line` applies to
// the next COMMENT line instead of the import and the rule still fires.
// eslint-disable-next-line boundaries/no-cross-package-relative-import -- internal planner entry point, read pre-build; see above
import { parse } from '../gql/src/parser.ts';

const QUERIES = [
  ['nodeid', 'MATCH (a:P)-[:E]->(b) RETURN count(DISTINCT b) AS c'],
  ['prop', 'MATCH (a:P)-[:E]->(b) RETURN count(DISTINCT b.k) AS c'],
  ['uniqprop', 'MATCH (a:P)-[:E]->(b) RETURN count(DISTINCT b.n) AS c'],
  ['startnode', 'MATCH (a:P)-[:E]->(b) RETURN count(DISTINCT a) AS c'],
  ['startprop', 'MATCH (a:P)-[:E]->(b) RETURN count(DISTINCT a.n) AS c'],
  ['nodeonly', 'MATCH (n:P) RETURN count(DISTINCT n) AS c'],
  ['nodeonlyprop', 'MATCH (n:P) RETURN count(DISTINCT n.n) AS c'],
  ['hopcount', 'MATCH (a:P)-[:E]->(b) RETURN count(*) AS c'],
  ['distinctrows', 'MATCH (a:P)-[:E]->(b) RETURN DISTINCT b.k'],
  ['distinctrowsnode', 'MATCH (a:P)-[:E]->(b) RETURN DISTINCT b'],
];

const linearOf = (q) => {
  const stmt = parse(q);
  const [part] = stmt.parts;

  return compileLinear(part);
};

for (const [name, q] of QUERIES) {
  const c = linearOf(q);
  // Every non-null detector field, which is the set of rungs willing to answer this shape.
  const taken = Object.entries(c)
    .filter(([k, v]) => k !== 'clauses' && k !== 'writes' && v !== null && v !== undefined)
    .map(([k]) => k);

  console.log(`${name.padEnd(17)} ${taken.length === 0 ? '— GENERAL PATH —' : taken.join(', ')}`);
}

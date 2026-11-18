/**
 * ⚠️⚠️ **THE REWRITE THIS PROBE DIAGNOSED WAS BUILT, MEASURED AT 175x, AND THEN REVERTED (item 2287)** —
 * because `WHERE true` is a load-bearing ROUTE ORACLE in this repo's tests (see
 * `packages/gql/src/optional-ordered-answers.test.ts`, which says so, and item 1851, which already had to
 * repair it once). Folding it away removes that device permanently. 🔑 The classifier and the rewrite are
 * quoted in full in item 2287's `CLOSED.md` entry, so re-taking the lever needs no re-derivation.
 *
 * ✅ What remains useful is the AST FACT this probe found, which cost a whole build-and-measure cycle to
 * learn: a `MATCH … WHERE p` attaches its predicate to the **MATCH clause's own `where` field**, NOT to a
 * separate `{kind: 'filter'}` clause — `filter` is a standalone `FILTER`, or a `WHERE` after a `WITH`.
 * ⚠️ Wiring only the `filter` form passed every gate and changed the measurement by nothing, because the
 * pass never fired on the shape it was built for.
 */
// eslint-disable-next-line boundaries/no-cross-package-relative-import -- internal parser entry point
import { parse } from '../../packages/gql/src/parser.ts';

const SRCS = [
  'MATCH (p:P)-[:E]->(q:P) WHERE true RETURN count(*) AS c',
  'MATCH (p:P) WHERE true AND true RETURN count(*) AS c',
  'MATCH (p:P) WHERE p.k = p.k RETURN count(*) AS c',
  'MATCH (p:P) WITH p WHERE true RETURN count(*) AS c',
];

for (const src of SRCS) {
  const [part] = (parse(src) as unknown as { parts: { clauses?: unknown[] }[] }).parts;
  const clauses = (part.clauses ?? []) as { kind: string; where?: unknown }[];

  console.log(`\n  ${src}`);
  console.log(`    clause kinds: ${clauses.map((c) => c?.kind).join(' | ')}`);

  for (const c of clauses) {
    if (c?.where !== undefined) {
      console.log(`    ${c.kind}.where = ${JSON.stringify(c.where)}`);
    }
  }
}

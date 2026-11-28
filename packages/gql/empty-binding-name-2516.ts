import { Graph } from '@lenke/core';

import { query } from './src/index.js';

/*
 * Item 2516: can a GQL query produce an EMPTY binding name, and if so does `withBinding` drop it?
 *
 * Item 2515 fixed `addV('')` — a falsy test (`label ? [label] : []`) that conflated "no argument"
 * with "an empty value". A sweep of every falsy test on a value-like operand across `every package source tree`
 * found 26 candidates and 25 are safe by TYPE: `value ? 'true' : 'false'` is boolean serialization,
 * `seen < n` is a comparison, `adjacency.ts`'s `label` is a `LabelExpr` OBJECT, `PropertyIndex`'s
 * `idx` is a Map value.
 *
 * **The one exception is `bindings.ts`'s `withBinding`:**
 *
 *     export const withBinding = (binding, name: string | undefined, value) => {
 *       if (!name) { return binding; }     // '' would be treated as "no name"
 *
 * That is 2515's exact shape — a falsy test on a `string | undefined`. It is safe only if an EMPTY
 * NAME is unreachable, which is a REACHABILITY argument rather than a type one, and reachability is
 * exactly what item 2515 got wrong. And the parser is known to accept an empty backtick-quoted
 * identifier in at least one position: item 2514 wrote `INSERT (:P {`` : 1})` and reached
 * `validatePropertyKey` with an empty KEY, so the lexer does produce empty identifiers.
 *
 * So the question is whether a VARIABLE can be spelled empty. If it can, a binding would be silently
 * dropped rather than bound, and a later reference to it would see nothing — a wrong answer, not an
 * error.
 *
 * Every row prints what happened. A row that throws at PARSE time is the good outcome: the name
 * never reaches `withBinding`.
 */
const seeded = (): Graph => {
  const g = new Graph();

  g.addVertex({ id: 'a', labels: ['P'], properties: { k: 1 } });
  g.addVertex({ id: 'b', labels: ['P'], properties: { k: 2 } });

  return g;
};

const rows: Array<[string, string]> = [
  ['an EMPTY variable, then read it', 'MATCH (`` :P) RETURN ``.k AS v'],
  ['an EMPTY variable, RETURN count', 'MATCH (`` :P) RETURN count(*) AS c'],
  ['an EMPTY LET name', 'MATCH (n:P) LET `` = n.k RETURN `` AS v'],
  ['an EMPTY alias in RETURN', 'MATCH (n:P) RETURN n.k AS ``'],
  ['CONTROL: a normal variable', 'MATCH (x:P) RETURN x.k AS v ORDER BY v'],
  ['CONTROL: a normal LET', 'MATCH (n:P) LET y = n.k RETURN y AS v ORDER BY v'],
];

for (const [label, src] of rows) {
  let got: string;

  try {
    got = `OK    ${JSON.stringify(query(seeded(), src)).slice(0, 52)}`;
  } catch (e) {
    got = `THREW ${String((e as Error)?.message ?? e).slice(0, 52)}`;
  }

  const cols = [label.padEnd(32), got];

  console.log(`  ${cols.join(' ')}`);
}

console.log('\n  THREW at parse = the empty name never reaches withBinding (the good outcome).');
console.log('  OK with a WRONG or empty answer = the falsy test silently dropped a binding.');
console.log('  Read the CONTROL rows first — if they fail, the probe is wrong, not the engine.');

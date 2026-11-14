/**
 * WHICH RUNG DOES A SKIP-ONLY PAGE LOSE, AND AT WHICH DEPTH? (item 1885)
 *
 * `rung-gap-screen.mjs` flags `skiponly` at every depth from 2 to 5: **26.9 / 36.2 / 49.6 / 59.5 ms
 * against its own `rows` twin's 5.8 / 6.3 / 7.3 / 6.4** — 4.6x to 9.3x, the largest open absolute on
 * that grid now that items 1830 and 1832 took `maxagg`, `topk` and `grouped`. A bare `SKIP` can only
 * ever be the walk MINUS some rows, so a window that multiplies the cost is a window that
 * disqualified the rung.
 *
 * ⚠️ DEPTHS 0 AND 1 ARE ALREADY DONE, and by a mechanism this item has to respect rather than
 * rediscover. Item 1776 took the node shape; item 1777 took the hop at **8.14x / 4.87x**, and its
 * finding is the load-bearing one: a skip-only page is an ORDER-SENSITIVE consumer (it inherits the
 * walk's visit order and decides which rows vanish), so it may ride only a walk whose order is the
 * general path's. `detectHopProjection`'s `forceStartDriven` — built at item 551 for exactly this —
 * is what makes it answer-equivalent, not a carve-out by which end is read.
 *
 * ⚠️ AND ITEM 1829 SAYS THE SAME QUESTION IS UNSETTLED DEEPER: "that is exactly the
 * `forceStartDriven` question items 419 and 551 settled for the one-hop rung, and it has NOT been
 * settled for the deeper widths." So this file does not measure anything. It asks `compileLinear`
 * which rungs are WILLING for each spelling at each depth, because that names what a fix would have
 * to carry the page into — and whether the paged spelling loses one rung or all of them.
 *
 *     bun skip-chain-route-1885.mjs
 */
// eslint-disable-next-line boundaries/no-cross-package-relative-import -- internal planner entry point, read pre-build; the precedence census does the same and says why
import { compileLinear } from '../gql/src/executor/rewrites.ts';
// eslint-disable-next-line boundaries/no-cross-package-relative-import -- internal planner entry point, read pre-build
import { parse } from '../gql/src/parser.ts';

/** The grid's own chain, so the routes read here are the routes it measured. */
const chain = (d) => {
  let text = 'MATCH (a0:P)';
  let last = 'a0';

  for (let i = 1; i <= d; i += 1) {
    text += `-[:E]->(a${String(i)}:P)`;
    last = `a${String(i)}`;
  }

  return { text, far: last };
};

const SPELLINGS = {
  rows: ({ text, far }) => `${text} RETURN ${far}.k AS k`,
  'SKIP 5': ({ text, far }) => `${text} RETURN ${far}.k AS k SKIP 5`,
  'OFFSET 5': ({ text, far }) => `${text} RETURN ${far}.k AS k OFFSET 5`,
  'LIMIT 5': ({ text, far }) => `${text} RETURN ${far}.k AS k LIMIT 5`,
  'SKIP 5 LIMIT 5': ({ text, far }) => `${text} RETURN ${far}.k AS k SKIP 5 LIMIT 5`,
  'OFFSET $s': ({ text, far }) => `${text} RETURN ${far}.k AS k OFFSET $s`,
};

const willing = (q) => {
  const stmt = parse(q);
  const [part] = stmt.parts;
  const c = compileLinear(part);

  return Object.entries(c)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k]) => k);
};

console.log('# which rungs are WILLING (compileLinear fields that are non-null).');
console.log(
  "# ⚠️ THE FIRST NAME IS THE RUNG THAT FIRES — `runLinear`'s chain is lazy and its order",
);
console.log("#   IS this literal's field order (rung-precedence-census.mjs asserts that).\n");

for (let d = 1; d <= 5; d += 1) {
  const c = chain(d);

  console.log(`depth ${String(d)}`);

  for (const [name, make] of Object.entries(SPELLINGS)) {
    const names = willing(make(c));

    console.log(
      `  ${name.padEnd(16)} ${names.length === 0 ? '(none — general matcher)' : names.join(', ')}`,
    );
  }

  console.log('');
}

import { Graph } from '@lenke/core';
import { ErrorCode } from '@lenke/errors';
import { query } from '@lenke/gql';
import { path, run, traversal, V, values } from '@lenke/gremlin';

/*
 * Item 2518: the error registry says "the CODE is the contract, not the message — consumers should
 * branch on `error.code`". That is a testable claim, and this probe tests it on the codes whose
 * documentation and implementation disagree.
 *
 * ## WHAT THE SURVEY FOUND
 *
 * All 17 canonical codes ARE thrown somewhere (an earlier count that said seven were dead was an
 * artifact of searching the literal `'E_*'` string instead of the `ErrorCode.Name` symbol most throw
 * sites use). Exactly one code is thrown and named by NO test: `E_DATA_EXCEPTION`, which has a single
 * live throw site — an element step applied to a `path` in the Gremlin executor.
 *
 * The interesting part is what the survey turned up around it. `core/temporal.ts` states the decision
 * explicitly on `durationOverflow`:
 *
 *   > The engine collapses every runtime fault to `E_INVALID_VALUE` at the FFI boundary, so this
 *   > matches that code, NOT a distinct `E_DATA_EXCEPTION`.
 *
 * and then two doc comments immediately below it — on `addDurations` and `scaleDuration` — say
 * "Throws `DataException` when a component leaves the safe-integer range", naming the code the
 * implementation deliberately does not use. `packages/mcp/src/guides.ts` repeats the claim to
 * consumers: "a duration in a numeric `sum`/`avg` is a loud `E_DATA_EXCEPTION`".
 *
 * Three claims, so three rows, plus the one genuine `DataException` site and controls. Every row
 * prints the code that actually arrives, because that — not the message — is what the registry says a
 * consumer may branch on.
 */
const DUR = 'duration';
const row = (label: string, got: string): void => {
  const cols = [label.padEnd(44), got];

  console.log(`  ${cols.join(' ')}`);
};

const codeOf = (fn: () => unknown): string => {
  try {
    fn();

    return 'NO THROW';
  } catch (e) {
    const c = (e as { code?: string }).code;

    return c ?? 'NO CODE (error.code is undefined)';
  }
};

const durGraph = (): Graph => {
  const g = new Graph();

  g.addVertex({ id: 'a', labels: ['P'], properties: { d: { [DUR]: 'P1D' } } });
  g.addVertex({ id: 'b', labels: ['P'], properties: { d: { [DUR]: 'P2D' } } });

  return g;
};

console.log('# What code actually arrives?  (the registry says the CODE is the contract)\n');
console.log(`  expected spellings: ${ErrorCode.DataException} / ${ErrorCode.InvalidValue}\n`);

console.log('THE ONE GENUINE E_DATA_EXCEPTION SITE (an element step on a path):');
row(
  'path() then values() — Gremlin',
  codeOf(() => {
    const g = new Graph();

    g.addVertex({ id: 'a', labels: ['P'], properties: { k: 1 } });

    return [...run(traversal(V(), path(), values('k')), g)];
  }),
);

console.log('\nWHAT THE STALE DOCS CLAIMED (item 2518 corrected all three to E_INVALID_VALUE):');
row(
  'GQL sum() over a duration column',
  codeOf(() => query(durGraph(), 'MATCH (n:P) RETURN sum(n.d) AS s')),
);
row(
  'GQL avg() over a duration column',
  codeOf(() => query(durGraph(), 'MATCH (n:P) RETURN avg(n.d) AS s')),
);
row(
  'GQL min() over a duration [works per doc]',
  codeOf(() => query(durGraph(), 'MATCH (n:P) RETURN min(n.d) AS s')),
);

console.log('\nCONTROLS — codes whose spelling is already pinned by tests:');
row(
  'a syntax error',
  codeOf(() => query(new Graph(), 'MATCH ( RETURN')),
);
row(
  'an unknown function',
  codeOf(() => query(new Graph(), 'RETURN no_such_fn(1) AS x')),
);
row(
  'a missing $param',
  codeOf(() => query(new Graph(), 'RETURN $nope AS x')),
);
row(
  'a valid query [must NOT throw]',
  codeOf(() => query(durGraph(), 'MATCH (n:P) RETURN count(*) AS c')),
);

console.log('\n  A row reading NO CODE breaks the registry contract outright.');
console.log(
  '  A row whose code is not the DOCUMENTED one means the doc is wrong, not the engine —',
);
console.log('  temporal.ts states the E_INVALID_VALUE choice and its reason explicitly.');
console.log('  Read the CONTROLS first: if the last row throws, the probe is wrong.');

/**
 * Item 965: the TS sorted-LIMIT statement spelling, measured in ISOLATION.
 *
 * Item 868 left this open — the statement spelling of `ORDER BY … LIMIT` runs ~4.6-5.25x the
 * clause spelling, and the recorded remainder is *"materializing the binding table and evaluating
 * keys through a per-row context object"*. The TS spelling probe reports it across three groups,
 * but item 737's rule says a per-row question needs a per-row instrument: running the whole sweep
 * per arm lets rows interfere and inflated one reading by 1.66x.
 *
 * So this is the three flagged shapes, alone, in one process, with a CONTROL the fix cannot reach.
 *
 * WHAT THE ARMS ARE:
 *   stmt asc / desc / lowcard   `MATCH (n:P) ORDER BY … LIMIT 10 RETURN …`  — statement position
 *   clause asc                  `MATCH (n:P) RETURN … ORDER BY … LIMIT 10`  — clause position
 *   CONTROL keyless stmt        `MATCH (n:P) LIMIT 10 RETURN …`             — item 869 closed this
 *                               one to 0.04 ms via a lazy window; it shares the `case 'page'` arm
 *                               but takes the `orderBy.length === 0` branch, so a change to the
 *                               SORTED branch must leave it alone.
 *
 * Rows are fingerprinted, not counted: a sort that silently returned the wrong ten rows would
 * otherwise read as a win.
 */
import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

const N = Number(process.env.A_N ?? 200_000);
const REPS = 7;
const ROUNDS = 5;

const g = new Graph();

for (let i = 0; i < N; i += 1) {
  g.addVertex({
    id: `v${i}`,
    labels: ['P'],
    // `k` is near-unique and `lo` has five values, because item 868's third flagged group is a
    // LOW-CARDINALITY key — a different path through the comparator, and worth its own arm.
    properties: { k: (i * 7919) % N, lo: i % 5, s: `s${i % 7}` },
  });
}

const CASES: ReadonlyArray<readonly [string, string, string]> = [
  ['stmt asc', 'MATCH (n:P) ORDER BY n.k LIMIT 10 RETURN n.k AS c', 'statement, unique key'],
  ['stmt desc', 'MATCH (n:P) ORDER BY n.k DESC LIMIT 10 RETURN n.k AS c', 'statement, descending'],
  ['stmt lowcard', 'MATCH (n:P) ORDER BY n.lo LIMIT 10 RETURN n.k AS c', 'statement, 5 values'],
  ['clause asc', 'MATCH (n:P) RETURN n.k AS c ORDER BY c LIMIT 10', 'clause — the target cost'],
  ['CONTROL keyless', 'MATCH (n:P) LIMIT 10 RETURN n.k AS c', 'item 869 lazy window'],
  // THE REAL CONTROL (item 965). `clause asc` turned out NOT to be one — it moved 1.34x when the
  // statement path moved 1.11x, which a change confined to `case 'page'` cannot explain unless
  // the two spellings share code or the process drifted. This arm has no ORDER BY, no LIMIT and
  // no page clause of any kind, so nothing in that arm can reach it; if it moves too, the
  // movement is the process and not the change.
  ['CONTROL count', 'MATCH (n:P) WHERE n.lo = 0 RETURN count(*) AS c', 'no sort, no page'],
  // THE ROUTE TEST (item 967). `detectNodeProjection` bails on `clauses.length !== 2`. The clause
  // spelling is match+return (2) and reaches it; the statement spelling is match+page+return (3)
  // and cannot. If that is the cause, then adding a NO-OP third clause to the CLAUSE spelling —
  // `FILTER true` keeps every row and changes no answer — should make it collapse onto the
  // statement arm's cost. Reading the guard says this; this arm is what checks it.
  [
    'clause +3rd',
    'MATCH (n:P) FILTER true RETURN n.k AS c ORDER BY c LIMIT 10',
    'clause spelling, 3 clauses',
  ],
  // THE FOLD, PRICED (item 968). `MATCH … ORDER BY n.k LIMIT 10 RETURN n.k AS c` rewritten as
  // `MATCH … RETURN n.k AS c ORDER BY n.k LIMIT 10` — two clauses, sort in the RETURN, and
  // keyed on the INPUT variable rather than the output column. Item 968 verified those two
  // spellings return identical rows on a 6-node fixture, so this arm asks only what it costs.
  // If it lands near `clause asc`, the fold collects the whole 4.4x; if it lands near
  // `clause +3rd`, the sort position is what matters and the clause count is incidental.
  [
    'folded form',
    'MATCH (n:P) RETURN n.k AS c ORDER BY n.k LIMIT 10',
    'what the fold would produce',
  ],
  // Item 969: `stmt lowcard` did NOT speed up when the fold shipped, while asc and desc did.
  // Its key `n.lo` is NOT projected, where theirs is. This arm is that query already folded by
  // hand: if it is also slow, the fold FIRED and the folded shape is simply dearer when the key
  // is not an output column; if it is fast, the fold DECLINED and the refusal list is too wide.
  ['folded lowcard', 'MATCH (n:P) RETURN n.k AS c ORDER BY n.lo LIMIT 10', 'key not projected'],
];

const medianOf = (xs: readonly number[]): number => {
  const s = [...xs].sort((a, b) => a - b);

  return s.length === 0 ? 0 : s[(s.length - 1) >> 1];
};

const best: Record<string, number[]> = {};
const fingerprint: Record<string, string> = {};

for (let round = 0; round < ROUNDS; round += 1) {
  const order = round % 2 === 1 ? [...CASES].reverse() : CASES;

  for (const [name, q] of order) {
    const series: number[] = [];
    let last = '';

    for (let r = 0; r < REPS; r += 1) {
      const t0 = performance.now();
      const rows = [...query(g, q)];

      series.push(performance.now() - t0);
      last = `${rows.length}:${JSON.stringify(rows)}`;
    }

    fingerprint[name] = last;
    (best[name] ??= []).push(Math.min(...series));
  }
}

console.log(
  `# item 965 — the sorted-LIMIT STATEMENT spelling (N=${N}, min of ${REPS}, MEDIAN of ${ROUNDS} alternated rounds)\n`,
);

const baseline = medianOf(best['clause asc'] ?? [0]);

for (const [name, , note] of CASES) {
  const rounds = best[name] ?? [];
  const ms = medianOf(rounds);

  console.log(
    `  ${name.padEnd(16)} ${ms.toFixed(2).padStart(8)} ms  ${(ms / baseline).toFixed(2)}x clause   ` +
      `rounds: ${rounds.map((x) => x.toFixed(2)).join(' ')}   (${note})`,
  );
}

// The statement and clause spellings of the ASCENDING query must return the SAME ten rows. They
// are the same question, which is the whole premise of calling the gap a defect.
const same = fingerprint['stmt asc'] === fingerprint['clause asc'];

console.log(
  `\n  stmt asc and clause asc return identical rows: ${same ? 'YES' : 'NO — the comparison is VOID'}`,
);

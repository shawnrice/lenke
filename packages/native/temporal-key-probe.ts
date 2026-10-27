/**
 * What does a DISTINCT / GROUP BY over a temporal cost, PER KIND?
 *
 * Item 843 gave `valueKey` a temporal arm (no `JSON.stringify`), and item 850 went further for
 * ONE kind: a `LocalDate` is raw-keyable on its `days` count, so `valueSet` / `groupIndex` key it
 * in a `Set<number>` / `Map<number, …>` and build **no string at all**. That was 4.15x, and its
 * note says why it stopped there:
 *
 *   > Only `LocalDate`. The kinds carrying a sub-second or zone part have more than one field and
 *   > no single raw key, so they keep `valueKey`.
 *
 * Every other temporal kind therefore still pays a string per row. This probe prices that gap
 * before anything is written to close it — `LocalDate` and a plain number are the two arms that
 * are ALREADY raw-keyed, so they are the controls a fix cannot move, and the distance between
 * them and the rest is the whole target.
 *
 * ONE KIND PER PROCESS. The arms differ only in which container the key lands in, so running them
 * together lets the first arm warm the dispatch for the rest — item 274's contamination, and
 * item 762's sharper version (a two-distribution in-process A/B flatters whatever redistributes
 * call sites). The driver alternates kinds across rounds.
 *
 *   cd packages/native && KIND=datetime bun temporal-key-probe.ts
 *   KIND=num N=200000 DISTINCT_VALUES=1000 REPS=9 bun temporal-key-probe.ts
 */
import {
  Duration,
  Graph as TsGraph,
  LocalDate,
  LocalDateTime,
  LocalTime,
  ZonedDateTime,
} from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { V, dedupe, hasLabel, toArray, traversal, values } from '@lenke/gremlin';

const N = Number(process.env.N ?? 200_000);
const D = Number(process.env.DISTINCT_VALUES ?? 1000);
const REPS = Number(process.env.REPS ?? 9);
const KIND = process.env.KIND ?? 'num';

/** The `i`th value of the requested kind, carrying `i % D` so every kind has the same group count. */
const valueOf = (i: number): unknown => {
  const v = i % D;

  switch (KIND) {
    case 'num':
      return v;
    case 'str':
      return `s${v}`;
    // Already raw-keyed (item 850) — the control a fix cannot move.
    case 'date':
      return new LocalDate(19_000 + v);
    case 'localtime':
      return new LocalTime(v, 0);
    case 'datetime':
      return new LocalDateTime(1_700_000_000 + v, 0);
    // `nanos` varying rather than `secs`, so a fix keying only on the seconds field is visible as
    // a WRONG ANSWER here (one group) rather than as a speedup.
    case 'datetime_nanos':
      return new LocalDateTime(1_700_000_000, v);
    case 'zoned':
      return new ZonedDateTime(1_700_000_000 + v, 0, 60);
    case 'duration':
      return new Duration(0, 0, v, 0);
    // A LIST — an object that is NOT a temporal, so it walks PAST every `instanceof` the fix adds
    // before reaching the structural path it used before. This is the control the change can
    // reach and must not move: it pays the new checks and gains nothing. (The element control is
    // the `elem` query below, which keys on the vertex itself rather than on `t`.)
    case 'list':
      return [v, v + 1];
    default:
      throw new Error(`unknown KIND: ${KIND}`);
  }
};

const build = (): TsGraph => {
  const g = new TsGraph();

  for (let i = 0; i < N; i++) {
    g.addVertex({ id: `v${i}`, labels: ['P'], properties: { t: valueOf(i), n: i } });
  }

  return g;
};

const g = build();

const time = (label: string, q: string): void => {
  const series: number[] = [];
  let answer: unknown;

  for (let r = 0; r < REPS; r++) {
    const t = performance.now();
    const rows = tsQuery(g, q) as Record<string, unknown>[];

    series.push(performance.now() - t);
    answer = q.includes('count(') ? rows[0]?.m : rows.length;
  }

  // The per-rep series is PRINTED, not just summarised: the TS scalar path plateaus high and emits
  // a rare fast rep, so `min` estimates the two arms differently (CLAUDE.md). Median of the reps
  // after the first three, which are the JIT tiering up.
  const warm = series.slice(3).sort((a, b) => a - b);
  const median = warm[Math.floor(warm.length / 2)] ?? series[0] ?? 0;

  console.log(
    `${KIND.padEnd(15)} ${label.padEnd(22)} median=${median.toFixed(1).padStart(8)} ms  answer=${String(answer).padStart(7)}  reps=[${series.map((s) => s.toFixed(0)).join(' ')}]`,
  );
};

// The GREMLIN twin (item 1017). `values(k).dedup()` is a DIFFERENT implementation from the GQL
// forms above — `executor/dispatch.ts`'s own keying, with its own LocalDate-only raw-key arm from
// item 857 — so it needs its own arm rather than an assumption that one surface's number carries.
const timeGremlin = (label: string): void => {
  const plan = traversal(V(), hasLabel('P'), values('t'), dedupe());
  const series: number[] = [];
  let answer = 0;

  for (let r = 0; r < REPS; r++) {
    const t = performance.now();
    const rows = toArray(plan, g);

    series.push(performance.now() - t);
    answer = rows.length;
  }

  const warm = series.slice(3).sort((a, b) => a - b);
  const median = warm[Math.floor(warm.length / 2)] ?? series[0] ?? 0;

  console.log(
    `${KIND.padEnd(15)} ${label.padEnd(22)} median=${median.toFixed(1).padStart(8)} ms  answer=${String(answer).padStart(7)}  reps=[${series.map((x) => x.toFixed(0)).join(' ')}]`,
  );
};

console.log(`# temporal DISTINCT key cost — KIND=${KIND}, N=${N}, ${D} distinct values`);
time('count(DISTINCT t)', 'MATCH (p:P) RETURN count(DISTINCT p.t) AS m');
time('RETURN DISTINCT t', 'MATCH (p:P) RETURN DISTINCT p.t AS m');
time('GROUP BY t', 'MATCH (p:P) RETURN p.t AS m, count(*) AS c');
// ELEMENTS are objects too, and the most common non-temporal DISTINCT key there is. Same control
// role as `list`: it walks past the new `instanceof` chain on every row.
time('DISTINCT the element', 'MATCH (p:P) RETURN DISTINCT p AS m');
timeGremlin('gremlin dedup');
// The TS twin of item 1020 (item 1021). The Rust engine's sorted LIMIT dispatches on COLUMN
// representation and had no temporal arm; the TS engine keeps top-k over input bindings with a
// value comparator and no per-type dispatch, so the prediction is NO analogous gap — `num` and
// `date` are the controls that say whether that prediction holds.
time('ORDER BY t LIMIT 10', 'MATCH (p:P) ORDER BY p.t LIMIT 10 RETURN p.t AS m');
time('ORDER BY t (ceiling)', 'MATCH (p:P) ORDER BY p.t RETURN p.t AS m');

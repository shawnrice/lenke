/**
 * THE SIZE-SWEEP WRAPPER for both cliff finders (item 2224).
 *
 * **A ONE-SIZE RATIO IS AN UPPER BOUND, NOT A MEASUREMENT, and that cost three verdicts in one
 * session** — items 2200 (by-id "4.7x" → 1.5x), 2205 (every row's steep first step was the shared cache
 * transition) and 2223 (per-edge 3.78x → 1.69x). The cause is structural rather than incidental: a
 * hand-rolled FLOOR is more cache-friendly than a general engine at small sizes and loses that advantage at
 * scale, so the `vs floor` column shrinks as the graph grows.
 *
 * So the question a floored row cannot answer alone is **which DIRECTION its ratio moves**:
 *
 *   - a ratio that FALLS with size is a mid-size artifact — the engine amortizes, nothing to build;
 *   - a ratio that RISES is a real target, and gets worse exactly where it matters.
 *
 * ONE PROCESS PER SIZE, spawned rather than looped in-process: items 762 and 2172-2175 established that
 * shapes timed in sequence pollute each other's dispatch, and item 2214 measured a 2.6x that was purely
 * first-row JIT warm-up.
 *
 *     bun finder-sweep-2224.ts            # the GQL finder
 *     FINDER=gremlin bun finder-sweep-2224.ts
 *     SIZES=5000,20000,80000 bun finder-sweep-2224.ts
 */
const FINDER = process.env.FINDER === 'gremlin' ? 'gremlin-cliff-finder.ts' : 'gql-cliff-finder.ts';
const SIZES = (process.env.SIZES ?? '5000,20000,80000').split(',').map((s) => Number(s.trim()));

/** `family shape … ns/op floor vs-floor rows …` → the `vs floor` ratio per shape, floored rows only. */
const ratiosOf = (out: string): Map<string, number> => {
  const found = new Map<string, number>();

  for (const line of out.split('\n')) {
    /* Anchored on the RATIO TOKEN (`1.23x`), because a shape name can contain anything. */
    const m = /^(\S+)\s+(.+?)\s+(\d+)\s+(\d+)\s+(\d+\.\d\d)x/.exec(line.trim());

    if (m !== null) {
      found.set(`${m[1]}/${m[2].trim()}`, Number(m[5]));
    }
  }

  return found;
};

/**
 * THE VERDICT IS THE DIRECTION, not the magnitude.
 *
 * A ratio that grows by more than 25% across the sweep is the only thing worth opening; everything else is
 * the FLOOR losing its cache advantage as the graph outgrows cache (item 2223 measured the floor's per-edge
 * cost growing 3.1x against the engine's 1.4x).
 */
const trendOf = (first: number, last: number): string => {
  if (last > first * 1.25) {
    return 'RISES <--';
  }

  return last < first * 0.8 ? 'falls' : 'flat';
};

const perSize = new Map<number, Map<string, number>>();

for (const n of SIZES) {
  // eslint-disable-next-line no-await-in-loop -- one size per process, deliberately serial
  const proc = Bun.spawn(['bun', 'run', FINDER], {
    cwd: import.meta.dir,
    env: { ...process.env, NODES: String(n), REPS: process.env.REPS ?? '20' },
    stdout: 'pipe',
  });
  // eslint-disable-next-line no-await-in-loop -- as above
  const text = await new Response(proc.stdout).text();

  perSize.set(n, ratiosOf(text));
  console.log(`  measured NODES=${n} (${perSize.get(n)?.size ?? 0} floored rows)`);
}

const shapes = [...new Set([...perSize.values()].flatMap((m) => [...m.keys()]))].sort();

console.log(`\n  ${'shape'.padEnd(40)}${SIZES.map((n) => `${n}`.padStart(9)).join('')}   trend`);

for (const shape of shapes) {
  const row = SIZES.map((n) => perSize.get(n)?.get(shape));

  if (row.some((v) => v === undefined)) {
    continue;
  }

  const trend = trendOf(row[0] as number, row[row.length - 1] as number);

  console.log(
    `  ${shape.padEnd(40)}${row.map((v) => `${(v as number).toFixed(2)}x`.padStart(9)).join('')}   ${trend}`,
  );
}

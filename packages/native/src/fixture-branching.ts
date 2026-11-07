/**
 * Assert that a generated fixture's graph actually BRANCHES (item 1633).
 *
 * ⚠️ WHY THIS IS A SHARED HELPER AND NOT A COMMENT. Nine generators in this corpus produced a
 * FUNCTIONAL graph — every vertex with the full out-degree and exactly ONE distinct out-neighbour —
 * and every degree statistic looked perfect while they did. The mechanical form, which no choice of
 * multiplier fixes:
 *
 * ```text
 *   to = (a * k + b) % N      is INVARIANT under  k -> k + N
 * ```
 *
 * and every generator here loops `for (k = 0; k < N * FANOUT; k++)`, so one vertex's FANOUT edges
 * are exactly `k0, k0+N, k0+2N, …` — all of them landing on the SAME target. The fix is to split on
 * the repeat index `Math.floor(k / N)`.
 *
 * CLAUDE.md records this after items 702/1516/1518 and says one line counting the DISTINCT endpoints
 * would have caught it. Item 1632 then found the same defect in `bench:gremlin`'s main fixture, where
 * it had been making multi-hop yielding rows **2.4-6.2x** too fast by turning five edges into five
 * reads of one cache line. This is that line, in one place, so a probe states the property instead of
 * copying ten lines of set-building.
 *
 * It asserts the PROPERTY (every vertex branches) rather than an exact count, so deliberately
 * changing a fan-out does not trip it. A fanout of 1 cannot branch and is accepted as-is — degree 1
 * is the one case where the invariance is harmless.
 */
export const assertBranching = (
  label: string,
  n: number,
  fanout: number,
  /** The `[from, to]` this fixture's generator produces for edge `k`. */
  endpoints: (k: number) => readonly [number, number],
): void => {
  if (fanout <= 1) {
    return;
  }

  const nbrs = new Map<number, Set<number>>();

  for (let k = 0; k < n * fanout; k += 1) {
    const [from, to] = endpoints(k);
    let set = nbrs.get(from);

    if (set === undefined) {
      set = new Set();
      nbrs.set(from, set);
    }

    set.add(to);
  }

  let worst = Number.POSITIVE_INFINITY;

  for (const set of nbrs.values()) {
    worst = Math.min(worst, set.size);
  }

  if (worst < 2) {
    throw new Error(
      `${label}: the fixture is DEGENERATE — its least branching vertex has ${worst} distinct ` +
        `out-neighbour(s) at fanout ${fanout}, so the graph is FUNCTIONAL and a k-hop row over it ` +
        `measures a chain. Split the target on the repeat index Math.floor(k / n); see items 1516, ` +
        `1518 and 1632.`,
    );
  }
};

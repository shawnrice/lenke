/**
 * THE EMPTY-SEED FAST-PATH GATE on an inline `CALL` body (item 1661).
 *
 * ⚠️ WHY THIS FILE HAS TO ASSERT A ROUTE AND NOT JUST AN ANSWER. The change is a route choice, so
 * it is ANSWER-EQUIVALENT by construction: the whole 4,230-test gql suite passed on the very first
 * run, before any of this existed, and would pass just as well if the route were silently lost
 * again. `perf-gate-needs-its-own-test` is the rule; the instrument here is a SPY ON THE BODY'S
 * RUNG, counting how many times it is invoked, which is observable without timing anything.
 *
 * WHAT THE CHANGE IS. `runLinearClauses` gates its fast-path ladder on `initial === undefined`,
 * because the rungs assume an empty start. `runCallInline` used to hand it `new Map(seed)`
 * UNCONDITIONALLY — so even a body with no scope, which imports nothing, arrived with an empty-but-
 * DEFINED Map and was disqualified from every rung. Passing `undefined` for an empty seed is the
 * same start (`runLinearClauses` does `[initial ?? new Map()]`) and restores the ladder.
 *
 * THE FOUR PROPERTIES:
 *
 * 1. **An unscoped body reaches its rung** — the spy fires. Under the old code it fired ZERO times.
 * 2. **A body whose SCOPE NAMES ARE ALL UNBOUND also reaches it.** This is why the gate is
 *    `seed.size === 0` and not `clause.scope.length === 0`: `CALL (m) { … }` for an `m` bound
 *    nowhere outside is ACCEPTED by this engine (measured, not assumed — see the test), imports
 *    nothing, and deserves the rungs too.
 * 3. **A body with a NON-EMPTY seed still does NOT reach it** — the control that pins the change to
 *    the empty case. A rung handed a real imported binding would be answering a different question.
 * 4. **The answers are unchanged**, checked against the same question spelled without a `CALL`.
 *
 * ⚠️ AND THE WRITE BODY, which is the one shape where being wrong would CORRUPT rather than slow:
 * ISO runs an unscoped `CALL { INSERT … }` once per OUTER ROW. It must not be hoisted, and no read
 * rung may claim it. Pinned below because the fast-path ladder is the thing this change exposes it
 * to, even though every rung in that ladder is read-only today.
 */
import { describe, expect, test } from 'bun:test';

import { Graph, type Vertex } from '@lenke/core';

import type { LinearQuery } from './ast.js';
import { runLinearClauses } from './executor/clauses.js';
import { compileLinear } from './executor/rewrites.js';
import { query } from './index.js';
import { parse } from './parser.js';

/** Four `P` vertices, each with one outgoing `E`, so a hop body has rows to find. */
const build = (): Graph => {
  const g = new Graph();

  for (const id of ['a', 'b', 'c', 'd']) {
    g.addVertex({ id, labels: ['P'], properties: { k: id.charCodeAt(0) } });
  }

  const v = (id: string): Vertex => {
    const found = g.getVertexById(id);

    if (found === null || found === undefined) {
      throw new Error(`fixture vertex ${id} is missing`);
    }

    return found;
  };

  g.addEdge({ id: 'e1', from: v('a'), to: v('b'), labels: ['E'], properties: {} });
  g.addEdge({ id: 'e2', from: v('b'), to: v('c'), labels: ['E'], properties: {} });

  return g;
};

/**
 * `parse` returns a `Statement`, which is a union including `TxControl` (`START TRANSACTION` and
 * friends) and those carry no `parts`. Narrowed here rather than cast, so a query spelling that
 * stopped being a linear query would fail loudly instead of reading `undefined.parts`.
 */
const firstPart = (text: string): LinearQuery => {
  const parsed = parse(text);

  if (!('parts' in parsed)) {
    throw new Error(`not a linear query: ${text}`);
  }

  const [part] = parsed.parts;

  if (part === undefined) {
    throw new Error(`no linear part parsed for: ${text}`);
  }

  return part;
};

/**
 * Every compiled-body hook `fastPath` consults, in its ladder order. Wrapping ALL of them and
 * counting any invocation is the question "did the ladder claim this body?", which is what the
 * change alters — spying on one named rung would miss a body whose rung is a different one, and
 * these bodies carry three different hooks between them (`countShortcut`, `nodeProjection`,
 * `hopProjection`).
 */
const HOOKS = [
  'varLengthCount',
  'countShortcut',
  'optionalHopCount',
  'forCount',
  'forProjection',
  'optionalHopProjection',
  'groupCountShortcut',
  'groupHopShortcut',
  'reachShortcut',
  'hopProjection',
  'hop2Projection',
  'hopAggregate',
  'multiHopAggregate',
  'distinctProjection',
  'distinctCount',
  'nodeProjection',
  'nodeAggregate',
  'multiNodeAggregate',
  'groupedNodeAggregate',
  'groupedHopAggregate',
] as const;

type Hooked = Record<string, ((g: Graph, p: unknown) => unknown) | undefined>;

/**
 * Run `text` against `g`, counting how many times the inline CALL body's fast-path ladder is
 * entered. `rungs` is how many hooks the body carries at all: ZERO means there is no rung to
 * reach, which is a different and louder fact than a rung that exists and is never reached — a
 * bare `RETURN 1` body is in that class, which is why the gate change cannot speed it up.
 */
const rungHits = (text: string, g: Graph): { hits: number; rungs: number } => {
  const compiled = compileLinear(firstPart(text));
  const call = compiled.clauses.find((c) => c.kind === 'callInline');

  if (call === undefined || !('body' in call)) {
    throw new Error(
      `no callInline clause survived compilation for: ${text} — an elimination rewrite claimed it, so this is not a CALL-route test at all`,
    );
  }

  const body = call.body as unknown as Hooked;
  let hits = 0;
  let rungs = 0;

  for (const h of HOOKS) {
    const real = body[h];

    // ⚠️ `typeof`, not `!== undefined`: some of these slots hold `null` rather than being absent,
    // and wrapping one of those replaced a null with a function, which `buildGroups` then CALLED.
    if (typeof real !== 'function') {
      continue;
    }

    rungs += 1;

    body[h] = (gg, pp) => {
      hits += 1;

      return real(gg, pp);
    };
  }

  runLinearClauses(compiled, g, {});

  return { hits, rungs };
};

describe('⚠️ 1. an unscoped CALL body reaches the fast-path ladder', () => {
  test('⚠️ THE ROUTE: the body rung fires — it fired ZERO times before item 1661', () => {
    const { hits, rungs } = rungHits(
      'MATCH (n:P) CALL { MATCH (z:P) RETURN count(*) AS c } RETURN sum(c) AS t',
      build(),
    );

    expect(rungs, 'the body carries a rung').toBeGreaterThan(0);
    expect(hits, 'and it is REACHED').toBeGreaterThan(0);
  });

  /**
   * ⚠️ THE COMPLEMENT, and the reason `calltrivial` measured FLAT under this change. A body that is
   * a bare `RETURN` of a constant carries NO rung at all, so there was never anything for the gate
   * to unlock. Pinned so the flat result is read as "no rung exists" rather than "the gate does not
   * work" — and so that anyone adding a bare-RETURN rung later sees that this is where it lands.
   */
  test('⚠️ a bare `RETURN 1` body carries NO rung, so the gate cannot help it', () => {
    const { hits, rungs } = rungHits(
      'MATCH (n:P) CALL { RETURN 1 AS c } RETURN sum(c) AS t',
      build(),
    );

    expect(rungs, 'nothing in the ladder claims a pattern-less constant RETURN').toBe(0);
    expect(hits).toBe(0);
  });

  /**
   * The uncorrelated hoist (`invariant`) runs a read-only unscoped body ONCE and reuses the rows,
   * so the rung fires once for FOUR outer rows rather than four times. Pinned because the win this
   * change delivers is the product of the two: the rung makes the single run cheap, and the hoist
   * is what keeps it single.
   */
  test('and exactly ONCE for four outer rows, because the hoist still holds', () => {
    const { hits } = rungHits(
      'MATCH (n:P) CALL { MATCH (z:P) RETURN count(*) AS c } RETURN sum(c) AS t',
      build(),
    );

    expect(hits).toBe(1);
  });

  /**
   * ⚠️ THE REASON THE GATE IS `seed.size`, NOT `clause.scope.length`. A scope naming a variable
   * that is bound nowhere outside imports nothing, so the body's start is empty and the rungs are
   * sound for it. This engine ACCEPTS that spelling rather than rejecting it, which is what makes
   * this path reachable at all — so a `scope.length === 0` gate would be a silent miss here.
   */
  test('⚠️ a scope whose names are ALL UNBOUND reaches it too (seed.size, not scope.length)', () => {
    // ⚠️ THE YIELD IS WRAPPED IN A FUNCTION CALL, AND THAT IS LOAD-BEARING (item 1662). This
    // fixture read `RETURN z.k AS c` when it was written, with a comment claiming no rewrite
    // could claim it — item 1662 extended `inlineCorrelatedCall` to exactly that shape and this
    // test is what reported it. `abs(…)` is not `cheapPureExpr` (a function can raise, so it is
    // not TOTAL and cannot move into a `LET`), which is a durable refusal rather than a gap:
    // the rewrite can never admit it. The body still carries its `nodeProjection` rung, so the
    // assertion below is still about reaching the ladder and not about a missing rung.
    const { hits, rungs } = rungHits(
      'MATCH (n:P) CALL (m) { MATCH (z:P) RETURN abs(z.k) AS c } RETURN sum(c) AS t',
      build(),
    );

    expect(rungs, 'the rung is compiled').toBeGreaterThan(0);
    expect(hits, 'an unbound scope name imports NOTHING, so the start is empty').toBeGreaterThan(0);
  });
});

describe('⚠️ 2. a NON-EMPTY seed still takes the general loop', () => {
  /**
   * The control. A body handed a real imported binding must keep the general clause loop, because
   * the rungs assume an empty start — a rung answering `MATCH (z:P) RETURN count(*)` while `n` is
   * imported would be answering the uncorrelated question.
   */
  test('⚠️ a scoped body with a BOUND name does NOT reach the rung', () => {
    // The `callprojx` shape: scope `(n)` is bound by the outer MATCH, so the seed is non-empty.
    // It carries a `hopProjection` rung, which makes the assertion meaningful — the rung EXISTS
    // and is still not reached.
    //
    // ⚠️ `abs(…)` for the same reason as the unbound-scope case above (item 1662): the bare
    // `RETURN x.k AS c` spelling this used to carry is now REWRITTEN to `[match, let]` and never
    // reaches `runCallInline` at all, so it could no longer test the seed gate.
    const { hits, rungs } = rungHits(
      'MATCH (n:P) CALL (n) { MATCH (n)-[:E]->(x) RETURN abs(x.k) AS c } RETURN sum(c) AS t',
      build(),
    );

    expect(rungs, 'the body does carry a rung, so this is a real refusal').toBeGreaterThan(0);
    expect(hits, 'but a real imported binding keeps the general loop').toBe(0);
  });
});

describe('⚠️ 3. the answers are unchanged', () => {
  for (const [label, callText, oracleText] of [
    [
      'an unscoped counting body',
      'MATCH (n:P) CALL { MATCH (z:P) RETURN count(*) AS c } RETURN sum(c) AS t',
      'MATCH (n:P) RETURN count(*) * 4 AS t',
    ],
    [
      'a correlated hop body',
      'MATCH (n:P) CALL (n) { MATCH (n)-[:E]->(x) RETURN count(*) AS c } RETURN sum(c) AS t',
      'MATCH (n:P)-[:E]->(x) RETURN count(*) AS t',
    ],
  ] as const) {
    test(`${label} agrees with the same question spelled without a CALL`, () => {
      const g = build();

      expect(query(g, callText)[0].t).toBe(query(g, oracleText)[0].t);
    });
  }

  test('an unbound scope name is ACCEPTED and does not correlate', () => {
    const g = build();

    // `m` is bound nowhere, so the body is uncorrelated: 4 P vertices counted for each of 4 rows.
    expect(
      query(g, 'MATCH (n:P) CALL (m) { MATCH (z:P) RETURN count(*) AS c } RETURN sum(c) AS t')[0].t,
    ).toBe(16);
  });

  test('OPTIONAL CALL with an empty body result still null-fills one row per outer row', () => {
    const g = build();

    expect(
      query(g, 'MATCH (n:P) OPTIONAL CALL { MATCH (z:Q) RETURN z.k AS c } RETURN count(*) AS t')[0]
        .t,
    ).toBe(4);
  });

  /**
   * ⚠️ A SCOPED UNION body, which is the one shape that pins the `bodyMore` loop SEPARATELY. The
   * empty-seed test below cannot see a mutant that drops the seed only on the set-op parts, because
   * there is no seed there to drop. Here `n` is imported, so losing it would leave the body's `n`
   * unbound and change the answer.
   */
  test('a SCOPED UNION body still imports the outer name on every set-op part', () => {
    const g = build();

    // Both parts match the same edges, so the UNION dedups to one row per distinct target:
    // a->b and b->c give one row each, c and d give none.
    expect(
      query(
        g,
        'MATCH (n:P) CALL (n) { MATCH (n)-[:E]->(x) RETURN x.k AS c UNION MATCH (n)-[:E]->(y) RETURN y.k AS c } RETURN count(*) AS t',
      )[0].t,
    ).toBe(2);
  });

  test('a UNION body (the bodyMore path) with an empty seed is unchanged', () => {
    const g = build();

    expect(
      query(
        g,
        'MATCH (n:P) CALL { MATCH (z:P) RETURN z.k AS c UNION MATCH (z:P) RETURN z.k AS c } RETURN count(*) AS t',
      )[0].t,
    ).toBe(16);
  });
});

describe('⚠️ 4. a WRITING unscoped body runs once per OUTER ROW, never hoisted', () => {
  /**
   * ISO: `CALL { INSERT … }` with no scope is still executed once per outer row. The `invariant`
   * hoist is gated on `bodyIsReadOnly` for exactly this reason, and the fast-path ladder this
   * change exposes the body to contains only READ rungs — so nothing may claim a write body. If
   * either of those two facts ever stops holding, this test is what says so.
   */
  /**
   * ⚠️ THE ONE SHAPE WHERE THE SEED COPY IS LOAD-BEARING, found by diagnosing a surviving mutant
   * (M6: pass `seed` itself instead of `new Map(seed)`). `insertVertexWithId` is the single clause
   * path that writes into the binding it is handed — `binding.set(node.variable, vertex)` at
   * `clauses.ts:144`, in place — so a WRITING body plus a set-op part is the only way the body's
   * own binding could leak into a later part. Both halves are legal here, measured rather than
   * assumed.
   *
   * ⚠️ The copy PREDATES item 1661: this change replaced `new Map(seed)` with
   * `start && new Map(start)` and kept the copy. The property is pinned because 4,243 gql tests
   * did not cover it, not because this change put it at risk.
   */
  test('⚠️ a WRITING body with a UNION part: the seed copy keeps the write from leaking', () => {
    const g = build();

    expect(
      query(
        g,
        'MATCH (n:P) CALL (n) { INSERT (w:W {m: 1}) RETURN w.m AS c UNION MATCH (n)-[:E]->(x) RETURN x.k AS c } RETURN count(*) AS t',
      )[0].t,
    ).toBe(6);

    expect(query(g, 'MATCH (w:W) RETURN count(*) AS t')[0].t, 'one insert per outer row').toBe(4);
  });

  test('four outer rows insert FOUR vertices, not one', () => {
    const g = build();

    query(g, 'MATCH (n:P) CALL { INSERT (:W {m: 1}) } RETURN count(*) AS t');

    expect(query(g, 'MATCH (w:W) RETURN count(*) AS t')[0].t).toBe(4);
  });
});

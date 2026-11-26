import { describe, expect, test } from 'bun:test';

import { walkReadFlags } from './executor/hop-projection.js';

/**
 * The walk's endpoint-binding decision, as a pure function (item 1903).
 *
 * IT IS EXTRACTED AND TESTED HERE BECAUSE A ROUTE DECISION'S MISTAKES WERE ANSWER-VISIBLE, which
 * is the opposite of the usual case [[perf-gate-needs-its-own-test]] describes. Deriving these
 * three flags from the real projection while the walk built the deferred arm's reduced copy was a
 * TS-only WRONG ANSWER on four of five end/key combinations — so the condition gets assertions of
 * its own rather than living inline inside a detector at the complexity cap.
 */
describe('walkReadFlags', () => {
  const base = {
    readsStart: false,
    readsRel: false,
    startOnly: false,
    hasStartVar: true,
    hasRelVar: true,
  };

  test('the PLAIN arm passes the projection analysis straight through', () => {
    expect(
      walkReadFlags({ ...base, deferredWalk: false, readsStart: true, readsRel: true }),
    ).toStrictEqual({ itemsReadStart: true, projStartOnly: false, itemsReadRel: true });

    expect(
      walkReadFlags({ ...base, deferredWalk: false, startOnly: true, readsStart: true }),
    ).toStrictEqual({ itemsReadStart: true, projStartOnly: true, itemsReadRel: false });
  });

  /** THE BUG, AS AN ASSERTION: a start-only projection must NOT keep the flag once deferred. */
  test('the DEFERRED arm is never start-only, whatever the real items read', () => {
    expect(
      walkReadFlags({ ...base, deferredWalk: true, startOnly: true, readsStart: true }),
    ).toStrictEqual({ itemsReadStart: true, projStartOnly: false, itemsReadRel: true });
  });

  test('the DEFERRED arm binds both ends even when the real items read NEITHER', () => {
    expect(walkReadFlags({ ...base, deferredWalk: true })).toStrictEqual({
      itemsReadStart: true,
      projStartOnly: false,
      itemsReadRel: true,
    });
  });

  /**
   * AND IT STAYS GATED ON THE VARIABLE EXISTING. A key cannot read an endpoint the pattern does
   * not name, and `filteredHopWalk` refuses `needsStart` with no `startVar` outright — so claiming
   * the start is read when there is no start variable would turn a wrong answer into a crash.
   */
  test('an absent start or rel variable is not claimed as read', () => {
    expect(
      walkReadFlags({ ...base, deferredWalk: true, hasStartVar: false, hasRelVar: false }),
    ).toStrictEqual({ itemsReadStart: false, projStartOnly: false, itemsReadRel: false });
  });

  test('the plain arm ignores whether the variables exist — the analysis already did', () => {
    expect(
      walkReadFlags({
        ...base,
        deferredWalk: false,
        hasStartVar: false,
        hasRelVar: false,
        readsStart: true,
        readsRel: true,
      }),
    ).toStrictEqual({ itemsReadStart: true, projStartOnly: false, itemsReadRel: true });
  });
});

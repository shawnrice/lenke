/**
 * THE BRANCH THAT CONSUMES THE PAGED RUNGS, pinned directly (item 1885).
 *
 * WRITTEN BECAUSE A MUTANT SURVIVED. Replacing `fastPath`'s
 * `const paged = pagedWidthProjections(linear, graph, params)` with `undefined` passed **92 tests**
 * — the answer file and the whole route file — because dropping a consumer is answer-equivalent: the
 * query falls to the general matcher and returns the same rows, more slowly.
 * `routes-fired.test.ts` pins that the DETECTOR fires; nothing pinned that anything reads it.
 *
 * `clauses.ts`'s own note says this is true of every rung ("removing the branch that CONSUMES it is
 * answer-equivalent and the whole suite passes"), and [[rewrite-composition-is-not-free]]'s remedy
 * is to export the composition rather than to accept the survivor. So this calls the consumer
 * directly with a synthetic `CLinear`, which is the only thing that can tell "wired" from
 * "detected".
 */
import { describe, expect, it } from 'bun:test';

import { Graph } from '@lenke/core';

import { pagedWidthProjections } from './executor/clauses.ts';
import type { CLinear, Row } from './executor/core.ts';

const graph = new Graph();
const params = {};

/** Only the two fields the consumer reads; everything else is absent, which is what `null` means. */
const linearWith = (fields: Partial<CLinear>): CLinear => fields as unknown as CLinear;

describe('pagedWidthProjections — the consumer is wired', () => {
  it('returns the CHAIN rung’s rows when it claims the query', () => {
    const rows: Row[] = [{ k: 1 }];

    expect(
      pagedWidthProjections(linearWith({ chainPagedProjection: () => rows }), graph, params),
    ).toStrictEqual(rows);
  });

  it('returns the HOP2 rung’s rows when it claims the query', () => {
    const rows: Row[] = [{ k: 2 }];

    expect(
      pagedWidthProjections(linearWith({ hop2PagedProjection: () => rows }), graph, params),
    ).toStrictEqual(rows);
  });

  it('prefers the chain rung when both are present — the declared order', () => {
    expect(
      pagedWidthProjections(
        linearWith({
          chainPagedProjection: () => [{ k: 'chain' }],
          hop2PagedProjection: () => [{ k: 'hop2' }],
        }),
        graph,
        params,
      ),
    ).toStrictEqual([{ k: 'chain' }]);
  });

  /**
   * `null` IS A PER-CALL DECLINE, NOT AN EMPTY RESULT — `pagedRows` passes it through from the
   * walk it wraps. Answering it with `[]` would be rows MISSING rather than a slower route, so the
   * consumer must fall through to the next rung and then out.
   */
  it('falls through a per-call `null` decline to the next rung', () => {
    expect(
      pagedWidthProjections(
        linearWith({
          chainPagedProjection: () => null,
          hop2PagedProjection: () => [{ k: 'hop2' }],
        }),
        graph,
        params,
      ),
    ).toStrictEqual([{ k: 'hop2' }]);
  });

  it('returns `undefined` when both decline per call, so the general path runs', () => {
    expect(
      pagedWidthProjections(
        linearWith({ chainPagedProjection: () => null, hop2PagedProjection: () => null }),
        graph,
        params,
      ),
    ).toBeUndefined();
  });

  it('returns `undefined` when neither rung is present', () => {
    expect(
      pagedWidthProjections(
        linearWith({ chainPagedProjection: null, hop2PagedProjection: null }),
        graph,
        params,
      ),
    ).toBeUndefined();
  });

  /** An EMPTY row list is a real answer and must not be confused with a decline. */
  it('returns an empty row list as the answer it is', () => {
    expect(
      pagedWidthProjections(linearWith({ chainPagedProjection: () => [] }), graph, params),
    ).toStrictEqual([]);
  });
});

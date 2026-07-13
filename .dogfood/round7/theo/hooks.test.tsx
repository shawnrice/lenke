// ROUND 7 — the crown jewel at the REAL React layer: does useLiveQuery render a
// STALE value when deps under-declare? Drives the actual @lenke/react hook over
// a real @lenke/native store through @testing-library/react.
//
//   bun test --preload ./happydom.preload.ts hooks.test.tsx
import { describe, expect, test } from 'bun:test';

import { StoreProvider, useLiveQuery } from '@lenke/react';
import { act, render, cleanup } from '@testing-library/react';
import * as React from 'react';

import { makeDashboardStore, LIB_PRESENT } from './dashboard.ts';

const suite = LIB_PRESENT ? describe : describe.skip;

function Total({ deps }: { deps: readonly string[] }) {
  const rows = useLiveQuery('MATCH (o:Purchase) RETURN sum(o.amount) AS total', { deps });
  return <span data-testid="total">{String((rows[0] as { total?: number })?.total ?? 0)}</span>;
}

suite('useLiveQuery under mutation', () => {
  test('CORRECT deps → the rendered total updates on an in-place SET', () => {
    const store = makeDashboardStore();
    const { getByTestId, unmount } = render(
      <StoreProvider store={store}>
        <Total deps={['Purchase', 'amount']} />
      </StoreProvider>,
    );
    expect(getByTestId('total').textContent).toBe('180');
    act(() => {
      store.mutate((g) => g.query("MATCH (o:Purchase {oid: 'o1'}) SET o.amount = 999"));
    });
    expect(getByTestId('total').textContent).toBe('1079'); // 999 + 50 + 30
    unmount();
    store[Symbol.dispose]();
  });

  test('UNDER-declared deps → the rendered total goes STALE (crown jewel)', () => {
    const store = makeDashboardStore();
    const { getByTestId, unmount } = render(
      <StoreProvider store={store}>
        <Total deps={['Purchase']} />
        {/* forgot 'amount' */}
      </StoreProvider>,
    );
    expect(getByTestId('total').textContent).toBe('180');
    act(() => {
      store.mutate((g) => g.query("MATCH (o:Purchase {oid: 'o1'}) SET o.amount = 999"));
    });
    const rendered = getByTestId('total').textContent;
    const fresh = (
      store.graph.query('MATCH (o:Purchase) RETURN sum(o.amount) AS total')[0] as { total: number }
    ).total;
    // The DOM shows the STALE 180; the true value is 1079. This asserts the bug.
    expect(rendered).toBe('180');
    expect(String(fresh)).toBe('1079');
    expect(rendered).not.toBe(String(fresh)); // UI is provably wrong
    unmount();
    store[Symbol.dispose]();
  });

  test('cleanup', () => {
    cleanup();
    expect(true).toBe(true);
  });
});

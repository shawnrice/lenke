import { expect, test } from 'bun:test';
/**
 * React-hook wiring for Maya's knowledge-graph sidebar, exercised headlessly.
 *
 * Two connectors:
 *   A) StoreProvider + useLiveQuery      — local wasm Store, main thread.
 *   B) SyncClientProvider + useClientLiveQuery — the sync client (host+client wired
 *      in-process here; in a real app the host lives in a worker).
 *
 * Run: bun test --preload ./.dogfood/maya/dom-setup.ts .dogfood/maya/hooks.test.tsx
 */
import { readFile } from 'node:fs/promises';

import { createEmptyGraph, createStore } from '@lenke/native';
import { createWasmBackend } from '@lenke/native/wasm';
import { StoreProvider, useLiveQuery, SyncClientProvider, useClientLiveQuery } from '@lenke/react';
import { createSyncHost, createSyncClient, type SyncClient } from '@lenke/sync';
import { act, render, screen, waitFor } from '@testing-library/react';
import * as React from 'react';

const WASM =
  '/home/shawn/projects/pl-graph/crates/lenke-core/target/wasm32-unknown-unknown/release/lenke_core.wasm';

const backend = await createWasmBackend(await readFile(WASM));

const seed = (store: ReturnType<typeof createStore>) => {
  store.mutate((g) => {
    g.query(`INSERT (:Note {id: 'a', title: 'Graph databases'})`);
    g.query(`INSERT (:Note {id: 'b', title: 'Columnar storage'})`);
    g.query(`MATCH (a:Note {id: 'a'}), (b:Note {id: 'b'}) INSERT (b)-[:LINKS_TO]->(a)`);
  });
};

// Param form — usable by useClientLiveQuery (which HAS a `params` option).
const BACKLINKS_PARAM = `MATCH (src:Note)-[:LINKS_TO]->(:Note {id: $id}) RETURN src.title AS title`;
// Inlined form — useLiveQuery has NO `params` option, so $id can't be bound.
const BACKLINKS_LITERAL = `MATCH (src:Note)-[:LINKS_TO]->(:Note {id: 'a'}) RETURN src.title AS title`;
const DEPS = ['Note', 'LINKS_TO', 'id', 'title'];

// ---------------------------------------------------------------------------
// Connector A: StoreProvider + useLiveQuery
// ---------------------------------------------------------------------------
test('useLiveQuery re-renders the sidebar after a mutation', async () => {
  using store = createStore(createEmptyGraph(backend));
  seed(store);

  let renders = 0;
  function Sidebar() {
    renders++;
    // useLiveQuery's option type is only `{ deps? }` — no `params` field — so
    // we can't bind $id through the hook. Inline the id literal instead.
    const rows = useLiveQuery(BACKLINKS_LITERAL, { deps: DEPS });
    return (
      <ul data-testid="backlinks">
        {rows.map((r, i) => (
          <li key={i}>{String(r.title)}</li>
        ))}
      </ul>
    );
  }

  render(
    // KNOWN TYPE FRICTION (TS2322): `Store` is NOT assignable to the
    // `ReactiveStore` prop `StoreProvider` accepts — the real `Store.liveQuery`
    // *requires* `{ deps }`, but `ReactiveStore.liveQuery` declares `opts?`
    // optional, so the function types are incompatible. Runs fine; tsc rejects
    // the exact pattern the README/main-thread guide shows.
    // @ts-expect-error see note above
    <StoreProvider store={store}>
      <Sidebar />
    </StoreProvider>,
  );

  // Initially only note 'b' links to 'a'.
  expect(screen.getByTestId('backlinks').textContent).toBe('Columnar storage');
  const rendersAfterMount = renders;

  // Mutation: add note c that links to a.
  act(() => {
    store.mutate((g) => {
      g.query(`INSERT (:Note {id: 'c', title: 'Arrow interchange'})`);
      g.query(`MATCH (c:Note {id: 'c'}), (a:Note {id: 'a'}) INSERT (c)-[:LINKS_TO]->(a)`);
    });
  });

  await waitFor(() => {
    expect(screen.getByTestId('backlinks').textContent).toContain('Arrow interchange');
  });
  expect(renders).toBeGreaterThan(rendersAfterMount); // it actually re-rendered
});

test('useLiveQuery WITHOUT deps throws (doc says omit for coarse mode)', () => {
  using store = createStore(createEmptyGraph(backend));
  function Bad() {
    // React README: "Omit deps for the always-correct coarse mode." But the
    // hook forwards `undefined` opts to store.liveQuery, which dereferences
    // opts.deps -> TypeError.
    const rows = useLiveQuery(BACKLINKS_LITERAL);
    return <div>{rows.length}</div>;
  }
  expect(() =>
    render(
      // @ts-expect-error same Store -> ReactiveStore TS2322 as above
      <StoreProvider store={store}>
        <Bad />
      </StoreProvider>,
    ),
  ).toThrow();
});

// ---------------------------------------------------------------------------
// Connector B: SyncClientProvider + useClientLiveQuery
// ---------------------------------------------------------------------------
test('useClientLiveQuery renders + re-renders through the sync client', async () => {
  using store = createStore(createEmptyGraph(backend));
  seed(store);

  // Wire host <-> client in-process (in a real app: postMessage across a worker).
  // Order matters: createSyncHost calls sendStatus() synchronously at
  // construction, so the client must already exist. (Building host-first with a
  // `let client` closure throws "undefined is not an object".)
  let host: ReturnType<typeof createSyncHost>;
  const client: SyncClient = createSyncClient({ send: (m) => host.receive(m) });
  host = createSyncHost(store, { send: (m) => client.receive(m) });

  function Sidebar() {
    const { rows, complete } = useClientLiveQuery(BACKLINKS_PARAM, {
      deps: DEPS,
      params: { id: 'a' },
    });
    return (
      <div>
        <span data-testid="complete">{String(complete)}</span>
        <ul data-testid="backlinks">
          {rows.map((r, i) => (
            <li key={i}>{String(r.title)}</li>
          ))}
        </ul>
      </div>
    );
  }

  render(
    <SyncClientProvider client={client}>
      <Sidebar />
    </SyncClientProvider>,
  );

  // The client pushes the first result asynchronously (host answers the subscribe).
  await waitFor(() => {
    expect(screen.getByTestId('backlinks').textContent).toBe('Columnar storage');
  });

  // Optimistic write through the client -> host applies -> subscription re-pushes.
  await act(async () => {
    await client.mutate(`INSERT (:Note {id: 'c', title: 'Arrow interchange'})`);
    await client.mutate(`MATCH (c:Note {id: 'c'}), (a:Note {id: 'a'}) INSERT (c)-[:LINKS_TO]->(a)`);
  });

  await waitFor(() => {
    expect(screen.getByTestId('backlinks').textContent).toContain('Arrow interchange');
  });
});

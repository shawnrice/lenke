// Headless React proof for BOTH connectors. Run: bun run-react.tsx
import { registerDom } from './happydom.ts';
registerDom(); // must run before @testing-library/react is imported

import * as React from 'react';
import { act, render, cleanup } from '@testing-library/react';
import { createSyncClient, createSyncHost } from '@lenke/sync';

import { createNotesStore, addLinkingNote } from './notes-store.ts';
import { StoreApp, ClientApp } from './react-app.tsx';

let failures = 0;
const check = (label: string, cond: boolean) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} — ${label}`);
  if (!cond) failures++;
};
const texts = (root: HTMLElement, testid: string) =>
  [...root.querySelectorAll(`[data-testid="${testid}"] li`)].map((li) => li.textContent);

// ---------- Connector A: StoreProvider + useLiveQuery (real wasm store) ----------
console.log('A) StoreProvider + useLiveQuery over the wasm store');
const storeA = await createNotesStore();
{
  const { container } = render(<StoreApp store={storeA} noteId="n-graphs" />);
  const root = container as unknown as HTMLElement;

  const before = texts(root, 'store-backlinks');
  check(`initial backlinks render: ${JSON.stringify(before)}`, before.length === 2);
  check('initial tags render', texts(root, 'store-tags').length === 3);

  // Mutate the store -> hook must re-render with the new backlink.
  act(() => {
    addLinkingNote(storeA, { id: 'n-idx', title: 'Property indexes' }, 'n-graphs');
  });

  const after = texts(root, 'store-backlinks');
  check(`backlinks re-rendered after mutate: ${JSON.stringify(after)}`, after.length === 3);
  check('new note appears in the list', after.includes('Property indexes'));
  cleanup();
}

// ---------- Connector B: SyncClientProvider + useClientLiveQuery (real sync loop) ----------
console.log('\nB) SyncClientProvider + useClientLiveQuery over a real @lenke/sync client<->host');
const storeB = await createNotesStore();
{
  // In-process wire: client.send -> host.receive, host.send -> client.receive.
  let host: ReturnType<typeof createSyncHost>;
  const client = createSyncClient({ send: (m) => host.receive(m) });
  host = createSyncHost(storeB, { send: (m) => client.receive(m) });

  let root!: HTMLElement;
  await act(async () => {
    const { container } = render(<ClientApp client={client} noteId="n-graphs" />);
    root = container as unknown as HTMLElement;
  });

  // A bare host answers immediately (complete: true), so we should have rows.
  const before = texts(root, 'client-backlinks');
  check(
    `client rows after first push (no skeleton left): ${JSON.stringify(before)}`,
    before.length === 2 && !root.querySelector('[data-testid="client-skeleton"]'),
  );

  // Optimistic write through the client -> host recomputes -> push -> re-render.
  await act(async () => {
    await client.mutate(
      'INSERT (n:Note {id: $id, title: $title, body: $body})',
      { id: 'n-sync', title: 'Sync engine', body: 'b' },
    );
    await client.mutate(
      'MATCH (n:Note {id: $id}), (m:Note {id: $to}) INSERT (n)-[:LINKS_TO]->(m)',
      { id: 'n-sync', to: 'n-graphs' },
    );
  });

  const after = texts(root, 'client-backlinks');
  check(`client backlinks re-rendered after wire mutate: ${JSON.stringify(after)}`, after.length === 3);
  check('synced note appears', after.includes('Sync engine'));
  cleanup();
}
storeA[Symbol.dispose]();
storeB[Symbol.dispose]();

console.log(`\nRESULT: ${failures === 0 ? 'PASS — both React connectors live-update' : `FAIL (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);

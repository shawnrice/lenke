// The two React connectors for the note-app sidebar.
//   A) StoreProvider + useLiveQuery       — local wasm store (main-thread).
//   B) SyncClientProvider + useClientLiveQuery — synced client (worker/wire).
import * as React from 'react';
import { StoreProvider, useLiveQuery, SyncClientProvider, useClientLiveQuery } from '@lenke/react';

import { BACKLINKS, TAG_COUNTS, type Backlink, type TagCount } from './data.ts';

// ---- A) local native/wasm Store connector ----

export function StoreSidebar({ noteId }: { noteId: string }) {
  const backlinks = useLiveQuery<Backlink>(BACKLINKS, {
    deps: ['Note', 'LINKS_TO'],
    params: { id: noteId },
  });
  const tags = useLiveQuery<TagCount>(TAG_COUNTS, { deps: ['Note', 'Tag', 'TAGGED'] });

  return (
    <aside>
      <h2>Backlinks to {noteId}</h2>
      <ul data-testid="store-backlinks">
        {backlinks.map((b) => (
          <li key={b.id}>{b.title}</li>
        ))}
      </ul>
      <h2>Tags</h2>
      <ul data-testid="store-tags">
        {tags.map((t) => (
          <li key={t.name}>
            {t.name}: {t.cnt}
          </li>
        ))}
      </ul>
    </aside>
  );
}

// ReactiveStore is structural — accept it untyped from the test to avoid a
// hard @lenke/native import here.
export function StoreApp({ store, noteId }: { store: any; noteId: string }) {
  return (
    <StoreProvider store={store}>
      <StoreSidebar noteId={noteId} />
    </StoreProvider>
  );
}

// ---- B) synced client connector (honest loading via `complete`) ----

export function ClientSidebar({ noteId }: { noteId: string }) {
  const { rows, complete, error } = useClientLiveQuery<Backlink>(BACKLINKS, {
    deps: ['Note', 'LINKS_TO'],
    params: { id: noteId },
  });

  if (error) return <p data-testid="client-error">failed: {error.message}</p>;
  if (!complete) return <p data-testid="client-skeleton">loading…</p>;
  return (
    <ul data-testid="client-backlinks">
      {rows.map((b) => (
        <li key={b.id}>{b.title}</li>
      ))}
    </ul>
  );
}

export function ClientApp({ client, noteId }: { client: any; noteId: string }) {
  return (
    <SyncClientProvider client={client}>
      <ClientSidebar noteId={noteId} />
    </SyncClientProvider>
  );
}

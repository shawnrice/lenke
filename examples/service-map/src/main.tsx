import { createSyncClient, type ClientLiveQuery, type SyncClient } from '@lenke/sync';
// The tab: a deliberately dumb React view over the sync client — a bare
// <table>, no component library. Everything interesting ends at the
// useSyncExternalStore seam ({ rows, complete, error }); a real grid (e.g.
// stomme's DataGrid) would consume the exact same shape.
import { StrictMode, useCallback, useMemo, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';

import { CLUSTERS } from '../datagen.ts';

// ---------------------------------------------------------------------------
// wiring: one SharedWorker for the whole origin; this tab is one connection
// ---------------------------------------------------------------------------

const worker = new SharedWorker(new URL('../worker.ts', import.meta.url), {
  type: 'module',
  name: 'lenke-service-map',
});
const client: SyncClient = createSyncClient({ send: (m) => worker.port.postMessage(m) });
worker.port.onmessage = (e) => client.receive(e.data);
worker.port.start();

const STATUSES = ['healthy', 'degraded', 'down'] as const;

// The scope token ('cluster:<name>') rides the deps channel: it names the
// demand-fill collection AND is inert as an epoch token. The real tokens
// (Service/status/…) do the invalidation work.
const depsFor = (cluster: string) => ['Service', 'name', 'tier', 'status', `cluster:${cluster}`];

const useLive = (live: ClientLiveQuery) => useSyncExternalStore(live.subscribe, live.getSnapshot);

// ---------------------------------------------------------------------------
// views
// ---------------------------------------------------------------------------

const StatusBar = () => {
  // Poll the client's status line (it updates on every queue/connectivity
  // change the worker relays; a status *subscription* is a later protocol
  // nicety — finding for the list).
  const [, force] = useState(0);
  useMemo(() => {
    setInterval(() => force((n) => n + 1), 1000);
  }, []);
  const status = client.getStatus();

  return (
    <p style={{ fontFamily: 'monospace' }}>
      {status ? `connected · ${status.pendingWrites} unsynced change(s)` : 'connecting…'}
    </p>
  );
};

const BlastRadius = ({ sid }: { sid: string }) => {
  const [affected, setAffected] = useState<string[] | null>(null);

  const compute = useCallback(async () => {
    // Everything transitively upstream of the victim, in ONE query: lenke's
    // GQL has variable-length quantified paths (`->{1,}` = one-or-more CALLS
    // hops), so the whole blast radius is native — `DISTINCT` collapses the
    // multiple paths that reach a caller; no client-side hop-merging.
    const rows = await client.query(
      'MATCH (a:Service)-[:CALLS]->{1,}(x:Service) WHERE x.sid = $sid RETURN DISTINCT a.name ORDER BY a.name',
      { sid },
    );
    setAffected(rows.map((r) => String(r['a.name'])));
  }, [sid]);

  return (
    <span>
      <button type="button" onClick={() => void compute()}>
        blast radius
      </button>
      {affected && <em> {affected.length === 0 ? 'nothing upstream' : affected.join(', ')}</em>}
    </span>
  );
};

const ServiceTable = ({ cluster }: { cluster: string }) => {
  const live = useMemo(
    () =>
      client.liveQuery(
        'MATCH (s:Service) WHERE s.cluster = $c RETURN s.sid, s.name, s.tier, s.status ORDER BY s.tier, s.name',
        { params: { c: cluster }, deps: depsFor(cluster) },
      ),
    [cluster],
  );
  const snap = useLive(live);
  const [selected, setSelected] = useState<string | null>(null);

  if (snap.error) {
    return <p>error: {snap.error.message}</p>;
  }

  return (
    <>
      {!snap.complete && <p>loading {cluster}…</p>}
      <table border={1} cellPadding={4}>
        <thead>
          <tr>
            <th>service</th>
            <th>tier</th>
            <th>status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {snap.rows.map((row) => {
            const sid = String(row['s.sid']);

            return (
              <tr key={sid}>
                <td>{String(row['s.name'])}</td>
                <td>{String(row['s.tier'])}</td>
                <td>
                  <select
                    value={String(row['s.status'])}
                    onChange={(e) =>
                      // Optimistic: the push updates every tab before the
                      // server ever acks; offline it queues.
                      void client.mutate(
                        'MATCH (s:Service) WHERE s.sid = $sid SET s.status = $status',
                        { sid, status: e.target.value },
                      )
                    }
                  >
                    {STATUSES.map((s) => (
                      <option key={s}>{s}</option>
                    ))}
                  </select>
                </td>
                <td>
                  {selected === sid ? (
                    <BlastRadius sid={sid} />
                  ) : (
                    <button type="button" onClick={() => setSelected(sid)}>
                      ?
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
};

const App = () => {
  const [cluster, setCluster] = useState<string>(CLUSTERS[0]);

  return (
    <main style={{ fontFamily: 'sans-serif', margin: '2rem' }}>
      <h1>service map</h1>
      <StatusBar />
      <nav>
        {CLUSTERS.map((c) => (
          <button key={c} type="button" disabled={c === cluster} onClick={() => setCluster(c)}>
            {c}
          </button>
        ))}
      </nav>
      <ServiceTable cluster={cluster} />
    </main>
  );
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

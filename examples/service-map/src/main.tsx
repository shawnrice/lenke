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

// A MessagePort can't signal its tab's death, so say goodbye explicitly —
// without it the worker retains this tab's host (and re-runs its standing
// queries on every change) forever. `pagehide` fires on close, navigation,
// AND bfcache entry; on bfcache revival (`pageshow` persisted) replay every
// standing query — the worker mints a fresh host, which re-answers each one.
window.addEventListener('pagehide', () => worker.port.postMessage({ type: 'bye' }));
window.addEventListener('pageshow', (e) => {
  if (e.persisted) {
    client.replay();
  }
});

const STATUSES = ['healthy', 'degraded', 'down'] as const;

// Epoch dependency tokens: the labels/props whose changes must re-run this
// query. `cluster` is included because the query filters on it (`WHERE s.cluster
// = $cluster`) — a reassignment must re-run the standing query, even though
// `cluster` is an immutable partition key in this demo. The demand-fill *scope*
// (which cluster) rides the query's own `$cluster` param, which the worker's
// keyed `services` collection reads directly.
const deps = ['Service', 'name', 'tier', 'status', 'cluster'];

const useLive = (live: ClientLiveQuery) => useSyncExternalStore(live.subscribe, live.getSnapshot);

// The table's columns — sortable, and now showing how each service *connects*:
// `calls →` is its out-degree (services it depends on) and `← callers` its
// in-degree (services that depend on it). A high caller count IS the blast
// radius at a glance; sort by it to surface the services whose failure hurts
// most. Both come free from GQL `COUNT { … }` correlated subqueries in the live
// query, so they stay live as the graph changes.
const TIER_RANK: Record<string, number> = { edge: 0, api: 1, core: 2, data: 3 };
type ColKind = 'str' | 'tier' | 'num';
type Column = { key: string; label: string; kind: ColKind };
const COLUMNS: readonly Column[] = [
  { key: 's.name', label: 'service', kind: 'str' },
  { key: 's.tier', label: 'tier', kind: 'tier' },
  { key: 'calls', label: 'calls →', kind: 'num' },
  { key: 'callers', label: '← callers', kind: 'num' },
  { key: 's.status', label: 'status', kind: 'str' },
];

const sortArrow = (active: boolean, dir: 1 | -1): string => {
  if (!active) {
    return '';
  }

  return dir === 1 ? ' ▲' : ' ▼';
};

// Row tint: a `down` service is red; a service transitively depending on one
// (in the live blast radius) is amber.
const rowBackground = (isDown: boolean, isImpacted: boolean): string | undefined => {
  if (isDown) {
    return '#3a1a1a';
  }

  return isImpacted ? '#3a2a12' : undefined;
};

const compareCol = (a: unknown, b: unknown, kind: ColKind): number => {
  if (kind === 'num') {
    return Number(a) - Number(b);
  }

  if (kind === 'tier') {
    return (TIER_RANK[String(a)] ?? 9) - (TIER_RANK[String(b)] ?? 9);
  }

  return String(a).localeCompare(String(b));
};

// ---------------------------------------------------------------------------
// views
// ---------------------------------------------------------------------------

const StatusBar = () => {
  // Reactive, poll-free: the host pushes `status` on every queue/connectivity
  // change and the client wakes onStatus subscribers — straight into
  // useSyncExternalStore, no interval.
  const status = useSyncExternalStore(client.onStatus, client.getStatus);

  if (!status) {
    return <p style={{ fontFamily: 'monospace' }}>connecting…</p>;
  }

  // `connected` here is the worker→server link. Offline it stays false and every
  // cluster's rows never demand-fill — the tables would sit on "loading…". Say
  // so plainly rather than let it look like a slow load.
  if (!status.connected) {
    return (
      <p style={{ fontFamily: 'monospace', color: '#b45309' }}>
        server offline — start it too (<code>npm run dev</code> runs both the server and the app)
      </p>
    );
  }

  return (
    <p style={{ fontFamily: 'monospace' }}>connected · {status.pendingWrites} unsynced change(s)</p>
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
        // `calls`/`callers` are the out/in degree via correlated COUNT {…}
        // subqueries; `$cluster` is the only value and it's a bound param, so the
        // text is fully static (no interpolation).
        'MATCH (s:Service) WHERE s.cluster = $cluster RETURN s.sid, s.name, s.tier, s.status, COUNT { (s)-[:CALLS]->(x) } AS calls, COUNT { (y)-[:CALLS]->(s) } AS callers ORDER BY s.tier, s.name',
        // key: s.sid → the host sends keyed diffs, so flipping one service's
        // status re-ships one cell, not the whole cluster's rows.
        { params: { cluster }, deps, key: 's.sid' },
      ),
    [cluster],
  );
  const snap = useLive(live);

  // The live blast radius: every service in this cluster that transitively calls
  // a service currently marked `down`. One variable-length quantified path
  // (`->{1,}` = one-or-more CALLS hops) does the whole reachability, and because
  // it's a LIVE query keyed on `status`, flipping any service to `down` makes its
  // dependents light up here immediately — across every tab. This is the demo's
  // point: reachability straight from the graph, reactive and shared.
  const impactLive = useMemo(
    () =>
      client.liveQuery(
        "MATCH (a:Service)-[:CALLS]->{1,}(x:Service) WHERE x.status = 'down' AND a.cluster = $cluster RETURN DISTINCT a.sid",
        { params: { cluster }, deps, key: 'a.sid' },
      ),
    [cluster],
  );
  const impactSnap = useLive(impactLive);
  const impacted = useMemo(
    () => new Set(impactSnap.rows.map((r) => String(r['a.sid']))),
    [impactSnap.rows],
  );

  const [selected, setSelected] = useState<string | null>(null);
  // Default to most-depended-on first: the services whose failure hurts most.
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 }>({ key: 'callers', dir: -1 });

  const sortedRows = useMemo(() => {
    const kind = COLUMNS.find((c) => c.key === sort.key)?.kind ?? 'str';

    return [...snap.rows].sort((a, b) => {
      const c = compareCol(a[sort.key], b[sort.key], kind) * sort.dir;

      // Tie-break by name so the order is always stable and deterministic.
      return c !== 0 ? c : String(a['s.name']).localeCompare(String(b['s.name']));
    });
  }, [snap.rows, sort]);

  const toggleSort = (key: string): void =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: 1 }));

  if (snap.error) {
    return <p>error: {snap.error.message}</p>;
  }

  return (
    <>
      {!snap.complete && <p>loading {cluster}…</p>}
      {impacted.size > 0 && (
        <p style={{ color: '#b91c1c', fontFamily: 'monospace' }}>
          ⚠ {impacted.size} service(s) impacted by a downstream outage — set a service to{' '}
          <code>down</code> and watch its callers light up.
        </p>
      )}
      <table border={1} cellPadding={4}>
        <thead>
          <tr>
            {COLUMNS.map((c) => (
              <th
                key={c.key}
                onClick={() => toggleSort(c.key)}
                title="click to sort"
                style={{ cursor: 'pointer', userSelect: 'none' }}
              >
                {c.label}
                {sortArrow(sort.key === c.key, sort.dir)}
              </th>
            ))}
            <th />
          </tr>
        </thead>
        <tbody>
          {sortedRows.map((row) => {
            const sid = String(row['s.sid']);
            const isDown = String(row['s.status']) === 'down';
            const isImpacted = impacted.has(sid);

            return (
              <tr key={sid} style={{ background: rowBackground(isDown, isImpacted) }}>
                <td>
                  {isImpacted && !isDown ? '⚠ ' : ''}
                  {String(row['s.name'])}
                </td>
                <td>{String(row['s.tier'])}</td>
                <td style={{ textAlign: 'right' }}>{String(row.calls)}</td>
                <td style={{ textAlign: 'right' }}>{String(row.callers)}</td>
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
                      blast radius
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

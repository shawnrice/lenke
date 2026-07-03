// Deterministic microservice-topology generator (xorshift, same discipline as
// benchmarks/datagen.ts — no Math.random, same seed → same fleet).
//
// Shape: 4 clusters × ~60 services in tiers (edge → api → core → data); calls
// flow tier-downward within a cluster plus a sprinkle of cross-cluster calls,
// so blast-radius traversals have real depth and the clusters aren't islands.

export type ServiceRec = {
  sid: string;
  name: string;
  cluster: string;
  tier: 'edge' | 'api' | 'core' | 'data';
  status: 'healthy' | 'degraded' | 'down';
};

export type CallRec = {
  cid: string;
  from: string;
  to: string;
  protocol: 'http' | 'grpc' | 'sql' | 'queue';
  p95: number;
};

export type Fleet = {
  services: ServiceRec[];
  calls: CallRec[];
  ndjson: string;
  clusters: string[];
};

export const CLUSTERS = ['prod-east', 'prod-west', 'staging', 'tools'] as const;

const TIERS = ['edge', 'api', 'core', 'data'] as const;
const TIER_SIZES = { edge: 8, api: 18, core: 22, data: 12 } as const;
const NOUNS = [
  'auth',
  'billing',
  'catalog',
  'checkout',
  'crawler',
  'dispatch',
  'export',
  'feed',
  'gateway',
  'geo',
  'graph',
  'index',
  'ingest',
  'inventory',
  'ledger',
  'mailer',
  'media',
  'metrics',
  'notify',
  'orders',
  'pricing',
  'profile',
  'queue',
  'quota',
  'rating',
  'render',
  'report',
  'search',
  'session',
  'shard',
  'stream',
  'sync',
  'tags',
  'tax',
  'thumbs',
  'tokens',
  'usage',
  'vault',
  'webhook',
  'worker',
] as const;
const PROTOCOLS = { edge: 'http', api: 'grpc', core: 'grpc', data: 'sql' } as const;

export const generateFleet = (seed = 0x5eed_1e11): Fleet => {
  let s = seed >>> 0;
  const rnd = (): number => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;

    return (s >>> 0) / 0xff_ff_ff_ff;
  };
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];

  const services: ServiceRec[] = [];
  const calls: CallRec[] = [];
  const byClusterTier = new Map<string, ServiceRec[]>();

  for (const cluster of CLUSTERS) {
    for (const tier of TIERS) {
      const bucket: ServiceRec[] = [];
      byClusterTier.set(`${cluster}/${tier}`, bucket);

      for (let i = 0; i < TIER_SIZES[tier]; i += 1) {
        const svc: ServiceRec = {
          sid: `${cluster}:${tier}-${i}`,
          name: `${pick(NOUNS)}-${tier}-${i}`,
          cluster,
          tier,
          status: 'healthy',
        };
        services.push(svc);
        bucket.push(svc);
      }
    }
  }

  // Calls: each service calls 1–3 services one tier down in its own cluster;
  // ~5% of services also call across clusters (same tier boundary).
  let cid = 0;

  for (const svc of services) {
    const tierIdx = TIERS.indexOf(svc.tier);

    if (tierIdx === TIERS.length - 1) {
      continue; // data tier calls nobody
    }

    const downstream = byClusterTier.get(`${svc.cluster}/${TIERS[tierIdx + 1]}`)!;
    const fanOut = 1 + Math.floor(rnd() * 3);

    for (let i = 0; i < fanOut; i += 1) {
      const to = pick(downstream);
      calls.push({
        cid: `c${cid++}`,
        from: svc.sid,
        to: to.sid,
        protocol: PROTOCOLS[to.tier === 'data' ? 'data' : svc.tier],
        p95: Math.round(2 + rnd() * 120),
      });
    }

    if (rnd() < 0.05) {
      const other = pick(CLUSTERS.filter((c) => c !== svc.cluster));
      const target = pick(byClusterTier.get(`${other}/${TIERS[tierIdx + 1]}`)!);
      calls.push({
        cid: `c${cid++}`,
        from: svc.sid,
        to: target.sid,
        protocol: 'queue',
        p95: Math.round(10 + rnd() * 300),
      });
    }
  }

  const lines = [
    ...services.map((v) =>
      JSON.stringify({
        type: 'node',
        id: v.sid,
        labels: ['Service'],
        properties: {
          sid: v.sid,
          name: v.name,
          cluster: v.cluster,
          tier: v.tier,
          status: v.status,
        },
      }),
    ),
    ...calls.map((e) =>
      JSON.stringify({
        type: 'edge',
        id: e.cid,
        from: e.from,
        to: e.to,
        labels: ['CALLS'],
        properties: { cid: e.cid, protocol: e.protocol, p95: e.p95 },
      }),
    ),
  ];

  return { services, calls, ndjson: lines.join('\n'), clusters: [...CLUSTERS] };
};

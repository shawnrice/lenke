// Round 7 dogfood — Sunita: sensor telemetry + windowed analytics on @lenke.
// Model: (Reading)-[:MEASURED_BY]->(Device)-[:LOCATED_AT]->(Site). Reading carries a DATETIME `ts`
// and a numeric `value`. Every windowed/aggregate result is verified against an
// independent JS computation over the same generated data.

import { Graph, parseDateTime, type Temporal } from '@lenke/core';
import { query } from '@lenke/gql';

// ---------------------------------------------------------------- seeded RNG
function mulberry32(seed: number) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(42);

// ---------------------------------------------------------------- time helpers
const EPOCH = Date.UTC(2026, 6, 1, 0, 0, 0); // 2026-07-01T00:00:00Z
function iso(msFromEpoch: number): string {
  const d = new Date(EPOCH + msFromEpoch);
  // local_datetime style ISO, no zone, second precision
  return d.toISOString().slice(0, 19);
}
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// ---------------------------------------------------------------- data model (JS side)
interface JReading {
  deviceId: string;
  siteId: string;
  tsMs: number; // ms from EPOCH
  tsIso: string;
  value: number;
}

const SITES = ['site-north', 'site-south', 'site-east', 'site-west', 'site-central'];
const DEVICES_PER_SITE = 8;
const SPAN_DAYS = 3;
const INTERVAL = 5 * MIN; // reading every 5 min

const g = new Graph();
const siteV: Record<string, ReturnType<Graph['addVertex']>> = {};
const deviceV: Record<string, ReturnType<Graph['addVertex']>> = {};
for (const s of SITES) siteV[s] = g.addVertex({ labels: ['Site'], properties: { id: s } });

const jReadings: JReading[] = [];
let deviceNum = 0;
for (const s of SITES) {
  for (let k = 0; k < DEVICES_PER_SITE; k++) {
    const did = `dev-${String(deviceNum++).padStart(3, '0')}`;
    const baseline = 20 + rnd() * 30; // device baseline temp-ish
    deviceV[did] = g.addVertex({ labels: ['Device'], properties: { id: did, site: s } });
    g.addEdge({ from: deviceV[did], to: siteV[s], labels: ['LOCATED_AT'], properties: {} });

    const nPts = (SPAN_DAYS * DAY) / INTERVAL;
    for (let i = 0; i < nPts; i++) {
      const tsMs = i * INTERVAL;
      const hourOfDay = (tsMs % DAY) / HOUR;
      // daily sinusoid + noise
      let value = baseline + 8 * Math.sin((hourOfDay / 24) * 2 * Math.PI) + (rnd() - 0.5) * 4;
      // inject occasional anomaly spikes (~0.5%)
      if (rnd() < 0.005) value += 40 + rnd() * 20;
      value = Math.round(value * 1000) / 1000; // 3 decimals, exact in both engines
      const tsIso = iso(tsMs);
      jReadings.push({ deviceId: did, siteId: s, tsMs, tsIso, value });
      const rv = g.addVertex({
        labels: ['Reading'],
        properties: { ts: parseDateTime(tsIso), value, device: did, site: s },
      });
      g.addEdge({ from: rv, to: deviceV[did], labels: ['MEASURED_BY'], properties: {} });
    }
  }
}
console.log(
  `built graph: ${SITES.length} sites, ${deviceNum} devices, ${jReadings.length} readings ` +
    `spanning ${SPAN_DAYS} days @ ${INTERVAL / MIN}min`,
);

// "now" = just after the last reading
const NOW_MS = SPAN_DAYS * DAY - INTERVAL + 30 * MIN; // a bit past last point
const NOW_ISO = iso(NOW_MS);
const nowParam = { __now: parseDateTime(NOW_ISO) };
console.log(`NOW = ${NOW_ISO}\n`);

// ---------------------------------------------------------------- verify helpers
let pass = 0;
let fail = 0;
const approx = (a: number, b: number, eps = 1e-9) =>
  Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));
function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}  ${detail}`);
  }
}
const rows = (q: string, p?: Record<string, unknown>) =>
  query(g, q, p) as Record<string, unknown>[];
const one = (q: string, p?: Record<string, unknown>) => rows(q, p)[0];

// ================================================================ 1. TIME WINDOWS
console.log('=== 1. TIME-WINDOW QUERIES (as-of via current_timestamp - DURATION) ===');

// last 1 hour
for (const [label, dur, ms] of [
  ['PT1H', 'PT1H', HOUR],
  ['PT6H', 'PT6H', 6 * HOUR],
  ['P1D', 'P1D', DAY],
] as const) {
  // form A: r.ts >= current_timestamp - DURATION
  const gotA = one(
    `MATCH (r:Reading) WHERE r.ts >= current_timestamp - DURATION '${dur}' RETURN count(r) AS c`,
    nowParam,
  ).c as number;
  // form B (instant-arith, the recommended form since DURATION relcompare is UNKNOWN):
  const gotB = one(
    `MATCH (r:Reading) WHERE r.ts + DURATION '${dur}' >= current_timestamp RETURN count(r) AS c`,
    nowParam,
  ).c as number;
  const jsCount = jReadings.filter((r) => r.tsMs >= NOW_MS - ms).length;
  check(
    `window last ${label} (form A r.ts >= now-dur)`,
    gotA === jsCount,
    `gql=${gotA} js=${jsCount}`,
  );
  check(
    `window last ${label} (form B r.ts+dur >= now)`,
    gotB === jsCount,
    `gql=${gotB} js=${jsCount}`,
  );
}

// between two DATETIMEs
{
  const loIso = iso(DAY); // start of day 2
  const hiIso = iso(2 * DAY); // start of day 3
  const got = one(
    `MATCH (r:Reading) WHERE r.ts >= DATETIME '${loIso}' AND r.ts < DATETIME '${hiIso}' RETURN count(r) AS c`,
  ).c as number;
  const js = jReadings.filter((r) => r.tsMs >= DAY && r.tsMs < 2 * DAY).length;
  check(`between [${loIso}, ${hiIso})`, got === js, `gql=${got} js=${js}`);
}

// ================================================================ 2. WINDOWED AGG / DOWNSAMPLING
console.log('\n=== 2. WINDOWED AGGREGATION / DOWNSAMPLING (substring bucket workaround) ===');
// Bucket key = ISO-string prefix. hour = chars 1..13 ("YYYY-MM-DDThh"), day = 1..10.
// substring is 1-BASED (SQL FROM/FOR), so start MUST be 1, not 0.

// -- hourly buckets for a single device, min/max/avg/sum/count --
{
  const dev = 'dev-000';
  const gqlHourly = rows(
    `MATCH (r:Reading) WHERE r.device = $d
     RETURN substring(to_string(r.ts),1,13) AS hr,
            min(r.\`value\`) AS mn, max(r.\`value\`) AS mx, avg(r.\`value\`) AS av,
            sum(r.\`value\`) AS sm, count(r.\`value\`) AS c
     ORDER BY hr`,
    { d: dev },
  );
  // JS reference
  const jsMap = new Map<string, number[]>();
  for (const r of jReadings.filter((r) => r.deviceId === dev)) {
    const hr = r.tsIso.slice(0, 13);
    (jsMap.get(hr) ?? jsMap.set(hr, []).get(hr)!).push(r.value);
  }
  const jsHourly = [...jsMap.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([hr, vs]) => ({
      hr,
      mn: Math.min(...vs),
      mx: Math.max(...vs),
      av: vs.reduce((a, b) => a + b, 0) / vs.length,
      sm: vs.reduce((a, b) => a + b, 0),
      c: vs.length,
    }));
  let allMatch = gqlHourly.length === jsHourly.length;
  let firstBad = '';
  for (let i = 0; i < Math.min(gqlHourly.length, jsHourly.length); i++) {
    const G = gqlHourly[i] as any;
    const J = jsHourly[i];
    const ok =
      G.hr === J.hr &&
      approx(G.mn, J.mn) &&
      approx(G.mx, J.mx) &&
      approx(G.av, J.av) &&
      approx(G.sm, J.sm) &&
      G.c === J.c;
    if (!ok && !firstBad) firstBad = `bucket#${i} gql=${JSON.stringify(G)} js=${JSON.stringify(J)}`;
    allMatch = allMatch && ok;
  }
  check(
    `hourly downsample ${dev} (${gqlHourly.length} buckets, min/max/avg/sum/count vs JS)`,
    allMatch,
    firstBad,
  );
}

// -- daily buckets across ALL readings --
{
  const gqlDaily = rows(
    `MATCH (r:Reading)
     RETURN substring(to_string(r.ts),1,10) AS \`day\`,
            avg(r.\`value\`) AS av, count(r.\`value\`) AS c, min(r.\`value\`) AS mn, max(r.\`value\`) AS mx
     ORDER BY \`day\``,
  );
  const jsMap = new Map<string, number[]>();
  for (const r of jReadings) {
    const d = r.tsIso.slice(0, 10);
    (jsMap.get(d) ?? jsMap.set(d, []).get(d)!).push(r.value);
  }
  const jsDaily = [...jsMap.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([d, vs]) => ({
      d,
      av: vs.reduce((a, b) => a + b, 0) / vs.length,
      c: vs.length,
      mn: Math.min(...vs),
      mx: Math.max(...vs),
    }));
  let ok = gqlDaily.length === jsDaily.length;
  let bad = '';
  for (let i = 0; i < jsDaily.length; i++) {
    const G = gqlDaily[i] as any;
    const J = jsDaily[i];
    const m =
      G &&
      G.day === J.d &&
      approx(G.av, J.av) &&
      G.c === J.c &&
      approx(G.mn, J.mn) &&
      approx(G.mx, J.mx);
    if (!m && !bad) bad = `gql=${JSON.stringify(G)} js=${JSON.stringify(J)}`;
    ok = ok && m;
  }
  check(`daily downsample ALL (${gqlDaily.length} days, avg/count/min/max vs JS)`, ok, bad);
}

// -- per-device-per-hour (2D grouping) sanity: total count conservation --
{
  const gql2d = rows(
    `MATCH (r:Reading)
     RETURN r.device AS dev, substring(to_string(r.ts),1,13) AS hr, count(r.\`value\`) AS c`,
  );
  const gqlTotal = gql2d.reduce((a, r) => a + (r.c as number), 0);
  check(
    `2D group (device × hour) count conservation`,
    gqlTotal === jReadings.length,
    `sum=${gqlTotal} expected=${jReadings.length}`,
  );
}

// ================================================================ 3. RATE / DELTA
console.log('\n=== 3. RATE / DELTA between consecutive readings ===');
// No window/LAG function in-engine. Workaround: pre-sort with WITH ... ORDER BY,
// collect_list, diff in JS. (collect_list ignores a trailing ORDER BY — must WITH-sort first.)
{
  const dev = 'dev-005';
  const collected = one(
    `MATCH (r:Reading) WHERE r.device = $d
     WITH r ORDER BY r.ts
     RETURN collect_list(r.\`value\`) AS vals, collect_list(to_string(r.ts)) AS tss`,
    { d: dev },
  );
  const vals = collected.vals as number[];
  const tss = collected.tss as string[];
  // engine-side sorted values must equal JS-sorted-by-ts values
  const jsSorted = jReadings.filter((r) => r.deviceId === dev).sort((a, b) => a.tsMs - b.tsMs);
  const orderOk =
    vals.length === jsSorted.length &&
    tss.every((t, i) => t === jsSorted[i].tsIso) &&
    vals.every((v, i) => approx(v, jsSorted[i].value));
  check(`consecutive-order collect (WITH ORDER BY) matches JS`, orderOk);
  // deltas
  const deltas = vals.slice(1).map((v, i) => v - vals[i]);
  const jsDeltas = jsSorted.slice(1).map((r, i) => r.value - jsSorted[i].value);
  check(
    `consecutive deltas match JS (${deltas.length} deltas)`,
    deltas.length === jsDeltas.length && deltas.every((d, i) => approx(d, jsDeltas[i])),
  );

  // duration_between consecutive timestamps (all equal INTERVAL) — probe in-engine:
  const durProbe = one(
    `RETURN duration_between(DATETIME '${jsSorted[0].tsIso}', DATETIME '${jsSorted[1].tsIso}') AS d`,
  );
  console.log(
    `  info  duration_between consecutive = ${JSON.stringify(durProbe.d)} (expect PT300S / 5min)`,
  );
}

// readings-per-hour (rate) for a device = count in a bucket
{
  const dev = 'dev-005';
  const perHour = rows(
    `MATCH (r:Reading) WHERE r.device = $d
     RETURN substring(to_string(r.ts),1,13) AS hr, count(r.\`value\`) AS c ORDER BY hr`,
    { d: dev },
  );
  // full hours should have 12 readings (60/5). first bucket etc.
  const full = perHour.filter((r) => (r.c as number) === 12).length;
  const jsPerHour = new Map<string, number>();
  for (const r of jReadings.filter((r) => r.deviceId === dev)) {
    const hr = r.tsIso.slice(0, 13);
    jsPerHour.set(hr, (jsPerHour.get(hr) ?? 0) + 1);
  }
  const jsFull = [...jsPerHour.values()].filter((c) => c === 12).length;
  check(
    `readings-per-hour rate (full-hour buckets =12) vs JS`,
    full === jsFull,
    `gql=${full} js=${jsFull}`,
  );
}

// ================================================================ 4. ANOMALY FLAGS
console.log('\n=== 4. ANOMALY FLAGS (threshold + z-score via mean/stddev workaround) ===');
// 4a. absolute threshold
{
  const THRESH = 70;
  const got = one(`MATCH (r:Reading) WHERE r.\`value\` > $t RETURN count(r) AS c`, { t: THRESH })
    .c as number;
  const js = jReadings.filter((r) => r.value > THRESH).length;
  check(`threshold value>${THRESH}`, got === js, `gql=${got} js=${js}`);
}
// 4b. z-score workaround: population stddev via sum + sum(power(v,2)) in one pass, per device.
{
  const dev = 'dev-010';
  const stats = one(
    `MATCH (r:Reading) WHERE r.device = $d
     RETURN count(r.\`value\`) AS n, sum(r.\`value\`) AS s, sum(power(r.\`value\`,2)) AS ss`,
    { d: dev },
  );
  const n = stats.n as number;
  const s = stats.s as number;
  const ss = stats.ss as number;
  const mean = s / n;
  const varPop = ss / n - mean * mean;
  const std = Math.sqrt(varPop);
  // JS reference
  const vs = jReadings.filter((r) => r.deviceId === dev).map((r) => r.value);
  const jsMean = vs.reduce((a, b) => a + b, 0) / vs.length;
  const jsVar = vs.reduce((a, x) => a + (x - jsMean) ** 2, 0) / vs.length;
  const jsStd = Math.sqrt(jsVar);
  check(`z-score prep: mean vs JS`, approx(mean, jsMean, 1e-7), `gql=${mean} js=${jsMean}`);
  check(`z-score prep: stddev vs JS`, approx(std, jsStd, 1e-6), `gql=${std} js=${jsStd}`);
  // flag readings with |z|>3, computed in-engine using the derived mean/std as params
  const zThresh = 3;
  const flagged = one(
    `MATCH (r:Reading) WHERE r.device = $d
       AND (r.\`value\` - $mean) / $std > $z
     RETURN count(r) AS c`,
    { d: dev, mean, std, z: zThresh },
  ).c as number;
  const jsFlagged = vs.filter((v) => (v - jsMean) / jsStd > zThresh).length;
  check(
    `z-score anomaly flag |z|>${zThresh} (mean/std as params)`,
    flagged === jsFlagged,
    `gql=${flagged} js=${jsFlagged}`,
  );
}

// ================================================================ 5. HIERARCHY ROLLUPS
console.log('\n=== 5. SITE-LEVEL ROLLUPS across the device hierarchy ===');
{
  const gqlSite = rows(
    `MATCH (r:Reading)-[:MEASURED_BY]->(d:Device)-[:LOCATED_AT]->(s:Site)
     RETURN s.id AS site, avg(r.\`value\`) AS av, count(r.\`value\`) AS c, max(r.\`value\`) AS mx
     ORDER BY site`,
  );
  const jsMap = new Map<string, number[]>();
  for (const r of jReadings)
    (jsMap.get(r.siteId) ?? jsMap.set(r.siteId, []).get(r.siteId)!).push(r.value);
  const jsSite = [...jsMap.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([site, vs]) => ({
      site,
      av: vs.reduce((a, b) => a + b, 0) / vs.length,
      c: vs.length,
      mx: Math.max(...vs),
    }));
  let ok = gqlSite.length === jsSite.length;
  let bad = '';
  for (let i = 0; i < jsSite.length; i++) {
    const G = gqlSite[i] as any;
    const J = jsSite[i];
    const m =
      G && G.site === J.site && approx(G.av, J.av, 1e-7) && G.c === J.c && approx(G.mx, J.mx);
    if (!m && !bad) bad = `gql=${JSON.stringify(G)} js=${JSON.stringify(J)}`;
    ok = ok && m;
  }
  check(`site rollup via graph hierarchy traversal (avg/count/max vs JS)`, ok, bad);
}
// site rollup restricted to a time window (last day) — combines traversal + as-of
{
  const gqlSite = rows(
    `MATCH (r:Reading)-[:MEASURED_BY]->(d:Device)-[:LOCATED_AT]->(s:Site)
     WHERE r.ts + DURATION 'P1D' >= current_timestamp
     RETURN s.id AS site, avg(r.\`value\`) AS av, count(r.\`value\`) AS c
     ORDER BY site`,
    nowParam,
  );
  const cutoff = NOW_MS - DAY;
  const jsMap = new Map<string, number[]>();
  for (const r of jReadings.filter((r) => r.tsMs >= cutoff))
    (jsMap.get(r.siteId) ?? jsMap.set(r.siteId, []).get(r.siteId)!).push(r.value);
  const jsSite = [...jsMap.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([site, vs]) => ({ site, av: vs.reduce((a, b) => a + b, 0) / vs.length, c: vs.length }));
  let ok = gqlSite.length === jsSite.length;
  let bad = '';
  for (let i = 0; i < jsSite.length; i++) {
    const G = gqlSite[i] as any;
    const J = jsSite[i];
    const m = G && G.site === J.site && approx(G.av, J.av, 1e-7) && G.c === J.c;
    if (!m && !bad) bad = `gql=${JSON.stringify(G)} js=${JSON.stringify(J)}`;
    ok = ok && m;
  }
  check(`windowed site rollup (last 1d + hierarchy) vs JS`, ok, bad);
}

// ================================================================ REPORT
console.log(`\n================ RESULT: ${pass} passed, ${fail} failed ================`);
if (fail > 0) process.exitCode = 1;

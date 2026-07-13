import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';

// ---- Dataset: real-ish places with lat/lng + numeric attrs ----
type Place = { name: string; lat: number; lng: number; price: number; rating: number; pop: number };
const CITIES: Place[] = [
  { name: 'San Francisco', lat: 37.7749295, lng: -122.4194155, price: 4, rating: 4.5, pop: 873965 },
  { name: 'Oakland', lat: 37.8043637, lng: -122.2711137, price: 3, rating: 4.1, pop: 440646 },
  { name: 'San Jose', lat: 37.3382082, lng: -121.8863286, price: 3, rating: 3.9, pop: 1013240 },
  { name: 'Sacramento', lat: 38.5815719, lng: -121.4943996, price: 2, rating: 3.7, pop: 524943 },
  { name: 'Los Angeles', lat: 34.0522342, lng: -118.2436849, price: 4, rating: 4.2, pop: 3898747 },
  { name: 'San Diego', lat: 32.715738, lng: -117.1610838, price: 3, rating: 4.4, pop: 1386932 },
  { name: 'Fresno', lat: 36.7377981, lng: -119.7871247, price: 1, rating: 3.2, pop: 542107 },
  { name: 'New York', lat: 40.7127753, lng: -74.0059728, price: 5, rating: 4.6, pop: 8336817 },
  { name: 'Chicago', lat: 41.8781136, lng: -87.6297982, price: 3, rating: 4.0, pop: 2746388 },
  { name: 'Seattle', lat: 47.6062095, lng: -122.3320708, price: 4, rating: 4.3, pop: 737015 },
];

// Generate a few hundred synthetic places scattered around the anchors so we
// have hundreds of rows with fully-known coordinates.
const places: Place[] = [...CITIES];
let seed = 12345;
const rand = () => {
  // deterministic LCG so JS + GQL see identical inputs
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
for (let i = 0; i < 400; i++) {
  const base = CITIES[i % CITIES.length];
  places.push({
    name: `${base.name}-sat-${i}`,
    lat: base.lat + (rand() - 0.5) * 2.0,
    lng: base.lng + (rand() - 0.5) * 2.0,
    price: 1 + Math.floor(rand() * 5),
    rating: Math.round((1 + rand() * 4) * 10) / 10,
    pop: Math.floor(rand() * 1_000_000),
  });
}

const g = new Graph();
for (const p of places) g.addVertex({ labels: ['Place'], properties: { ...p } });

// ---- Reference haversine in plain JS ----
const R_KM = 6371.0088;
function haversineJS(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.sqrt(a));
}

// ---- Haversine in GQL, using asin (atan2 is MISSING) and power (no ^) ----
// dist = 2*R*asin( sqrt( sin^2(dLat/2) + cos(lat1)*cos(lat2)*sin^2(dLng/2) ) )
const ORIGIN = CITIES[0]; // San Francisco
const gqlHaversine = `
MATCH (p:Place)
WITH p,
  radians(p.lat - $lat) AS dLat,
  radians(p.lng - $lng) AS dLng,
  radians($lat) AS rlat1,
  radians(p.lat) AS rlat2
WITH p,
  power(sin(dLat / 2), 2) + cos(rlat1) * cos(rlat2) * power(sin(dLng / 2), 2) AS a
RETURN p.name AS name,
  2 * $R * asin(sqrt(a)) AS distKm
ORDER BY distKm ASC
`;

const rows = query(g, gqlHaversine, { lat: ORIGIN.lat, lng: ORIGIN.lng, R: R_KM }) as Array<{
  name: string;
  distKm: number;
}>;

// ---- Verify every computed distance vs JS to 15 sig digits ----
const byName = new Map(places.map((p) => [p.name, p]));
let maxRelErr = 0;
let worst = '';
let mismatches = 0;
for (const r of rows) {
  const p = byName.get(r.name)!;
  const js = haversineJS(ORIGIN.lat, ORIGIN.lng, p.lat, p.lng);
  const rel = js === 0 ? Math.abs(r.distKm) : Math.abs(r.distKm - js) / Math.abs(js);
  if (rel > maxRelErr) {
    maxRelErr = rel;
    worst = `${r.name}: gql=${r.distKm} js=${js}`;
  }
  if (rel > 1e-15) mismatches++;
}
console.log('=== HAVERSINE (GQL via asin) vs JS ===');
console.log(`places: ${places.length}, rows: ${rows.length}`);
console.log(
  `nearest 5:`,
  rows.slice(0, 5).map((r) => `${r.name}=${r.distKm.toFixed(3)}km`),
);
console.log(`max relative error: ${maxRelErr.toExponential(3)}`);
console.log(`worst: ${worst}`);
console.log(`rows exceeding 1e-15 rel err: ${mismatches}`);

// ---- "within R km" query ----
const within = query(
  g,
  `
MATCH (p:Place)
WITH p,
  power(sin(radians(p.lat - $lat) / 2), 2)
    + cos(radians($lat)) * cos(radians(p.lat)) * power(sin(radians(p.lng - $lng) / 2), 2) AS a
WITH p, 2 * $R * asin(sqrt(a)) AS d
WHERE d <= $maxKm
RETURN count(p) AS n
`,
  { lat: ORIGIN.lat, lng: ORIGIN.lng, R: R_KM, maxKm: 100 },
);
const jsWithin = places.filter(
  (p) => haversineJS(ORIGIN.lat, ORIGIN.lng, p.lat, p.lng) <= 100,
).length;
console.log(
  `\nwithin 100km: gql=${(within[0] as any).n}  js=${jsWithin}  ${(within[0] as any).n === jsWithin ? 'MATCH' : 'DIVERGE'}`,
);

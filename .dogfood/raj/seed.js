// Seed generator for the "who-to-follow" social graph.
// Emits NDJSON (nodes + FOLLOWS edges) as a Buffer. Deterministic (seeded PRNG)
// so runs are reproducible and the query outputs are stable.

// tiny deterministic PRNG (mulberry32)
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CITIES = ['sf', 'nyc', 'berlin', 'tokyo', 'lagos', 'sao_paulo'];

// Build `count` Person nodes [start, start+count) and FOLLOWS edges.
// Returns { nodeLines, edgeLines } arrays of NDJSON strings.
export function makeBatch({ start = 0, count = 1000, avgOut = 8, seed = 1 } = {}) {
  const rand = rng(seed);
  const nodeLines = [];
  const edgeLines = [];

  for (let i = start; i < start + count; i++) {
    const uid = i;
    nodeLines.push(
      JSON.stringify({
        type: 'node',
        id: `p${uid}`,
        labels: ['Person'],
        properties: {
          uid,
          name: `user_${uid}`,
          city: CITIES[i % CITIES.length],
          followers: 0,
        },
      }),
    );
  }

  const total = start + count;
  for (let i = start; i < start + count; i++) {
    const outdeg = 1 + Math.floor(rand() * (avgOut * 2));
    const seen = new Set();
    for (let k = 0; k < outdeg; k++) {
      const target = Math.floor(rand() * total);
      if (target === i || seen.has(target)) continue;
      seen.add(target);
      edgeLines.push(
        JSON.stringify({
          type: 'edge',
          from: `p${i}`,
          to: `p${target}`,
          labels: ['FOLLOWS'],
          properties: { weight: Math.round(rand() * 100) / 100 },
        }),
      );
    }
  }

  return { nodeLines, edgeLines };
}

export function toNdjson(lines) {
  return Buffer.from(lines.join('\n') + '\n', 'utf8');
}

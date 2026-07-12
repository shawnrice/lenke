// Deterministic seed-graph generator for the who-to-follow / fraud service.
// Emits NDJSON bytes (one JSON object per line, `node`/`edge` tagged) — the
// format the backend-embedded guide documents.

// A tiny deterministic PRNG so the graph is identical every run.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = [
  'ada',
  'linus',
  'grace',
  'alan',
  'edsger',
  'barbara',
  'ken',
  'margaret',
  'dennis',
  'radia',
];
const LAST = [
  'lovelace',
  'torvalds',
  'hopper',
  'turing',
  'dijkstra',
  'liskov',
  'thompson',
  'hamilton',
  'ritchie',
  'perlman',
];

export function buildNdjson({ users = 300, seed = 42 } = {}) {
  const rand = mulberry32(seed);
  const lines = [];

  for (let i = 0; i < users; i += 1) {
    const uid = `u${i}`;
    const name = `${FIRST[i % FIRST.length]}-${LAST[(i * 7) % LAST.length]}-${i}`;
    // Fraud-ish signals: a few accounts follow everyone but nobody follows them.
    const bot = rand() < 0.06;
    const accountAgeDays = bot ? Math.floor(rand() * 20) : 30 + Math.floor(rand() * 3000);
    lines.push(
      JSON.stringify({
        type: 'node',
        id: uid,
        labels: ['Person'],
        properties: { uid, name, accountAgeDays, bot },
      }),
    );
  }

  // FOLLOWS edges. Normal users follow a handful of others; bots spray follows.
  let edgeId = 0;
  for (let i = 0; i < users; i += 1) {
    const isBot = i % 17 === 0; // deterministic subset also spray
    const out = isBot ? 40 : 3 + Math.floor(rand() * 8);
    const seen = new Set();
    for (let k = 0; k < out; k += 1) {
      const target = Math.floor(rand() * users);
      if (target === i || seen.has(target)) continue;
      seen.add(target);
      lines.push(
        JSON.stringify({
          type: 'edge',
          id: `e${edgeId++}`,
          from: `u${i}`,
          to: `u${target}`,
          labels: ['FOLLOWS'],
          properties: { since: 2018 + Math.floor(rand() * 7) },
        }),
      );
    }
  }

  return new TextEncoder().encode(lines.join('\n') + '\n');
}

// Generates a deterministic org/social graph as NDJSON.
// Persons carry dept/team/age/level/salary; KNOWS edges wire the social graph.
// Deterministic (seeded LCG) so the analytics run is reproducible.

let seed = 1234567;
const rand = () => {
  // Numerical Recipes LCG → [0,1)
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 0x100000000;
};
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));

const DEPTS = ['Engineering', 'Sales', 'Marketing', 'Support'] as const;
// Two teams per dept — used for the shared-connection / overlap metric.
const TEAMS: Record<string, string[]> = {
  Engineering: ['Platform', 'Product'],
  Sales: ['Enterprise', 'SMB'],
  Marketing: ['Growth', 'Brand'],
  Support: ['Tier1', 'Tier2'],
};

const N = 600;
const lines: string[] = [];

type P = { id: string; dept: string; team: string };
const people: P[] = [];

for (let i = 0; i < N; i++) {
  const dept = pick(DEPTS);
  const team = pick(TEAMS[dept]);
  const id = `p${i}`;
  people.push({ id, dept, team });
  lines.push(
    JSON.stringify({
      type: 'node',
      id,
      labels: ['Person'],
      properties: {
        name: `Person ${i}`,
        dept,
        team,
        age: int(22, 64),
        level: int(1, 7),
        salary: int(50, 250) * 1000,
      },
    }),
  );
}

// Social edges: each person KNOWS a handful of others. Bias toward same-team
// so team overlaps are meaningful, with cross-team links mixed in.
let edgeId = 0;
for (const p of people) {
  const degree = int(1, 12);
  for (let k = 0; k < degree; k++) {
    const sameTeamBias = rand() < 0.6;
    let target: P;
    if (sameTeamBias) {
      const pool = people.filter((q) => q.team === p.team && q.id !== p.id);
      target = pick(pool);
    } else {
      target = pick(people);
    }
    if (!target || target.id === p.id) continue;
    lines.push(
      JSON.stringify({
        type: 'edge',
        id: `e${edgeId++}`,
        from: p.id,
        to: target.id,
        labels: ['KNOWS'],
        properties: { since: int(2010, 2025) },
      }),
    );
  }
}

await Bun.write(new URL('./org-graph.ndjson', import.meta.url).pathname, lines.join('\n') + '\n');
console.log(`wrote ${people.length} persons + ${edgeId} KNOWS edges`);

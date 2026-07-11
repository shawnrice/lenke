// Generate a large Zanzibar-style ReBAC tuple graph as NDJSON.
//   Vertices: User / Group / Resource
//   Edges:    MEMBER_OF (User|Group -> Group), OWNER (User -> Resource),
//             PARENT (Resource -> Resource, child->parent),
//             VIEWER / EDITOR (User|Group -> Resource) grant edges
//
// Deterministic (seeded) so the tricky check() cases are reproducible.
// Writes graph.ndjson and cases.json (known-answer check() cases).

const USERS = Number(process.env.USERS ?? 50_000);
const GROUPS = Number(process.env.GROUPS ?? 4_000);
const RESOURCES = Number(process.env.RESOURCES ?? 120_000);
const GRANTS = Number(process.env.GRANTS ?? 60_000);

// deterministic RNG (mulberry32)
let s = 0x9e3779b9 >>> 0;
const rnd = () => {
  s |= 0;
  s = (s + 0x6d2b79f5) | 0;
  let t = Math.imul(s ^ (s >>> 15), 1 | s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const ri = (n: number) => Math.floor(rnd() * n);

const lines: string[] = [];
const node = (id: string, label: string, props: Record<string, unknown>) =>
  lines.push(JSON.stringify({ type: 'node', id, labels: [label], properties: props }));
let eid = 0;
const edge = (from: string, to: string, label: string) =>
  lines.push(
    JSON.stringify({ type: 'edge', id: `e${eid++}`, from, to, labels: [label], properties: {} }),
  );

// ---- Users ----
for (let i = 0; i < USERS; i++) node(`u${i}`, 'User', { uid: `u${i}` });

// ---- Groups (with nesting forest) ----
for (let i = 0; i < GROUPS; i++) node(`g${i}`, 'Group', { gid: `g${i}` });
// each group except the first 200 roots nests into an earlier group -> forest, bounded depth
for (let i = 200; i < GROUPS; i++) edge(`g${i}`, `g${ri(i)}`, 'MEMBER_OF');

// ---- Resources (PARENT forest) ----
for (let i = 0; i < RESOURCES; i++) node(`r${i}`, 'Resource', { rid: `r${i}` });
for (let i = 500; i < RESOURCES; i++) edge(`r${i}`, `r${ri(i)}`, 'PARENT'); // child -> parent

// ---- User membership: each user in 1-3 groups ----
for (let i = 0; i < USERS; i++) {
  const k = 1 + ri(3);
  for (let j = 0; j < k; j++) edge(`u${i}`, `g${ri(GROUPS)}`, 'MEMBER_OF');
}

// ---- Ownership: each resource owned by a random user ----
for (let i = 0; i < RESOURCES; i++) edge(`u${ri(USERS)}`, `r${i}`, 'OWNER');

// ---- Random grants (VIEWER/EDITOR) from a user or group to a resource ----
for (let i = 0; i < GRANTS; i++) {
  const principal = rnd() < 0.6 ? `g${ri(GROUPS)}` : `u${ri(USERS)}`;
  const res = `r${ri(RESOURCES)}`;
  edge(principal, res, rnd() < 0.5 ? 'EDITOR' : 'VIEWER');
}

// ===== Deterministic known-answer fixtures =====
// direct owner
node('u-owner', 'User', { uid: 'u-owner' });
node('r-owned', 'Resource', { rid: 'r-owned' });
edge('u-owner', 'r-owned', 'OWNER');

// direct viewer (view yes, edit no) & editor (edit yes) on a shared resource
node('u-viewer', 'User', { uid: 'u-viewer' });
node('u-editor', 'User', { uid: 'u-editor' });
node('r-shared', 'Resource', { rid: 'r-shared' });
edge('u-viewer', 'r-shared', 'VIEWER');
edge('u-editor', 'r-shared', 'EDITOR');

// transitive group membership (3 hops) + resource-hierarchy inheritance (2 hops):
//   u-deep -> g-leaf -> g-mid -> g-root ;  g-root EDITOR r-folderA
//   r-deepdoc -> r-sub -> r-folderA   (PARENT chain)
node('u-deep', 'User', { uid: 'u-deep' });
node('u-none', 'User', { uid: 'u-none' }); // control: no grants
node('g-leaf', 'Group', { gid: 'g-leaf' });
node('g-mid', 'Group', { gid: 'g-mid' });
node('g-root', 'Group', { gid: 'g-root' });
node('r-folderA', 'Resource', { rid: 'r-folderA' });
node('r-sub', 'Resource', { rid: 'r-sub' });
node('r-deepdoc', 'Resource', { rid: 'r-deepdoc' });
edge('u-deep', 'g-leaf', 'MEMBER_OF');
edge('g-leaf', 'g-mid', 'MEMBER_OF');
edge('g-mid', 'g-root', 'MEMBER_OF');
edge('g-root', 'r-folderA', 'EDITOR');
edge('r-sub', 'r-folderA', 'PARENT');
edge('r-deepdoc', 'r-sub', 'PARENT');

const cases = [
  { uid: 'u-owner', rid: 'r-owned', edit: true, view: true, why: 'direct owner' },
  { uid: 'u-viewer', rid: 'r-shared', edit: false, view: true, why: 'viewer: view only' },
  { uid: 'u-editor', rid: 'r-shared', edit: true, view: true, why: 'editor: edit+view' },
  {
    uid: 'u-deep',
    rid: 'r-deepdoc',
    edit: true,
    view: true,
    why: '3-hop group + 2-hop resource inheritance',
  },
  { uid: 'u-none', rid: 'r-deepdoc', edit: false, view: false, why: 'no path (negative)' },
  { uid: 'u-deep', rid: 'r-owned', edit: false, view: false, why: 'unrelated resource (negative)' },
  { uid: 'u-owner', rid: 'r-deepdoc', edit: false, view: false, why: 'owner of other resource' },
];

await Bun.write(`${import.meta.dir}/graph.ndjson`, lines.join('\n'));
await Bun.write(`${import.meta.dir}/cases.json`, JSON.stringify(cases, null, 2));
console.log(`wrote ${lines.length} NDJSON lines`);
console.log(`  users=${USERS} groups=${GROUPS} resources=${RESOURCES} grants=${GRANTS}`);

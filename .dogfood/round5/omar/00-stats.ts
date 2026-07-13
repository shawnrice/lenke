import { buildDataset } from './data.ts';
const t0 = Date.now();
const d = buildDataset();
console.log('build ms', Date.now() - t0);
console.log('users', d.users.length, 'items', d.items.length, 'cats', d.categories.length);
console.log('purchased', d.purchased.length, 'viewed', d.viewed.length, 'rated', d.rated.length);
console.log('vertices', d.g.vertexCount ?? '(n/a)', 'edges', d.g.edgeCount ?? '(n/a)');
// most popular item by purchase count (JS ground truth)
const cnt = new Map<string, number>();
for (const p of d.purchased) cnt.set(p.item, (cnt.get(p.item) ?? 0) + 1);
const top = [...cnt.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5);
console.log('top purchased items (JS):', top);

// Proof that the wasm store + liveQuery + mutate loop re-fires on mutation.
// Run: bun run-store.ts

import type { Backlink, TagCount } from './data.ts';
import {
  addLinkingNote,
  backlinksOf,
  createNotesStore,
  tagCounts,
  tagNote,
} from './notes-store.ts';

const fmtBacklinks = (rows: Backlink[]) =>
  rows.length ? rows.map((r) => `${r.title} (${r.id})`).join(', ') : '(none)';
const fmtTags = (rows: TagCount[]) => rows.map((r) => `${r.name}=${r.cnt}`).join('  ');

const store = await createNotesStore();
try {
  const CURRENT = 'n-graphs'; // the note whose sidebar we render

  const backlinks = backlinksOf(store, CURRENT);
  const tags = tagCounts(store);

  let backlinkFires = 0;
  let tagFires = 0;
  backlinks.subscribe(() => {
    backlinkFires++;
    console.log(
      `  >> backlinks live-fire #${backlinkFires}: ${fmtBacklinks(backlinks.getSnapshot())}`,
    );
  });
  tags.subscribe(() => {
    tagFires++;
    console.log(`  >> tag-counts live-fire #${tagFires}: ${fmtTags(tags.getSnapshot())}`);
  });

  console.log(`Sidebar for "${CURRENT}"`);
  console.log(`  version=${store.version}`);
  console.log(`  backlinks : ${fmtBacklinks(backlinks.getSnapshot())}`);
  console.log(`  tag counts: ${fmtTags(tags.getSnapshot())}`);

  const snap0 = backlinks.getSnapshot();
  console.log(`  snapshot stable across calls: ${backlinks.getSnapshot() === snap0}`);

  console.log('\n[mutate #1] add note "Property graphs" that LINKS_TO n-graphs');
  addLinkingNote(store, { id: 'n-pg', title: 'Property graphs' }, CURRENT);

  console.log('\n[mutate #2] tag n-graphs with "frontend"');
  tagNote(store, CURRENT, 'frontend');

  console.log('\n[mutate #3] read-only mutate (no change) — must NOT fire');
  const beforeReadonly = backlinkFires;
  store.mutate((g) => g.query('MATCH (n:Note) RETURN n.id'));
  console.log(
    `  backlink fires unchanged after read-only mutate: ${beforeReadonly === backlinkFires}`,
  );

  console.log('\n[final] sidebar snapshot after mutations');
  console.log(`  version=${store.version}`);
  console.log(`  backlinks : ${fmtBacklinks(backlinks.getSnapshot())}`);
  console.log(`  tag counts: ${fmtTags(tags.getSnapshot())}`);

  const ok =
    backlinkFires >= 1 && tagFires >= 1 && backlinks.getSnapshot().some((r) => r.id === 'n-pg');
  console.log(`\nRESULT: ${ok ? 'PASS — live updates fired after mutation' : 'FAIL'}`);
  if (!ok) process.exit(1);
} finally {
  store[Symbol.dispose]();
}

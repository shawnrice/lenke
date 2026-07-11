/**
 * Maya's "personal knowledge graph" — headless exercise of the BROWSER code path.
 *
 * Notes are :Note vertices, :Tag vertices are tags, [:LINKS_TO] connects notes,
 * [:TAGGED] connects a note to a tag. The "sidebar" is two live queries:
 *   - backlinks: notes that LINK_TO the current note
 *   - tag counts: how many notes carry each tag
 *
 * We drive the wasm backend (the browser reach-path) directly, headlessly, and
 * prove the live queries re-fire after a mutation.
 *
 * Run: bun .dogfood/maya/core.ts
 */
import { readFile } from 'node:fs/promises';

import { createEmptyGraph, createStore } from '@lenke/native';
import { createWasmBackend } from '@lenke/native/wasm';

const WASM =
  '/home/shawn/projects/pl-graph/crates/lenke-core/target/wasm32-unknown-unknown/release/lenke_core.wasm';

const backend = await createWasmBackend(await readFile(WASM));
using store = createStore(createEmptyGraph(backend));

// ---- seed a tiny knowledge base ------------------------------------------
// Two notes tagged, one linking to the other.
store.mutate((g) => {
  g.query(`INSERT (:Note {id: 'a', title: 'Graph databases'})`);
  g.query(`INSERT (:Note {id: 'b', title: 'Columnar storage'})`);
  g.query(`INSERT (:Tag {name: 'db'})`);
  g.query(`INSERT (:Tag {name: 'perf'})`);
  // note b links to note a
  g.query(
    `MATCH (a:Note {id: 'a'}), (b:Note {id: 'b'}) INSERT (b)-[:LINKS_TO]->(a)`,
  );
  // tag both notes with 'db'
  g.query(`MATCH (n:Note {id: 'a'}), (t:Tag {name: 'db'}) INSERT (n)-[:TAGGED]->(t)`);
  g.query(`MATCH (n:Note {id: 'b'}), (t:Tag {name: 'db'}) INSERT (n)-[:TAGGED]->(t)`);
  g.query(`MATCH (n:Note {id: 'a'}), (t:Tag {name: 'perf'}) INSERT (n)-[:TAGGED]->(t)`);
});

// ---- the sidebar: two standing (live) queries ----------------------------
// "notes linking to the current note" (backlinks of note 'a')
const CURRENT = 'a';
const backlinks = store.liveQuery(
  `MATCH (src:Note)-[:LINKS_TO]->(cur:Note {id: $id}) RETURN src.title AS title`,
  { deps: ['Note', 'LINKS_TO', 'id', 'title'], params: { id: CURRENT } },
);

// tag counts across all notes
const tagCounts = store.liveQuery(
  `MATCH (:Note)-[:TAGGED]->(t:Tag) RETURN t.name AS tag, count(*) AS n ORDER BY n DESC, tag`,
  { deps: ['Note', 'TAGGED', 'Tag', 'name'] },
);

// A fake "React re-render": count how many times each live query fires.
let backlinkRenders = 0;
let tagRenders = 0;
backlinks.subscribe(() => {
  backlinkRenders++;
});
tagCounts.subscribe(() => {
  tagRenders++;
});

const showSidebar = (label: string) => {
  console.log(`\n=== sidebar (${label}) ===`);
  console.log('backlinks of note "a":', backlinks.getSnapshot());
  console.log('tag counts          :', tagCounts.getSnapshot());
  console.log(`re-fire counts -> backlinks:${backlinkRenders} tags:${tagRenders}`);
};

showSidebar('initial');

// ---- mutation 1: add a new note that links to 'a' ------------------------
store.mutate((g) => {
  g.query(`INSERT (:Note {id: 'c', title: 'Arrow interchange'})`);
  g.query(`MATCH (c:Note {id: 'c'}), (a:Note {id: 'a'}) INSERT (c)-[:LINKS_TO]->(a)`);
  g.query(`MATCH (c:Note {id: 'c'}), (t:Tag {name: 'db'}) INSERT (c)-[:TAGGED]->(t)`);
});
showSidebar('after adding note c -> a, tagged db');

// ---- mutation 2: a TRULY unrelated write (a different label entirely) -----
// Touches only :Bookmark — none of tagCounts' deps (Note/TAGGED/Tag/name).
// PROOF of epoch gating: getSnapshot must return the SAME array reference, so
// React's useSyncExternalStore bails out of the re-render.
const tagsBefore = tagCounts.getSnapshot();
store.mutate((g) => {
  g.query(`INSERT (:Bookmark {url: 'https://example.com'})`);
});
const tagsAfter = tagCounts.getSnapshot();
console.log('\n=== epoch gating ===');
console.log('unrelated :Bookmark insert -> tagCounts ref identical:', tagsBefore === tagsAfter);
showSidebar('after unrelated :Bookmark insert');

// ---- assertions ----------------------------------------------------------
const finalBacklinks = backlinks.getSnapshot();
const finalTags = tagCounts.getSnapshot();

const ok =
  finalBacklinks.length === 2 &&
  finalTags.some((r) => r.tag === 'db' && Number(r.n) === 3) &&
  finalTags.some((r) => r.tag === 'perf' && Number(r.n) === 1) &&
  backlinkRenders >= 1 &&
  tagRenders >= 1 &&
  tagsBefore === tagsAfter;

console.log('\n=== RESULT ===');
console.log('live queries re-fired at least once:', backlinkRenders >= 1 && tagRenders >= 1);
console.log('backlinks now 2 (b, c):', finalBacklinks.length === 2);
console.log('PASS:', ok);
if (!ok) process.exitCode = 1;

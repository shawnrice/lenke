// Seed for a personal knowledge-graph note app.
// Model:
//   (:Note {id, title, body})
//   (:Tag  {name})
//   (:Note)-[:LINKS_TO]->(:Note)
//   (:Note)-[:TAGGED]->(:Tag)

type Rec =
  | { type: 'node'; id: string; labels: string[]; properties: Record<string, unknown> }
  | {
      type: 'edge';
      id: string;
      from: string;
      to: string;
      labels: string[];
      properties: Record<string, unknown>;
    };

const notes: Array<[id: string, title: string]> = [
  ['n-graphs', 'Graph databases'],
  ['n-gql', 'ISO GQL basics'],
  ['n-wasm', 'Rust in the browser'],
  ['n-react', 'React reactivity'],
];

const tags: string[] = ['db', 'rust', 'frontend'];

// LINKS_TO edges: [from, to]
const links: Array<[string, string]> = [
  ['n-gql', 'n-graphs'], // GQL note links to Graphs note
  ['n-wasm', 'n-graphs'], // wasm note links to Graphs note
  ['n-react', 'n-wasm'], // react note links to wasm note
];

// TAGGED edges: [note, tag]
const tagged: Array<[string, string]> = [
  ['n-graphs', 'db'],
  ['n-gql', 'db'],
  ['n-wasm', 'rust'],
  ['n-wasm', 'frontend'],
  ['n-react', 'frontend'],
];

export function seedNdjson(): Uint8Array {
  const recs: Rec[] = [];
  for (const [id, title] of notes) {
    recs.push({
      type: 'node',
      id,
      labels: ['Note'],
      properties: { id, title, body: `${title} body.` },
    });
  }
  for (const name of tags) {
    recs.push({ type: 'node', id: `tag-${name}`, labels: ['Tag'], properties: { name } });
  }
  let e = 0;
  for (const [from, to] of links) {
    recs.push({ type: 'edge', id: `l-${e++}`, from, to, labels: ['LINKS_TO'], properties: {} });
  }
  for (const [from, name] of tagged) {
    recs.push({
      type: 'edge',
      id: `t-${e++}`,
      from,
      to: `tag-${name}`,
      labels: ['TAGGED'],
      properties: {},
    });
  }
  const text = recs.map((r) => JSON.stringify(r)).join('\n');
  return new TextEncoder().encode(text);
}

// ---- Query strings, shared by the vanilla store demo and the React app ----

// Notes that link TO the current note (backlinks in the sidebar).
export const BACKLINKS =
  'MATCH (n:Note)-[:LINKS_TO]->(:Note {id: $id}) RETURN n.id AS id, n.title AS title ORDER BY n.title';

// Tag -> how many notes carry it.
// NB: `count` is a reserved GQL word, so the alias is `cnt` (aliasing to `count`
// raised E_SYNTAX "Expected an alias name, got 'count'").
export const TAG_COUNTS =
  'MATCH (:Note)-[:TAGGED]->(t:Tag) RETURN t.name AS name, count(*) AS cnt ORDER BY cnt DESC, t.name';

export type Backlink = { id: string; title: string };
export type TagCount = { name: string; cnt: number };

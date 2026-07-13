import { query } from '@lenke/gql';

// Can SKIP / OFFSET / LIMIT take a $param? (pagination wants this)
import { buildCorpus } from './corpus';

const { g } = buildCorpus();

for (const q of [
  `MATCH (a:Article) RETURN a.title AS t ORDER BY a.title LIMIT $lim`,
  `MATCH (a:Article) RETURN a.title AS t ORDER BY a.title SKIP $s LIMIT 3`,
  `MATCH (a:Article) RETURN a.title AS t ORDER BY a.title OFFSET $s LIMIT 3`,
]) {
  try {
    const r = query(g, q, { lim: 3, s: 2 });
    console.log('OK  ', q, '->', r.length, 'rows');
  } catch (e) {
    console.log('ERR ', q, '\n      ', (e as Error).message);
  }
}

import { createEmptyGraph } from '@lenke/native';
// Native engine: same?
import { createNodeBackend } from '@lenke/node/backend';
const nG = createEmptyGraph(createNodeBackend());
nG.query(`INSERT (:Article {title: 'a'}), (:Article {title: 'b'}), (:Article {title: 'c'})`);
try {
  const r = nG.query(`MATCH (a:Article) RETURN a.title AS t ORDER BY a.title LIMIT $lim`, {
    lim: 2,
  });
  console.log('NATIVE LIMIT $param OK:', JSON.stringify(r));
} catch (e) {
  console.log('NATIVE LIMIT $param ERR:', (e as Error).message);
}

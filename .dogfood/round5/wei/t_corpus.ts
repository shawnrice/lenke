import { buildCorpus } from './corpus';
const { g, meta } = buildCorpus();
console.log('articles', meta.articleCount);
console.log('authorCounts', meta.authorArticleCounts);
console.log('tagCounts', meta.tagArticleCounts);
console.log('categoryCounts', meta.categoryCounts);
// total vertices/edges
let vc = 0,
  ec = 0;
for (const _ of g.vertices()) vc++;
for (const _ of g.edges()) ec++;
console.log('vertices', vc, 'edges', ec);

import { Graph } from '@lenke/core';

// Deterministic PRNG (mulberry32) so runs are reproducible.
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const CATEGORIES = ['Engineering', 'Design', 'Product', 'Research', 'Culture'];

export const TAGS = [
  'graph',
  'database',
  'rust',
  'typescript',
  'performance',
  'query',
  'gql',
  'gremlin',
  'testing',
  'design',
  'api',
  'wasm',
  'async',
  'memory',
];

export const AUTHORS = [
  'Alice Chen',
  'Bob Nakamura',
  'Carol Díaz',
  'Dmitri Volkov',
  'Émile Laurent',
  '张伟', // CJK author name
  'Fatima Al-Sayed',
  'Grace Hopper',
];

// Word pools for body/title generation.
const TITLE_WORDS = [
  'Scaling',
  'Building',
  'Understanding',
  'Optimizing',
  'Debugging',
  'Designing',
  'Rethinking',
  'Benchmarking',
  'graph',
  'queries',
  'engines',
  'indexes',
  'traversals',
  'aggregation',
  'performance',
  'memory',
  'the',
  'a',
  'systems',
  'databases',
];

const BODY_WORDS = [
  'graph',
  'query',
  'engine',
  'index',
  'traversal',
  'aggregation',
  'performance',
  'memory',
  'the',
  'a',
  'and',
  'to',
  'of',
  'in',
  'with',
  'fast',
  'slow',
  'byte',
  'node',
  'edge',
  'vertex',
  'label',
  'property',
  'rust',
  'typescript',
];

// Strings with astral chars, combining marks, CJK to stress UTF-16 handling.
export const TRICKY_TITLES = [
  'Rocket science 🚀 explained', // astral emoji (surrogate pair)
  'Café résumé naïve', // combining + precomposed accents
  '数据库图查询引擎', // 8 CJK chars, all BMP
  'Family 👨‍👩‍👧‍👦 dynamics', // ZWJ emoji sequence (multi-codepoint)
  'Flags 🇺🇸🇯🇵 of the world', // regional indicator pairs
  'é vs é normalization', // decomposed 'é' vs precomposed
  '𝕭𝖔𝖑𝖉 mathematical text', // astral math alphanumerics
];

export interface CorpusMeta {
  articleCount: number;
  authorArticleCounts: Record<string, number>;
  tagArticleCounts: Record<string, number>;
  categoryCounts: Record<string, number>;
}

export function buildCorpus(seed = 42, n = 300): { g: Graph; meta: CorpusMeta } {
  const g = new Graph();
  const rand = rng(seed);
  const pick = <T>(arr: T[]) => arr[Math.floor(rand() * arr.length)];

  // Create author + tag vertices, keep handles.
  const authorV: Record<string, ReturnType<Graph['addVertex']>> = {};
  for (const name of AUTHORS) {
    authorV[name] = g.addVertex({ labels: ['Author'], properties: { name } });
  }
  const tagV: Record<string, ReturnType<Graph['addVertex']>> = {};
  for (const t of TAGS) {
    tagV[t] = g.addVertex({ labels: ['Tag'], properties: { name: t } });
  }

  const meta: CorpusMeta = {
    articleCount: 0,
    authorArticleCounts: Object.fromEntries(AUTHORS.map((a) => [a, 0])),
    tagArticleCounts: Object.fromEntries(TAGS.map((t) => [t, 0])),
    categoryCounts: Object.fromEntries(CATEGORIES.map((c) => [c, 0])),
  };

  for (let i = 0; i < n; i++) {
    // Title: 3-6 words, occasionally a tricky one.
    let title: string;
    if (rand() < 0.06) {
      title = pick(TRICKY_TITLES);
    } else {
      const len = 3 + Math.floor(rand() * 4);
      title = Array.from({ length: len }, () => pick(TITLE_WORDS)).join(' ');
    }

    // Body: 20-60 words.
    const blen = 20 + Math.floor(rand() * 41);
    const body = Array.from({ length: blen }, () => pick(BODY_WORDS)).join(' ');
    const summary = body.split(' ').slice(0, 8).join(' ');

    const author = pick(AUTHORS);
    const category = pick(CATEGORIES);
    // 1-3 distinct tags.
    const nTags = 1 + Math.floor(rand() * 3);
    const artTags = new Set<string>();
    while (artTags.size < nTags) artTags.add(pick(TAGS));

    // Date across 2023-2025.
    const year = 2023 + Math.floor(rand() * 3);
    const month = 1 + Math.floor(rand() * 12);
    const day = 1 + Math.floor(rand() * 28);
    const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const views = Math.floor(rand() * 10000);

    const art = g.addVertex({
      labels: ['Article'],
      properties: {
        title,
        body,
        summary,
        category,
        published: iso,
        views,
      },
    });
    meta.articleCount++;
    meta.categoryCounts[category]++;

    g.addEdge({ from: art, to: authorV[author], labels: ['WRITTEN_BY'], properties: {} });
    meta.authorArticleCounts[author]++;

    for (const t of artTags) {
      g.addEdge({ from: art, to: tagV[t], labels: ['TAGGED'], properties: {} });
      meta.tagArticleCounts[t]++;
    }
  }

  return { g, meta };
}

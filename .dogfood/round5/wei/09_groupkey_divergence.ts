// Does the substring lone-surrogate bug make GQL vs native bucket GROUP BY
// keys differently? Two astral-initial titles that share the SAME first astral
// char should bucket together on both engines — but if TS keeps the lone high
// surrogate and native emits U+FFFD, the *keys still match within an engine*.
// The real divergence: TS key = "\uD835", native key = U+FFFD — cross-engine
// aggregation results are not byte-identical.
import { Graph as TsGraph } from '@lenke/core';
import { query as tsQuery } from '@lenke/gql';
import { createEmptyGraph } from '@lenke/native';
import { createNodeBackend } from '@lenke/node/backend';

const titles = ['𝕭old text', '𝕮old text', 'Ascii title'];

function seed(insert: (t: string) => void) {
  for (const t of titles) insert(t);
}

// TS
const tsG = new TsGraph();
seed((t) => tsG.addVertex({ labels: ['Article'], properties: { title: t } }));
const tsRes = tsQuery(
  tsG,
  `MATCH (a:Article) RETURN substring(a.title, 1, 1) AS initial, count(*) AS n ORDER BY initial ASC`,
);

// Native
const nG = createEmptyGraph(createNodeBackend());
for (const t of titles) nG.query(`INSERT (:Article {title: $t})`, { t });
const nRes = nG.query(
  `MATCH (a:Article) RETURN substring(a.title, 1, 1) AS initial, count(*) AS n ORDER BY initial ASC`,
) as Array<Record<string, unknown>>;

const show = (rows: Array<Record<string, unknown>>) =>
  rows.map((r) => ({
    initial: r.initial,
    cp:
      typeof r.initial === 'string'
        ? [...(r.initial as string)]
            .map((c) => 'U+' + c.codePointAt(0)!.toString(16).toUpperCase())
            .join(',')
        : '',
    n: r.n,
  }));

console.log('TS group-by-initial:    ', JSON.stringify(show(tsRes)));
console.log('NATIVE group-by-initial:', JSON.stringify(show(nRes)));
console.log('byte-identical:', JSON.stringify(tsRes) === JSON.stringify(nRes));

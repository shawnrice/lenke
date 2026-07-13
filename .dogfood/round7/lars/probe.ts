import { Graph } from '@lenke/core';
import { query } from '@lenke/gql';
const g = new Graph();
g.addVertex({ labels: ['R'], properties: { p: '(555) 123-4567', n: 'Jon', m: 'John' } });
const tryFn = (label: string, q: string) => {
  try {
    console.log('OK  ', label, '=>', JSON.stringify(query(g, q)));
  } catch (e) {
    console.log('MISS', label, '=>', (e as Error).message.split('\n')[0].slice(0, 90));
  }
};
tryFn('regexp_replace', `MATCH (r:R) RETURN regexp_replace(r.p,'[^0-9]','') AS x`);
tryFn('regexp_matches', `MATCH (r:R) RETURN regexp_matches(r.p,'[0-9]+') AS x`);
tryFn('translate', `MATCH (r:R) RETURN translate(r.p,'() -','') AS x`);
tryFn('levenshtein', `MATCH (r:R) RETURN levenshtein(r.n,r.m) AS x`);
tryFn('edit_distance', `MATCH (r:R) RETURN edit_distance(r.n,r.m) AS x`);
tryFn('soundex', `MATCH (r:R) RETURN soundex(r.n) AS x`);
tryFn('metaphone', `MATCH (r:R) RETURN metaphone(r.n) AS x`);
tryFn('similarity', `MATCH (r:R) RETURN similarity(r.n,r.m) AS x`);
tryFn('lpad', `MATCH (r:R) RETURN lpad(r.n,5,'0') AS x`);
tryFn('initcap', `MATCH (r:R) RETURN initcap(r.n) AS x`);
tryFn('regexp_like', `MATCH (r:R) RETURN r.p =~ '[0-9]+' AS x`);
tryFn('position', `MATCH (r:R) RETURN position('55' IN r.p) AS x`);
tryFn('normalize', `MATCH (r:R) RETURN normalize(r.n) AS x`);
tryFn('string_agg', `MATCH (r:R) RETURN string_agg(r.n,',') AS x`);
tryFn('concat_fn', `MATCH (r:R) RETURN concat(r.n,r.m) AS x`);
tryFn(
  'replace_chain',
  `MATCH (r:R) RETURN replace(replace(replace(replace(r.p,'(',''),')',''),' ',''),'-','') AS x`,
);

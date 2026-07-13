# Dogfood Round 5 — Wei — KB Search + Faceted Reporting

Built a knowledge-base search + faceted reporting feature over an Article/Author/Tag
graph (300 articles, deterministic seeded corpus, incl. emoji/CJK/combining-mark/ZWJ
titles). Exercised text search, relevance ranking, pagination, GROUP-BY aggregation,
and string manipulation in @lenke/gql, cross-checked facets against @lenke/gremlin
groupCount, and cross-checked string ops against the native engine (@lenke/node).
Every count and string result was verified against an independent plain-JS computation.

Files: corpus.ts (generator), 01_search.ts, 02_ranking.ts, 03_facets.ts,
04_orderby_agg.ts, 05_strings.ts, 06_native_divergence.ts, 07_gremlin_facets.ts,
08_edges.ts, 09_groupkey_divergence.ts, 10_orderby_agg_native.ts,
11_skip_limit_param.ts, feature.ts (end-to-end search endpoint).

Case-folding exists and is correct — lower()/upper() (toLower is spelled lower)
follow JS default Unicode casing byte-for-byte, incl. non-ASCII: İ→i̇, ß→SS, Greek
final sigma. The fundamental case-insensitive-search requirement is met.

---

## HIGH

### 1. TS-vs-native parity BROKEN: substring/left/right across a surrogate pair emit lone surrogates on TS, U+FFFD on native

- Severity: HIGH — Category: BUG (parity / correctness)
- Repro:
  - `RETURN substring('Rocket 🚀 go', 8, 1)` (slice 1 UTF-16 unit into 🚀)
    - TS (@lenke/gql): "\uD83D" — a raw lone high surrogate (invalid UTF-16)
    - Native (@lenke/node): "�" — sanitized U+FFFD
  - Same divergence for left('🚀x', 1) (TS U+D83D vs native U+FFFD),
    right('x🚀', 1) (TS U+DE80 vs native U+FFFD),
    substring('🚀🚀', 2, 2) (TS "\uDE80\uD83D" vs native "��").
- Why it matters: the @lenke/gql README claims "Both engines produce byte-identical
  results for every one of the above" and documents split('')/reverse as yielding
  U+FFFD on both engines. split/reverse DO match (both U+FFFD, verified) — they were
  hardened; the substring/left/right family was NOT. The differential conformance
  harness evidently has no astral-boundary case for them.
- Not cosmetic — it corrupts aggregation: a GROUP BY/RETURN key derived via
  substring(title,1,1) over an astral-initial title produces group key U+D835 on TS
  but U+FFFD on native (09_groupkey_divergence.ts), so the two engines' aggregation
  output is not byte-identical, and a TS-produced key round-tripped to UTF-8
  (JSON/native store) is a replacement char.
- Workaround: none at query level. Avoid slicing at non-code-point boundaries, or
  post-sanitize lone surrogates in JS. Ideally TS should sanitize to U+FFFD to match
  native (or native as reference and TS follows).

---

## MEDIUM

### 2. Aggregate appearing ONLY in ORDER BY (not RETURN) silently ungroups instead of grouping or erroring

- Severity: MED — Category: BUG / ERGONOMICS (silent wrong result)
- Repro: `MATCH (a:Article)-[:TAGGED]->(t:Tag) RETURN t.name AS tag ORDER BY count(*) DESC`
  - Expected: "one row per tag, ordered by that tag's count desc" (top tag rust=49).
    Cypher errors ("aggregation in ORDER BY must also be in RETURN"); SQL groups.
  - Actual: 616 rows (one per TAGGED edge — no grouping), all {"tag":"graph"} first.
    count(_) is computed as a single global constant over every row, so the sort is a
    no-op and the ungrouped edge scan passes through. RETURN DISTINCT t.name ORDER BY
    count(_) DESC returns 14 rows but in insertion order, not count order — ORDER BY
    effectively ignored.
  - Consistent across TS and native (10_orderby_agg_native.ts) → a semantic choice,
    not a parity bug, but a silent footgun: no grouping, no error.
- Workaround (works): alias the aggregate in RETURN and sort the alias —
  `RETURN t.name AS tag, count(*) AS n ORDER BY n DESC, t.name ASC`. Note AS count is a
  reserved-word error, alias to n.

### 3. SKIP / OFFSET / LIMIT cannot take a $param — only literal integers

- Severity: MED — Category: CAPABILITY / ERGONOMICS
- Repro: `... ORDER BY a.title LIMIT $lim` (params {lim:3})
  - Actual: GqlSyntaxError: Expected a non-negative integer after LIMIT, got 'lim'.
    Same for SKIP $s and OFFSET $s. Confirmed on both TS and native.
- Why it matters: pagination is exactly where you want to bind page bounds. Forcing
  string interpolation of offset/limit is the injection-prone pattern params exist to
  avoid — caller must hand-validate ints before splicing (see feature.ts guards).
- Workaround: splice validated integer literals into the query string. Error message
  is clear and points at the offset.

---

## LOW

### 4. Native RustGraph prints a GC leak warning to stderr on every implicit dispose

- Severity: LOW — Category: ERGONOMICS
- Repro: create createEmptyGraph(createNodeBackend()), let it go out of scope →
  "lenke: a RustGraph was garbage-collected without free() …". Fires per graph.
- Workaround: `using g = ...`, explicit g.free(), or LENKE_SILENCE_LEAK_WARNING. Fine
  for a server; noisy for scripts/tests spinning up many short-lived graphs.

### 5. count(DISTINCT x) works but is undocumented

- Severity: LOW — Category: DOCS
- Repro: `RETURN count(DISTINCT a.category) AS n` → 5 (correct). The @lenke/gql README
  lists aggregates as count, sum, avg, min, max, collect_list and never mentions the
  DISTINCT modifier — a useful working feature a reporting user assumes is absent.

### 6. String contains()/starts_with()/ends_with() fn form returns a boolean, unlike list_contains (numeric 1/0)

- Severity: LOW — Category: DOCS / consistency
- Repro: `RETURN contains('hello world','world')` → true (boolean). README documents
  list_contains as returning numeric 1/0 "per the ISO Return Type." The two return-type
  conventions living side by side is a footgun worth documenting.

### 7. Empty-group aggregate semantics undocumented (sum→0 but avg/min/max→null)

- Severity: LOW — Category: DOCS
- Repro: `... WHERE a.views < 0 RETURN sum(a.views) AS s, avg(a.views) AS av, max(a.views) AS mx`
  → {s:0, av:null, mx:null}. Cypher-like (sum of empty = 0), but SQL users expect
  sum→NULL too. A reporting user building "avg per category" needs to know avg over an
  empty facet is null, not 0.

### 8. Native rejects an object-valued $param with a misleading message

- Severity: LOW — Category: ERGONOMICS / DOCS
- Repro (native): `INSERT (n) SET n = $p` with {p:{title:'x'}} →
  E_INVALID_JSON: the only valid object param value is a tagged temporal (at byte 26).
  Cannot pass a whole property map as one parameter on the native path — each property
  must be its own scalar $param. Message ("tagged temporal") is opaque; doesn't say
  "object params aren't supported for property maps."

---

## What worked (verified correct, no findings)

- Text search: CONTAINS/STARTS WITH/ENDS WITH as infix + fn form; multi-term AND/OR;
  case-insensitive via lower() — all counts matched independent JS (01_search.ts).
- Ranking: CASE-based relevance (title×3 + body×1), recency, ORDER BY computed alias —
  top-N matched JS exactly (02_ranking.ts).
- Pagination: SKIP/LIMIT and OFFSET/LIMIT (synonyms) byte-matched JS; pages disjoint.
- Faceted aggregation: counts per category/author/tag, top-N by count desc,
  count/sum/min/max/avg per group, collect_list sizing, two-level histogram via WITH
  re-aggregation, count(DISTINCT) — all matched corpus meta AND Gremlin groupCount.
- String fns: char_length (UTF-16), substring (1-based), split, || concat,
  trim/ltrim/rtrim, replace, left/right, reverse, byte_length (UTF-8) — all matched JS
  on ASCII/CJK/emoji EXCEPT the astral-boundary divergence (finding 1).
- Unicode: CJK/precomposed-vs-decomposed accents per JS .length; no silent
  normalization ('é'NFC = 'é'NFD → false, matching JS ===).

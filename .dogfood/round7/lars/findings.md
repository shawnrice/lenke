# Dogfood Round 7 — Lars: Master-Data Management / Entity Resolution Findings

Built a multi-source MDM / entity-resolution pipeline on `@lenke/core` +
`@lenke/gql`: ingest a plain business CSV (`crm.csv`) and NDJSON (`erp.ndjson`),
normalize blocking keys in GQL, block + union-find cluster, `_MERGE` clusters
into golden records with per-field survivorship, and score against a planted
ground truth.

Files: `gen.ts` (seeded messy-data generator with truth clusters), `smoke.ts`
(string fns + CSV decode), `probe.ts` (string/fuzzy fn availability),
`mdm.ts` (full pipeline + precision/recall), `merge_probe.ts` +
`merge_order.ts` (golden-record survivorship).

Verdict up front: **the exact-identifier half of MDM works well and is
deterministic (precision 1.0), and `_MERGE` + `coalesce(nullif(...))`
survivorship is correct when records arrive in recency order. But (a) the
fuzzy/phonetic string toolkit an ER engine lives on is entirely absent, which
caps recall at 0.80 and makes ~20% of true duplicates unrecoverable in-engine,
and (b) a recency-guarded `_MERGE` produces silently different golden records
depending on ingest order.**

---

## HIGH-1 — No fuzzy/phonetic string toolkit; exact blocking only → 20% of true dupes unrecoverable

- **Severity:** HIGH (for an entity-resolution use case — this is the core tool)
- **Category:** CAPABILITY GAP (functions deferred/unimplemented)
- **Repro:** `probe.ts` calls 15 string functions an ER pipeline needs. All but
  one report `call to an unknown or unimplemented function`:
  - `levenshtein`, `edit_distance`, `similarity` (fuzzy distance — the heart of
    fuzzy matching)
  - `soundex`, `metaphone` (phonetic blocking)
  - `regexp_replace`, `regexp_matches`, `regexp_like` / the `=~` operator
    (`=~` fails at parse time: `Unexpected '~' in expression`)
  - `translate`, `normalize`, `initcap`, `lpad`, `position('55' IN r.p)`,
    `string_agg`, `concat`
  - Only the hand-rolled `replace(replace(...))` chain works.
- **Impact (measured):** `mdm.ts` can only do _exact_ blocking on normalized
  email/phone/name. Against the ground truth:
  - `email+phone` blockers: **precision 1.0000, recall 0.7971, F1 0.8871**
    (`TP=1253 FP=0 FN=319`). The 319 false negatives are exactly the "hard"
    duplicates the generator plants (adjacent-char typo in the name AND a fresh
    phone/email) — records that **only a fuzzy/phonetic matcher could link**.
    That is 319/1572 = ~20% of all true duplicate pairs left on the table with
    no in-engine way to recover them.
  - Adding the weak `name`-only blocker to chase recall collapses precision
    (`email+phone+name`: precision **0.1832**, F1 0.30) because exact name
    collisions merge distinct people — the classic reason you need edit-distance
    /phonetic keys instead of exact name equality.
- **Note:** error messages are clear and consistent (`unknown or unimplemented
function: <name>()`), so discovery is fast — this reads as _deferred_, not
  broken. But for the MDM/ER charter it is the single biggest gap.
- **Workaround:** compute distances/phonetic keys in TS outside GQL (defeats the
  "normalize + block in the query" story), or ship these as scalar fns.

## HIGH-2 — Recency-guarded `_MERGE` gives order-dependent (nondeterministic) golden records

- **Severity:** HIGH (silent wrong data; the crown-jewel MDM output)
- **Category:** ERGONOMICS / CAPABILITY (survivorship not expressible order-independently)
- **Repro:** `merge_order.ts` feeds the **same** 3-record cluster in three
  orders through the same `_MERGE`:
  ```
  _MERGE (x:Golden {gid:'G', ...})
    _ON_UPDATE SET x.phone = coalesce(nullif($phone,''), x.phone), ... , x.updated=$updated
    WHERE x.updated <= $updated
  ```
  Cluster (correct golden = most-recent non-empty per field →
  `{name:'Robert Brown', email:'rob@x.io', phone:'555-0002', city:'Denver'}`):
  | updated | name | email | phone | city |
  |---|---|---|---|---|
  | 2021-01-01 | Bob Brown | bob@x.io | 555-0001 | Austin |
  | 2022-06-01 | Robert Brown | (empty) | 555-0002 | (empty) |
  | 2023-03-01 | Robert Brown | rob@x.io | (empty) | Denver |
  - Expected: same golden regardless of feed order.
  - Actual:
    - `ascending  by updated` → CORRECT
    - `descending by updated` → **WRONG** `phone:""`
    - `shuffled` → **WRONG** `phone:""`
- **Cause:** the `WHERE x.updated <= $updated` guard gates the **entire**
  `_ON_UPDATE SET` as a unit. When the newest record (2023, empty phone) is
  merged first, every subsequently-merged _older_ record fails the WHERE, so its
  `SET` is skipped wholesale — and the 2022 record's non-empty `phone:'555-0002'`
  never lands. The per-field `coalesce(nullif(...))` survivorship is correct in
  isolation; it just never runs. There is no way to express "keep the most
  recent non-empty value per field" in a single order-independent `_MERGE`.
- **Impact:** golden records depend on ingest/iteration order. A real pipeline
  iterating a cluster in `collect_list` order (not sorted by `updated`) silently
  drops fields with no error. `merge_probe.ts` PASSES only because it hand-sorts
  ascending first.
- **Workaround:** sort each cluster by `updated` ascending before merging, or
  drop the WHERE guard and rely purely on per-field `coalesce(nullif(...))`
  (but then "most recent" is really "last fed", so you still must sort).

## MED-3 — `decodeNodes` silently mis-ingests a plain business CSV (column 2 becomes the label set)

- **Severity:** MED
- **Category:** ERGONOMICS / DOCS (no header validation → silent structural loss)
- **Repro:** `smoke.ts` feeds a plain untyped business CSV to
  `decodeNodes(csv, g)`:
  ```
  id,name,email
  1,Alice,alice@x.io
  ```
  - Expected (naive): a node with `{id, name, email}` properties.
  - Actual: node `id='1'`, `labels=['Alice']`, `properties={email:'alice@x.io'}`.
    The `name` **column is gone** — its value became a label, its header key
    dropped.
- **Cause:** `decodeNodes` is a Neo4j-`admin-import`-style codec: it treats
  column 0 as `id`, **column 1 as the `:LABEL` set positionally**, and columns
  2+ as typed properties (`packages/serialization/src/csv/index.ts` —
  `applyNodeRow` uses `row[1].text` for labels and `propColsFromHeader(rows[0], 2)`).
  It never checks that the column-1 header is actually `:LABEL`; header `name` is
  silently ignored and its data is consumed as labels. No warning, no error.
- **Impact:** the most natural first move for this persona — "load my CRM CSV
  with `decodeNodes`" — silently corrupts every row (drops the second column,
  invents labels from it). `mdm.ts` had to hand-roll an RFC-4180 CSV parser to
  work around it. The recent "bare/untyped header no longer truncates the key"
  fix does preserve the trailing `email` key, but the structural column-2→label
  behavior remains and is the real trap.
- **Workaround:** either format the CSV as `id,:LABEL,...` (admin-import shape),
  or parse business CSV yourself and use `graph.addVertex`. Docs should warn
  that `decodeNodes` is not a general CSV loader.

## LOW-4 — ISO-ish scalar/string fns missing while operators work (`concat`, `position`, `lpad`)

- **Severity:** LOW
- **Category:** CAPABILITY GAP
- **Repro:** `probe.ts` — `concat(a,b)`, `position('x' IN y)`, and `lpad(...)`
  all report `unknown or unimplemented function`, yet the `||` concat operator,
  `substring`, `trim`, `lower/upper`, `split`, and `replace` all work fine
  (`smoke.ts`). So the capability exists via operators/other fns; only the
  named-function spellings are absent.
- **Impact:** minor — reachable via `||` and manual indexing — but a user
  reaching for the standard function names hits a wall. Clear error, easy pivot.

---

## What worked well (smooth)

- **String basics in GQL are solid and byte-sane:** `lower(trim(x))`,
  `replace`, `split` (returns a list; `split('J@X.io','@') → ['J','X.io']`),
  `substring(s,1,4)`, and the `||` concat operator all produced exactly the
  expected values (`smoke.ts`). The 7-deep `replace(...)` phone-digit-strip chain
  works as a `regexp_replace` substitute.
- **Exact-identifier resolution is deterministic and precise:** `email+phone`
  blocking scored **precision 1.0000** with **zero false positives** over 2,376
  records — no spurious merges (`mdm.ts`).
- **`_MERGE` + `_ON_UPDATE` + `coalesce(nullif($x,''), x.k)` survivorship is
  correct** when records arrive in recency order (`merge_probe.ts` PASS; all four
  fields survive per-field). The unique constraint held (golden `count=1`).
- **Bare `_MERGE` does NOT clobber:** re-merging a matched key with _fewer_
  fields (`_MERGE (x:Golden {gid:'A', name:'Full Name'})` after a full insert)
  **preserved** the existing `email`/`phone` rather than nulling them
  (`merge_probe.ts` → `{n,e,p}` all intact). Safe default, no silent data loss.
- **NDJSON ingest** is trivial (`split('\n')` + `JSON.parse` + `addVertex`) and
  round-trips property types cleanly.
- **Error messages** for missing functions are consistent and greppable, making
  the capability surface easy to map (`probe.ts`).

## Doc accuracy

- `packages/serialization/src/csv/index.ts` header comment accurately documents
  the `id,:LABEL,...` admin-import shape — but there is no runtime guard, and no
  user-facing doc warns that `decodeNodes` is _not_ a general business-CSV
  loader (MED-3).
- The clear "unknown or unimplemented function" errors correctly signal the
  fuzzy/string gap rather than overclaiming (no doc promised these), so no
  overclaim here — just an absent capability for the ER charter.

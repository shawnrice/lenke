# Round 14 findings — Gremlin-regression + temporal/tx/fuzz (4 personas)

Weighted toward regression-testing round 13's Gremlin element-serialization rewrite,
plus fresh domains. Four personas: a **Gremlin-driven social network** (SocialGraph),
a **temporal/audit/bitemporal** app (Chronicle), a **financial-ledger tx+constraints**
app (Ledger), and a **differential fuzzer** (FuzzHunter4) that built the native-vs-TS
Gremlin differential round 13 lacked. Verdict: the round-13 element-form fix is **solid**
(byte-identical across ~27,600 Gremlin pairs + all four surfaces); the core write path,
temporal system, and bitemporal recipe are byte-identical. Found several real
divergences — the clear ones fixed, the delicate ordering ones documented below.

## Persona results

- **SocialGraph** (`social/`). Broad Gremlin surface + GQL↔Gremlin cross-checks. Element
  form confirmed byte-identical native-Gre == TS-Gre == native-GQL == TS-GQL. Found the
  temporal-tag stripping (HIGH, fixed) + map-key-order + `project()` varargs (fixed).
- **Chronicle** (`chronicle/`). Full temporal type system + bitemporal recipe (16/16
  native==TS==hand-truth) + ~25 malformed-parse probes — all byte-identical except the
  Duration-overflow finding (fixed).
- **Ledger** (`ledger/`). R-TX atomicity + rollback state-equality, constraint
  deferred-timing, `_MERGE`, typed nodes — byte-identical across ~40 scenarios. Found the
  `Date`/object param-boundary divergences (both fixed).
- **FuzzHunter4** (`fuzz4/`). Built the native-vs-TS Gremlin differential (**~27,600
  pairs**, translation table + Map/toJSON-aware canonicalizer). One root-cause divergence
  (adjacency order); GQL regression of this session's changes all byte-identical.

## Fixed this round (byte-identity bugs)

- **HIGH · native Gremlin stripped the temporal `@date` tag** in `values`/`valueMap`/
  `project` → `858cd0c`. `write_gval`'s `GVal::Temporal` emitted a bare ISO string; now
  emits the tagged `{"@date":…}` via `json_tagged()`, matching GQL, TS, and its own
  element form.
- **HIGH · `Date` / object param divergence** → `ca23e7c`. `@lenke/native` silently
  JSON-encoded a `Date` param to a string (TS rejected it), and an object-with-bigint
  faulted with a different code. Added `assertParamModel` before the FFI, mirroring the
  TS `validateParam` + native `gql/params.rs` contract — all 9 param shapes now
  byte-identical.
- **HIGH¹ · non-representable Duration** → `bb3b3dc` + follow-up. A component ≥ 2^53
  diverged (native i64 wrapped — sign-flip — vs TS f64 rounded). Both engines now treat it
  as non-representable identically (the ≥ 2^53 bound matches `Number.isSafeInteger`):
  arithmetic (`dur±dur`/`dur×n`) raises a loud **`E_DATA_EXCEPTION`** (a swallowed null was
  itself wrong — it looks like data; made loud like division by zero, per user), and a
  duration _literal_ past 2^53 rejects at parse (`E_SYNTAX`). Date/datetime _range_
  overflow (D4) was later brought onto the same policy — it now raises
  `E_DATA_EXCEPTION` too (native `FAULT_DATE_OVERFLOW`), superseding its earlier → null.
- **DX · `project()` varargs** → `e275945`. The TS builder took a keys _array_; the
  TinkerPop/native-string call `project('a','b')` crashed. Added a varargs overload.

¹ astronomical magnitudes only.

## Decided WON'T FIX — order is unspecified (user, 2026-07-20)

- **Adjacency enumeration order + Gremlin map-key order** (were MED). Adjacency
  (`out()`/`in()`/`both()`: native insertion vs TS label-bucketed) and map-key order
  (`project`/`valueMap`/`group`: native sorts vs TS preserves) are **not bugs** — order
  for an unordered result is unspecified, exactly like SQL `SELECT` without `ORDER BY`,
  and like TinkerPop itself (adjacency is provider-dependent; TinkerGraph's order is a JVM
  `HashMap`/`HashSet` artifact, not a spec guarantee — so `project`'s `LinkedHashMap`
  declared-order is moot once serialized to JSON). lenke won't pay a permanent **sort perf
  tax** to fake byte-identical order; a consumer adds explicit ordering if it needs one.
  Object key order is semantically free anyway (the harness `stable()` already sorts keys
  and shows agreement — the `project` "divergence" was a raw-`JSON.stringify` artifact).
  **Future rounds:** compare unordered results (rows, `fold`/`path` lists, map keys) as
  sets/multisets — an ordered-comparison hit here is expected. Content stays byte-identical.

## DX — resolved / decided

- **`createValidator`/`createInvariant` free-fn vs method asymmetry** → **FIXED**
  (`15db398`). The `@lenke/gql` free functions now duck-type-dispatch to a native
  `RustGraph`'s methods (byte-identical enforcement); a non-graph object gets a coded
  `E_INVALID_GRAPH_OP` instead of a raw `TypeError`.
- **TS `group`/`groupCount` `Map` has no `toJSON`** → **WON'T FIX (user).** A `Map` is the
  right JS return type; byte-identity is the test harness's concern, not something users
  diff — people pick one engine and stay. Compare Map results structurally in tests.
- **Doc notes** → done: added the "zoned/time types have no literal form" clause to the GQL
  README (`bc75f3b`); reserved-word labels were already documented there. The
  Duration-overflow policy is now `E_DATA_EXCEPTION` (see above).

## Confirmed solid (byte-identical, zero findings)

Round-13 Gremlin element form (all 4 surfaces, ~27,600 pairs); the full bitemporal recipe
(16/16); R-TX atomicity + rollback state-equality + constraint deferred-timing; `_MERGE`;
typed `defineNode`; the whole Gremlin movement/filter/projection/order surface (multiset);
`shortestPath().with(ShortestPath.edges, Direction.*)`; this session's CAST/`to_string`/
`power`/`shortest_path`-CALL changes.

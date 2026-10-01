# Graph-query conformance — reference sources

A curated, annotated bibliography for reasoning about **ISO GQL** (and, where
relevant, **openCypher / TinkerPop Gremlin**) conformance. Assembled while
deciding how lenke should implement features conformantly. The companion
[gql-feature-checklist.md](./gql-feature-checklist.md) applies these sources to
lenke's actual surface.

> **Reliability lesson (read first).** AI/search summaries of these pages
> **confabulate specifics** — during this research a summary asserted "GF04 =
> datetime functions"; the primary source shows GF04 is _Enhanced path
> functions_ (`path_length`). **Always resolve a Feature ID against a primary
> source, never a summary.**
>
> **Second lesson, and the more expensive one (2026-09-30).** "The standard is
> paywalled" was treated as "the facts are unavailable", and a lot of this file
> was built on reproductions for facts ISO publishes for free. The
> [digital-artifact directory](https://standards.iso.org/iso-iec/39075/ed-1/en/)
> carries the Feature IDs, every condition code, and the
> implementation-defined/dependent lists. Two open questions (audit items 69 and
> the `sum`-of-empty policy) were argued from first principles while the answer to
> one of them sat in `-implementation-dependent.xml`. **Check the directory
> first.**

---

## 1. The standard itself

- **ISO/IEC 39075:2024 — Information technology — Database languages — GQL** _(text
  paywalled)_. <https://www.iso.org/standard/76120.html> · free browse (front
  matter/ToC only): <https://www.iso.org/obp/ui/en/#!iso:std:76120:en>
  The authoritative text. Conformance is defined in **subclause 24.2**:
  a system conforms by supporting the data model + the **mandatory** features;
  **optional** features each carry a Feature ID (letter(s)+digits, e.g. `G035`,
  `GF07`, `GV39`). Mandatory features have **no** ID and are cited by subclause.
  The **prose** is behind the paywall (CHF 227, 610 pages). The Feature IDs, the
  condition codes and the implementation-defined/dependent lists are **not** — see
  the digital artifacts below.

- **ISO's FREE "digital artifacts" — the directory, not just the BNF.**
  <https://standards.iso.org/iso-iec/39075/ed-1/en/>
  Six files, all unpaywalled, and between them they answer far more than the
  grammar alone. **Read this directory before paying for anything.**

  | artifact                                                                                                                            | what it is                                                                                                             | what it settles                                                                                                                      |
  | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
  | [`.bnf.txt`](<https://standards.iso.org/iso-iec/39075/ed-1/en/ISO_IEC_39075(en).bnf.txt>)                                           | the grammar, `<GQL-program>` downward (~78 KB)                                                                         | the whole _syntax_ surface; better than any vendor reproduction for "what productions exist"                                         |
  | [`.bnf.xml`](<https://standards.iso.org/iso-iec/39075/ed-1/en/ISO_IEC_39075(en).bnf.xml>)                                           | the same grammar, machine-readable                                                                                     | tooling                                                                                                                              |
  | [`-features.xml`](<https://standards.iso.org/iso-iec/39075/ed-1/en/ISO_IEC_39075(en)-features.xml>)                                 | **every optional feature, with its ID and name**                                                                       | the Feature-ID taxonomy — `G011 Advanced path modes: TRAIL`, `G018 Any shortest path search`, …                                      |
  | [`-conditions.xml`](<https://standards.iso.org/iso-iec/39075/ed-1/en/ISO_IEC_39075(en)-conditions.xml>)                             | every GQLSTATUS condition: 12 classes, 68 subclasses                                                                   | the error-code surface, e.g. `22012 division by zero`, `2201E invalid argument for natural logarithm`, `22G04 values not comparable` |
  | [`-implementation-defined.xml`](<https://standards.iso.org/iso-iec/39075/ed-1/en/ISO_IEC_39075(en)-implementation-defined.xml>)     | what an implementation must DOCUMENT (codes start `D`)                                                                 | where we are allowed to choose, provided we say so                                                                                   |
  | [`-implementation-dependent.xml`](<https://standards.iso.org/iso-iec/39075/ed-1/en/ISO_IEC_39075(en)-implementation-dependent.xml>) | what an implementation may do FREELY (codes start `U`; second letter = Actions/Defaults/Limits/Sequencing/Values/Ways) | where no answer is required at all                                                                                                   |

  > **Correction (2026-09-30).** This file previously said twice that the
  > Feature-ID Annex is "behind the paywall", and §2 below exists because of that
  > belief. It is wrong: `-features.xml` is the taxonomy, free and authoritative.
  > §2's reproductions are still useful for the _mapping_ to concrete engine
  > capabilities and for prose, but the IDs themselves should come from here.
  > `gql-feature-checklist.md` still takes Neo4j's list as its spine and should be
  > re-based on this artifact.

  The [TuGraph ANTLR grammar](#3-independent-vendor-implementations-cross-check-divergence)
  remains a convenient navigable rendering of the same grammar.

## 2. Best FREE reproductions of the feature taxonomy

- **Neo4j Cypher Manual — GQL conformance appendix.** _The single most useful
  free source for Feature IDs._ Neo4j co-authored GQL and enumerates real 39075
  Feature IDs mapped to concrete capabilities. Open-source (`neo4j/docs-cypher`),
  so the raw AsciiDoc is fetchable when the rendered pages 403 a scraper:
  - Supported mandatory: <https://neo4j.com/docs/cypher-manual/current/appendix/gql-conformance/supported-mandatory/>
  - Currently unsupported mandatory: <https://neo4j.com/docs/cypher-manual/current/appendix/gql-conformance/unsupported-mandatory/>
  - **Supported optional** (the Feature-ID table): <https://neo4j.com/docs/cypher-manual/current/appendix/gql-conformance/supported-optional/>
  - Optional features w/ analogous Cypher: <https://neo4j.com/docs/cypher-manual/current/appendix/gql-conformance/analogous-cypher/>
  - Additional Cypher features (Cypher, **not** in GQL): <https://neo4j.com/docs/cypher-manual/current/appendix/gql-conformance/additional-cypher/>
  - Raw source: <https://github.com/neo4j/docs-cypher> → `modules/ROOT/pages/appendix/gql-conformance/*.adoc`
    (fetch via `gh api -H "Accept: application/vnd.github.raw" repos/neo4j/docs-cypher/contents/<path>?ref=dev`).

- **Ultipa GQL documentation.** _Best free reference for function / operator /
  `CAST` semantics_ (per-function behavior, examples). Note: Ultipa lists its own
  extensions as GQL synonyms (e.g. it offered `relationships` as a synonym for
  `edges`), so treat its _naming_ claims as vendor-flavoured; the _semantics_ are
  reliable. <https://www.ultipa.com/docs/gql/> — datetime fns:
  <https://www.ultipa.com/docs/gql/datetime-functions> · conformance model:
  <https://www.ultipa.com/docs/gql/gql-conformance>

## 3. Independent vendor implementations (cross-check divergence)

Comparing implementations reveals what is _mandated_ vs _implementation-defined_.
Where they disagree, the feature is not carrying a single conformant form.

- **Google Spanner Graph — GQL.** Function reference + ISO-standards statement.
  Uses SQL-style `EXTRACT`, `EDGES()`/`NODES()`/`PATH_LENGTH()`.
  <https://docs.cloud.google.com/spanner/docs/reference/standard-sql/graph-gql-functions>
  · <https://docs.cloud.google.com/spanner/docs/graph/iso-standards>
- **Microsoft Fabric — GQL (graph).** Expressions/functions + language guide.
  Minimal temporal surface (`zoned_datetime()` only; extracts year via integer
  math), uses `edges()`/`nodes()`/`path_length()`.
  <https://learn.microsoft.com/en-us/fabric/graph/gql-expressions> ·
  <https://learn.microsoft.com/en-us/fabric/graph/gql-language-guide>
- **TuGraph — `gql-grammar`.** An ANTLR4 grammar for ISO/IEC 39075 — useful for
  checking _syntax_ shapes. <https://github.com/TuGraph-family/gql-grammar>
- **Neo4j Cypher** (openCypher) — the largest deployed near-GQL dialect; its
  divergences (`.year` accessor, `relationships()`, `date.truncate()`) mark what
  is _Cypher-only, not GQL_.
- **PyrrhoDB (Pyrrho V7/V8)** — Malcolm Crowe, University of the West of Scotland.
  A small OPEN-SOURCE hybrid SQL/GQL server tracking 39075, so it is the one
  implementation in this list whose source can be read when the docs are silent.
  Useful precisely because it is not a commercial engine: no marketing layer
  between the standard and the code. <https://github.com/MalcolmCrowe/ShareableDataStructures>
  · notes/devlog: <https://pyrrhodb.blogspot.com>
  Caveat: it carries its own extensions (see `TRUNCATING` in §4) and does not mark
  them as such, so treat its SYNTAX as vendor-flavoured — the same caution as
  Ultipa.

## 4. Academic / semantics

- **"A Researcher's Digest of GQL"** — Francis, Gheerbrant, Guagliardo, Libkin,
  Marsault, Martens, Murlak, Peterfreund, Rogova, Vrgoč. ICDT 2023. The
  authoritative free treatment of GQL/SQL-PGQ pattern-matching semantics.
  <https://drops.dagstuhl.de/storage/00lipics/lipics-vol255-icdt2023/LIPIcs.ICDT.2023.1/LIPIcs.ICDT.2023.1.pdf>
- **"GQL and SQL/PGQ: Theoretical Models and Expressive Power."**
  <https://arxiv.org/html/2409.01102>
- **"Implementing the draft Graph Query Language Standard: The Financial Benchmark"**
  — Crowe & Laux, DBKDA 2024. <https://arxiv.org/pdf/2407.09566>
  An implementation report, not a semantics paper. Checked for it and it contains
  **nothing** on evaluation order, three-valued logic, or error/exception
  semantics — worth recording so nobody re-reads it hoping for that.
  What it does contain: a `TRUNCATING` clause for bounding pattern-match search,
  from the LDBC Financial Benchmark's requirement to cap the edges followed when
  traversing out of a vertex, with a MANDATORY sort order so results stay
  deterministic:

  ```
  TRUNCATING Transfer("timestamp" DESC) = 1000
  MATCH …
  ```

  **Not ISO** — verified against the published grammar, whose only `truncat` is
  `<truncating whitespace>`, a lexical rule. The paper says "we have constructed a
  syntax for this", so it is a Pyrrho extension; under our convention it would
  wear the sigil (`_TRUNCATING`).

  Why it is filed here rather than ignored: it is the same problem lenke solves
  from the opposite end. Our answer to an exploding traversal is a hard limit that
  REFUSES (`limits.trail` / `limits.intermediate` → `E_RESOURCE_EXHAUSTED`);
  FinBench's is to DEGRADE deterministically. And its bound lives in the QUERY
  rather than in store settings, which is the asymmetry behind audit items 60, 62
  and 63 — a per-store limit made native refuse counts that the TS engine
  answered, where a bound carried in the query text means the same thing on both
  engines.

- **GQL standards working group** portal: <https://www.gqlstandards.org/>

## 5. Adjacent standards (for the non-GQL engines)

- **openCypher** — <https://opencypher.org/> (Cypher's open spec; lenke's GQL
  engine deliberately builds GQL, not Cypher-isms).
- **Apache TinkerPop / Gremlin** — <https://tinkerpop.apache.org/docs/current/reference/>
  (the reference for lenke's Gremlin engine; date-part extraction, for instance,
  is not a TinkerPop concept).
- **PGQL 2.x** (Oracle; a SQL/PGQ ancestor) — <https://pgql-lang.org/spec/2.1/>

---

## How lenke uses these

- **Feature-ID status** → Neo4j `supported-optional.adoc` (§2) is the spine of the
  [checklist](./gql-feature-checklist.md).
- **Function semantics / "is X conformant?"** → Ultipa (§2) for behavior, then
  cross-checked against Spanner + Fabric + Pyrrho (§3). If they diverge, the
  feature is implementation-defined and — if we add it — wears the sigil (see
  `docs/design/gql-extensions.md`).
- **EVALUATION ORDER / "may an optimization change which errors surface?"** →
  `-implementation-dependent.xml` (§1), and it is explicit:
  - **US008** — "The actual order of expression evaluation."
  - **UA004** — "Whether or not that exception condition is actually raised when
    the evaluation of an **inessential part** of an expression or search condition
    would cause an exception to be raised."
  - **UA006** — which additional path bindings are probed to see whether they too
    would raise, once a selective path pattern's evaluation has been terminated.
  - **UV003** — which `‹value expression›` raises `22G12 invalid value type`.

  So a conforming GQL implementation may evaluate operands in any order, and may
  raise or not raise from a part whose value is not needed. Short-circuiting is
  conformant; not short-circuiting is conformant; an optimizer that surfaces an
  exception the unoptimized plan avoided is conformant. This resolves audit item
  69 — see it for what that means for our own two invariants, which are stricter
  than the standard requires and are ours to scope.

  Also worth knowing from the same file: **US001** (the sequence of records in an
  unordered binding table) is implementation-dependent, which is the standard's
  backing for our "order is unspecified" policy; and **US007** covers the ordering
  of items whose comparison is Unknown, which is where our NaN total-order rule
  lives.

- **Pattern-matching edge cases** → the Researcher's Digest (§4).
- Related engine-internal notes: `docs/design/gql-extensions.md` (the sigil
  convention), the memory `iso-gql-reference`.

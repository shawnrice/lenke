/**
 * UNICODE CODE-POINT STRING ORDERING, SHARED BY BOTH ENGINES (item 1712).
 *
 * ⚠️ IT LIVES IN `core` BECAUSE IT IS AN ENGINE-WIDE CONTRACT, NOT A LANGUAGE ONE. The Rust side
 * has no per-language string order: `exec/order.rs` compares a `Col::Str` with `v[a].cmp(&v[b])`
 * (Rust `str::cmp`, byte-wise UTF-8 = code point) and `ir.rs`'s `SortKey` doc states that BOTH
 * languages order non-nulls by `cmp_total`, with only null PLACEMENT differing — GQL last,
 * Gremlin first. So TS needs one string order too, and `temporalCmpTotal` next door is the exact
 * precedent for putting a shared total-order primitive here.
 *
 * ⚠️ IT IS HERE BECAUSE GREMLIN DID NOT HAVE IT, AND THAT WAS A CONFIRMED BYTE-IDENTITY BREAK
 * (the 15th open value divergence, found at item 1711 and fixed at 1712). Gremlin's `cmpOrd` was a
 * plain `x < y ? -1 : x > y ? 1 : 0`, so `g.V().values('s').order()` disagreed with the engine on
 * any column mixing an astral char with U+E000..U+FFFF. Measured on one fixture, three legs:
 *
 * ```text
 *     gremlin NAT   a  z  U+E000   U+1F600     the engine: code point
 *     gql     TS    a  z  U+E000   U+1F600     matched native already
 *     gremlin TS    a  z  U+1F600  U+E000      the outlier: code UNIT
 * ```
 *
 * ⚠️ NO FUZZER COULD HAVE FOUND IT: `gremlin-fuzz.test.ts` calls `order(` 59 times and generates
 * ZERO astral and ZERO U+E000..U+FFFF characters, so the dangerous case is never CONSTRUCTED. That
 * is item 921's own rule firing in the other engine; the GQL differential fuzzer DOES build it
 * (`STR_CHARS` carries `\uE000`, and 20% of its strings splice an astral char), which is exactly
 * why GQL's side was already right.
 */
// ⚠️ ONE DEFINITION OF "CAN CODE-UNIT ORDER DISAGREE WITH CODE-POINT ORDER", and it now has
// THREE callers: GQL's `compareValues`, GQL's ORDER BY column specialization, and Gremlin's
// `cmpSameType` (item 1712). A copy in any of them could drift. It tests HIGH surrogates only,
// which is correct and load-bearing: a string holding only LONE LOW surrogates has
// `codePointAt === charCodeAt` at every index and advances one unit per step, so the slow path
// below degenerates to exactly the code-unit comparison a plain `<` performs.
export const HAS_SURROGATE = /[\uD800-\uDBFF]/;
/**
 * Compare two strings by Unicode CODE POINT, matching Rust `str::cmp` (UTF-8 byte
 * order == code-point order). JS `<`/`>` order by UTF-16 code UNIT, which disagrees
 * when an astral char (surrogate pair, ≥ U+10000) meets a BMP char in U+E000..U+FFFF:
 * the high surrogate (0xD800..0xDBFF) sorts BELOW U+E000 by code unit, but the astral
 * code point sorts ABOVE it. Iterating code points (via `codePointAt` + a 1-or-2 unit
 * step, allocation-free) makes both engines agree. Fast path: with no surrogate in
 * either string every char is BMP, so UTF-16 order already equals code-point order and
 * the native compare (much faster than a per-char loop) is exact.
 */
/*
 * REJECTED, with numbers — two cheaper GUARDS and one hoist (item 921). A CPU profile of a
 * sorted-page query put the regex below at 6.9% of the profile and this function at another 8.0%,
 * and the guard scans BOTH WHOLE STRINGS on EVERY comparison, re-establishing a per-string fact
 * O(log N) times during a sort. Three arms, measured in `packages/native/codepoint-guard-probe.mjs`
 * (floor = the bare native compare, which no guard can beat):
 *
 *     data        floor      ref     scan    ref/scan
 *     ascii         0.8      2.1      1.9       1.08x
 *     prefixed      1.2      2.7      9.5       0.28x
 *     astral        0.9      3.2      1.7       1.95x
 *
 *   - replacing the regex with a manual charCode loop (`scan`): REFUTED. 1.08x on ASCII is inside
 *     the ~10% noise band, and on keys with a long shared prefix it is 3.6x WORSE. V8's
 *     character-class match beats a hand-written loop, so THE REGEX IS THE RIGHT TOOL here.
 *   - deciding from the first differing code UNIT (`diff`): REFUTED ON CORRECTNESS, premise and
 *     all. Equal unit prefixes do NOT imply equal code-POINT prefixes, because segmentation
 *     depends on the FOLLOWING unit: the same high surrogate can begin a pair in one string and be
 *     LONE in the other, so `"\ud83d\ude00"` and `"\ud83d\ue000"` agree on unit 0 and disagree
 *     on what it means. Making it correct needs both strings proven free of lone surrogates, which
 *     is the whole-string scan it existed to avoid.
 *   - hoisting the guard OUT of the comparator so a sort tests each key once: SOUND but DECLINED.
 *     It can only remove the regex itself — 133.8 ms of a 1952 ms profile, so ~1.07x on that query
 *     shape at best — for an invasive change to a comparator that is generic over value types.
 *
 * If you come back to this, the hoist is the only live option and the ceiling above is what it has
 * to beat.
 */
export const compareCodePoints = (a: string, b: string): number => {
  if (!HAS_SURROGATE.test(a) && !HAS_SURROGATE.test(b)) {
    if (a < b) {
      return -1;
    }

    return a > b ? 1 : 0;
  }

  let i = 0;
  let j = 0;

  while (i < a.length && j < b.length) {
    const ca = a.codePointAt(i) as number;
    const cb = b.codePointAt(j) as number;

    if (ca !== cb) {
      return ca < cb ? -1 : 1;
    }

    i += ca > 0xffff ? 2 : 1;
    j += cb > 0xffff ? 2 : 1;
  }

  // Whichever string still has characters is the longer one, hence greater; a
  // prefix sorts before its extension.
  if (i < a.length) {
    return 1;
  }

  return j < b.length ? -1 : 0;
};

import type { Graph } from '@lenke/core';
import { ErrorCode, LenkeError } from '@lenke/errors';

import type { Statement } from './ast.js';
import { isTxControl } from './ast.js';
import { type Normalized, normalizeLiterals } from './auto-param.js';

export { normalizeLiterals } from './auto-param.js';
import {
  compile,
  compileValidator,
  execute,
  freePredicateVars,
  type Plan,
  type Row,
} from './executor.js';
import { parse, parsePredicate } from './parser.js';

export type {
  Query,
  Statement,
  TxControl,
  MatchClause,
  PathPattern,
  NodePattern,
  RelPattern,
  Expr,
} from './ast.js';
export { isTxControl } from './ast.js';
export type { Plan, Row } from './executor.js';
export { GqlSyntaxError, isReserved, quoteIdent } from './lexer.js';
export { parse, parsePredicate } from './parser.js';
export { compile, compileValidator, execute } from './executor.js';

/**
 * Declare a custom VALIDATOR constraint: every element carrying `label` (a vertex
 * label OR an edge type) must satisfy the GQL boolean `predicate`, with the
 * element bound to `varName` (`createValidator(g, 'User', 'u', 'u.age >= 0 AND
 * u.age < 150')`). `predicate` is pure ISO GQL — exactly what can follow `WHERE`.
 *
 * SQL-`CHECK` semantics: a write is rejected ({@link ErrorCode.ConstraintViolation})
 * only when the predicate evaluates to a *definite* `false`; a `null`/unknown
 * result PASSES (an element with an absent optional property isn't a violation).
 * Enforced at the mutation boundary and deferred to a transaction/statement
 * commit like the other constraints. A declare-time scan rejects if any existing
 * element already fails. An unparseable `predicate` throws {@link GqlSyntaxError}
 * (`E_SYNTAX`) here, at declaration time.
 *
 * Only `@lenke/gql` can offer this (core can't parse a GQL expression): the
 * predicate is parsed+compiled into a closure and registered into the graph via
 * `graph.registerValidator`. The native engine's `RustGraph.createValidator`
 * takes the SAME `(label, varName, predicate)` and enforces it identically in the
 * Rust GQL evaluator — the byte-identical dual-engine invariant.
 */
export const createValidator = (
  graph: Graph,
  label: string,
  varName: string,
  predicate: string,
): void => {
  // A native `RustGraph` compiles + enforces the predicate in-engine (no JS
  // closure), exposing `createValidator` as a *method*. Dispatch to it so this
  // free-function form works on either engine instead of throwing a raw
  // `TypeError` ("registerValidator is not a function") on a native graph.
  const nat = graph as unknown as {
    registerValidator?: unknown;
    createValidator?: (l: string, v: string, p: string) => void;
  };

  if (typeof nat.registerValidator !== 'function') {
    if (typeof nat.createValidator === 'function') {
      nat.createValidator(label, varName, predicate);

      return;
    }

    throw new LenkeError('createValidator: expected a @lenke/core Graph or a native RustGraph', {
      code: ErrorCode.InvalidGraphOp,
    });
  }

  const expr = parsePredicate(predicate);

  // Reject a predicate that references any variable *other* than the declared
  // `varName` at DECLARE time. Such a name (`x.age` when the binding is `u`, or a
  // bare `age`) is unbound → the predicate reads UNKNOWN → the SQL-`CHECK` never
  // fires and the validator silently does nothing. A predicate with no variable
  // at all (a constant like `1 = 1`) is legitimately allowed. Uses `E_SYNTAX`,
  // matching the native engine (whose FFI already maps a bad predicate to that
  // code) so both engines reject identically.
  for (const name of freePredicateVars(expr)) {
    if (name !== varName) {
      throw new LenkeError(
        `validator predicate references unbound variable \`${name}\` (only the declared variable \`${varName}\` is in scope)`,
        { code: ErrorCode.Syntax },
      );
    }
  }

  const compiled = compileValidator(expr, varName);

  graph.registerValidator(label, varName, predicate, (element) => compiled(element, graph));
};

/**
 * Declare a graph-level INVARIANT: a whole-graph GQL assertion `query` (a full
 * `MATCH … RETURN`, not a bare predicate) that must hold after every write
 * transaction — the cross-write analogue of a per-element {@link createValidator}
 * (`createInvariant(g, 'balanced', 'MATCH (a:Acct) RETURN sum(a.balance) = 0')`).
 *
 * Unlike a validator (checked per touched element), an invariant is evaluated
 * ONCE per commit against the fully-staged graph. `false`-only-fails: the
 * invariant is VIOLATED iff any cell in the result set is boolean `false`;
 * everything else — `true`, `null`, a non-boolean value, an empty result set —
 * HOLDS. So `RETURN sum(a.balance) = 0` fails only when the sum isn't zero.
 * Violations throw {@link ErrorCode.ConstraintViolation} and roll the transaction
 * back. It runs at every commit boundary (each auto-committing GQL write
 * statement, and `graph.transaction(fn)`), but only when the transaction actually
 * wrote something — a pure-read transaction never pays the cost. A declare-time
 * run rejects (`ConstraintViolation`) if the current graph already violates it.
 * An unparseable/uncompilable `query` throws {@link GqlSyntaxError} (`E_SYNTAX`)
 * here, at declaration time.
 *
 * Only `@lenke/gql` can offer this (core can't parse a GQL query): the query is
 * parsed+compiled into a closure and registered into the graph via
 * `graph.registerInvariant`. The native engine's `RustGraph.createInvariant`
 * takes the SAME `(name, query)` and enforces it identically in the Rust GQL
 * evaluator — the byte-identical dual-engine invariant.
 */
export const createInvariant = (graph: Graph, name: string, querySrc: string): void => {
  // Native `RustGraph` exposes `createInvariant` as a *method* (enforced
  // in-engine); dispatch to it so this free-function form works on either engine.
  const nat = graph as unknown as {
    registerInvariant?: unknown;
    createInvariant?: (n: string, q: string) => void;
  };

  if (typeof nat.registerInvariant !== 'function') {
    if (typeof nat.createInvariant === 'function') {
      nat.createInvariant(name, querySrc);

      return;
    }

    throw new LenkeError('createInvariant: expected a @lenke/core Graph or a native RustGraph', {
      code: ErrorCode.InvalidGraphOp,
    });
  }

  const parsed = parse(querySrc);

  // An invariant must be a whole-graph `MATCH … RETURN` assertion, never a
  // transaction-control command.
  if (isTxControl(parsed)) {
    throw new LenkeError('an invariant must be a MATCH … RETURN query, not a transaction command', {
      code: ErrorCode.Unsupported,
    });
  }

  const plan = compile(parsed);

  graph.registerInvariant(name, querySrc, (g) => plan(g));
};

/**
 * Parse + compile a query string into a reusable `Plan`. Do this once for a hot
 * query, then call the plan with just `(graph, params)` — no re-parse, no
 * re-analysis per run.
 */
export const prepare = <R extends Row = Row>(
  text: string,
  opts?: { maxOperatorChain?: number },
): Plan<R> => {
  const parsed = parse(text, { maxOperatorChain: opts?.maxOperatorChain });

  // A transaction-control command has no reusable plan — run it with `query()`.
  if (isTxControl(parsed)) {
    throw new LenkeError(
      'cannot prepare a transaction-control statement (START TRANSACTION/COMMIT/ROLLBACK); run it with query()',
      { code: ErrorCode.Unsupported },
    );
  }

  return compile<R>(parsed);
};

/**
 * Fold a graph's wired {@link Clock} (`graph.setClock`) into a query's params:
 * bind `$__now` from the clock for the ISO now-functions, unless the caller
 * passed an explicit `$__now` (explicit always wins — deterministic for tests).
 * Returns the params unchanged when no clock is wired — zero cost on the common
 * path. The engine never reads a clock; this resolves one host-side per query.
 */
const withClock = (
  graph: Graph,
  params: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined => {
  const { clock } = graph;

  if (!clock || (params && Object.hasOwn(params, '__now'))) {
    return params;
  }

  return { ...params, __now: clock() };
};

/**
 * Parse + run a query string against a graph in one call, with optional
 * `$params`. Pass a row shape to type the result — `query<{ name: string }>(g,
 * '… RETURN a.name AS name')` returns `{ name: string }[]` — an opt-in,
 * caller-side assertion (rows are `Record<string, unknown>` at runtime).
 *
 * `graph.setClock(() => …)` makes `current_date`/`current_timestamp` read wall
 * time; an explicit `params.__now` overrides that clock.
 */
/**
 * How many parsed statements the cache below holds.
 *
 * MEASURED, not picked. A retained `Statement` is ~2,064 bytes (2,000 distinct queries held 4,032
 * KB), so 64 entries is ~129 KB — small enough to be invisible next to any graph worth querying.
 *
 * The cap is small for a second reason: recency tracking gets expensive as the map grows, because
 * it is a `delete` plus a `set` per hit and this runtime degrades on that. Measured against the
 * 4,540ns parse it replaces:
 *
 *     cap     get only     get + delete + set
 *      64        0.1ns                 57.2ns      1.3% of the saving
 *     256       11.0                  191.5        4.2%
 *    2000       11.4                 1179.0       26%        — would eat the win
 *
 * So 64 keeps true LRU behaviour affordable. At a larger cap the honest choice would have been
 * FIFO eviction instead, which costs nothing per hit but keeps the wrong entries.
 */
const PARSE_CACHE_CAP = 64;

/**
 * Parsed statements by query TEXT — a bounded LRU, because `query()` was re-lexing, re-parsing and
 * re-compiling the same text on every call and parse is roughly half of a cheap query's cost
 * (audit items 227, 228).
 *
 * Keyed on the text alone, with `maxOperatorChain` stored and VERIFIED on a hit rather than folded
 * into the key: the chain is a construction-time graph setting that almost never varies, and
 * building a composite key would mean a string concatenation on the hot path to avoid a collision
 * that costs one integer compare to detect.
 */
const parseCache = new Map<string, { chain: number | undefined; stmt: Statement }>();

/**
 * Query texts seen ONCE but not yet cached — an admission filter, and the reason this change does
 * not punish the workload it cannot help.
 *
 * A first version cached every parse immediately. That made an ALL-MISS workload (a value
 * interpolated into the text rather than bound, so every call has a fresh text) **16% SLOWER**:
 * 9.26us against 10.73. The Map operations were not the cost — the full miss path measures 202ns
 * in isolation. The cost is RETENTION: a parsed statement is ~2KB and used to die young, where a
 * cache keeps it alive across 64 more allocations, which tenures it and makes collecting it far
 * more expensive. A cache that holds objects nothing will ask for again pays GC for the privilege.
 *
 * So a text is cached on its SECOND sighting, not its first. This set holds TEXTS only — strings
 * the caller already has — so a single-use query retains nothing beyond its own key, and the
 * all-miss workload pays two failed lookups instead of an eviction plus a tenured AST.
 *
 * The cost is a one-call warmup: a text is parsed twice before it is cached. Against a hit path
 * that repeats thousands of times, that is not a trade worth optimising away.
 */
const seenOnce = new Set<string>();

/**
 * `parse`, memoised on the query text.
 *
 * Reuse is sound because a `Statement` is INERT: `execute` does not mutate it, parameters are bound
 * at execution and not baked in, and a cached statement sees graph mutations that happened after it
 * was parsed. All three were verified before this was written — a cache over an AST that `execute`
 * annotated would return stale answers on the second call, which is the failure this would have
 * had.
 *
 * A parse that THROWS is not cached: nothing is stored, so a failing query re-throws every time
 * rather than being remembered. That is the right way round — a failing query is not a hot path,
 * and caching a thrown error would make the first failure permanent for that text.
 */
/**
 * The cache HIT alone, with no parse and no admission bookkeeping — `undefined` on a miss.
 *
 * Extracted at item 1502 so `query` can ask "is this text already known?" before paying for
 * anything else. That ordering is the whole reason auto-parameterization is free for callers who
 * already use parameters: their text repeats, so it hits here and never reaches the tokenizer.
 */
/**
 * The LIFT memo — ONE SLOT, deliberately (item 1541).
 *
 * ⚠️ WITHOUT IT, AUTO-PARAMETERIZATION DEFEATS THE PARSE CACHE FOR EVERY TEXT IT HELPS. The lifted
 * statement is cached under the LIFTED text, so `parseCacheHit(originalText)` misses on every
 * repeat call and `normalizeLiterals` re-tokenizes — forever. Item 1540 measured it and confirmed
 * the key against the cache's own state (after four calls of `LET x = 5 RETURN x`, querying
 * `LET x = $__ap0 RETURN x` directly leaves the cache size at 1):
 *
 * ```text
 *   LET x = 5 RETURN x     1013.2 ns/call
 *   LET x = $p RETURN x     270.1          <- the SAME plan, 3.75x apart
 * ```
 *
 * `RETURN 1 AS v` escapes at ~110 ns for the opposite reason — `MAYBE_LIFTABLE` rejects it, so no
 * lift happens and the ORIGINAL text is what gets cached. The gap was exactly "did a lift happen",
 * which made the queries this feature exists for the only ones that never hit a cache.
 *
 * ⚠️ WHY ONE SLOT AND NOT AN LRU, WHICH IS WHAT I BUILT FIRST. A `Map` keyed by the original text
 * holds one entry per distinct literal value — the pollution the lifted key exists to avoid — and
 * it made item 1502's ALL-MISS workload (a value interpolated into the text, so every call has a
 * fresh text and nothing can ever hit) **17% slower**: 1367 -> 1598 ns/call over six readings each.
 * Adding that cache's own admission filter — memoise on the SECOND sighting — recovered only half
 * of it, to **1500, still 10% down**, because the all-miss caller still pays a `get`, a `has`, an
 * eviction and an `add`, and still RETAINS 64 fresh strings.
 *
 * Item 1502 rejected a 16% regression on exactly this workload. One slot has no bookkeeping to pay:
 * a miss is two field writes, retains one string, and evicts by overwriting. The caller it serves
 * is the one that matters — a hot query in a loop — and a caller alternating between several
 * literal texts degrades to today's cost rather than below it.
 *
 * SOUND because `normalizeLiterals` is a pure function of the text: for an identical text the
 * lifted text and values are identical. No `chain` is stored — the lift does not consult it, and
 * the statement is still fetched through `parseCached(lifted.text, chain)`, which verifies it.
 *
 * ⚠️ AND THE VALUES ARE SPREAD PER CALL rather than handed over by reference. `withClock` returns
 * its `params` argument UNCHANGED when the graph has no clock, so a memoised object would reach
 * `execute` directly and be shared by every later call of that text. Nothing is known to mutate it
 * — a user's own params object already flows that way — but a spread of a small object costs ~25 ns
 * against the ~740 this saves, so the question is bought out rather than reasoned about.
 */
/**
 * How many distinct liftable texts stay memoised at once.
 *
 * ⚠️ FOUR, AND THE KNOB IS CALIBRATED, NOT PICKED. Item 1541 shipped ONE slot, and item 1542 then
 * measured what it actually does to a serving mix: a caller rotating N distinct liftable texts
 * round-robin, which is a server with N hot queries. One slot wins at N=1 and loses EVERYTHING at
 * N=2 — two hot literal queries and the memo never hits.
 *
 * ```text
 *   design    letlit   rot2    rot3    rot4   allmiss   vs PRE all-miss
 *   PRE          994   ~1000   ~1000   ~1000     1367         —
 *   1 slot       250    1030    1080    1015     1390       +1.7%
 *   ring of 2    258     262    1027    1016     1396       +2.1%
 *   ring of 4    245     249     226     225     1437       +5.1%
 * ```
 *
 * The all-miss cost is K failed string compares per call, so it rises with K. Accepting ~5% there
 * is a different judgement from item 1541's rejection of the LRU at 10-17%, and the difference is
 * what the cost BUYS: the LRU's 10% bought nothing a single slot did not already have, while this
 * 5% buys rot3/rot4 at 4.2x. The 5% also overlaps the measurement spread (PRE ranges 1304-1551
 * across six readings), where the LRU's regression did not.
 *
 * Re-tune it with that table: `LIFT_SLOTS = 2` is the cheaper point if the all-miss workload ever
 * matters more than a 3-or-4-query serving mix.
 */
const LIFT_SLOTS = 4;
const liftSlotTexts: (string | undefined)[] = Array.from({ length: LIFT_SLOTS });
const liftSlotValues: (Normalized | undefined)[] = Array.from({ length: LIFT_SLOTS });
let liftSlotNext = 0;
/**
 * How often the slot answered, and how often it was written.
 *
 * ⚠️ THE ROUTE IS OTHERWISE UNTESTABLE, which is the same reason `parseCacheStats` reports `seen`:
 * a memo is answer-equivalent, so every mutant that disables it passes the whole suite. Mutation
 * says so directly — `never-store` and `store-before-parse` both survived 3,858 tests. Counting is
 * what turns "is the slot used?" into an assertion.
 */
let liftSlotHits = 0;
let liftSlotStores = 0;

const parseCacheHit = (text: string, chain: number | undefined): Statement | undefined => {
  const hit = parseCache.get(text);

  if (hit === undefined || hit.chain !== chain) {
    return undefined;
  }

  // Move to the end: `Map` preserves insertion order, so eviction drops the LEAST RECENTLY used.
  //
  // ⚠️ ONLY WHILE THE CACHE IS FULL, and that gate is worth 1.24x on a warm call (item 1509). The
  // `delete` + `set` pair is ~25 ns — 24.5% of a 103 ns `RETURN 1 AS v` — and it is recording a
  // recency order that is read by exactly one thing: the eviction in `parseCached`. Below the cap
  // nothing is ever evicted, so the order it maintains is never consulted and the whole pair is
  // bookkeeping for a decision that will not be taken. Most processes live here permanently: the
  // cap is 64 and applications send a handful of distinct texts.
  //
  // ⚠️ THE APPROXIMATION THIS ACCEPTS, stated precisely: while under the cap no recency is
  // recorded, so at the moment the cache FILLS its order is insertion order rather than true LRU,
  // and the first eviction may drop a hot entry that a fully-tracked LRU would have kept. From
  // then on every hit is tracked again and the order converges back. It is a choice among 64
  // cached parses — a cache-policy approximation that can only cost a re-parse, never an answer.
  // The alternative of dropping the pair outright measured the same 1.24x and is strictly worse:
  // it makes eviction permanently FIFO, which thrashes for a caller cycling over more than 64 hot
  // texts. This keeps true LRU for exactly the workload that needs it.
  if (parseCache.size >= PARSE_CACHE_CAP) {
    parseCache.delete(text);
    parseCache.set(text, hit);
  }

  return hit.stmt;
};

const parseCached = (text: string, chain: number | undefined): Statement => {
  const hit = parseCache.get(text);

  if (hit !== undefined && hit.chain === chain) {
    // Move to the end: `Map` preserves insertion order, so the eviction below drops the LEAST
    // RECENTLY used rather than the oldest parsed — but ONLY while the cache is full, for the
    // reason given at the same gate in `parseCacheHit` (item 1509). This hit path is reached by
    // the auto-parameterized route (`query` parses the LIFTED text here), so it is hot for a
    // caller that interpolates literals, not a cold fallback.
    if (parseCache.size >= PARSE_CACHE_CAP) {
      parseCache.delete(text);
      parseCache.set(text, hit);
    }

    return hit.stmt;
  }

  const stmt = parse(text, { maxOperatorChain: chain });

  if (hit !== undefined) {
    // Same text, a different chain. The `set` below already REPLACES the value, so this delete is
    // not what prevents a stale parse — it moves the entry to the end so the replacement counts as
    // recently used instead of inheriting the old insertion position. (Mutation says so: removing
    // it changes no answer.)
    parseCache.delete(text);
  } else if (!seenOnce.has(text)) {
    // FIRST sighting: remember the text and return without retaining the statement. See
    // `seenOnce` — admitting here is what made an all-miss workload 16% slower.
    if (seenOnce.size >= PARSE_CACHE_CAP) {
      const oldestSeen = seenOnce.values().next().value;

      if (oldestSeen !== undefined) {
        seenOnce.delete(oldestSeen);
      }
    }

    seenOnce.add(text);

    return stmt;
  } else if (parseCache.size >= PARSE_CACHE_CAP) {
    const oldest = parseCache.keys().next().value;

    if (oldest !== undefined) {
      parseCache.delete(oldest);
    }
  }

  // A repeat: it has earned its ~2KB.
  seenOnce.delete(text);
  parseCache.set(text, { chain, stmt });

  return stmt;
};

/**
 * The parse cache's occupancy and its cap.
 *
 * Exported because BOUNDEDNESS is the property this cache was chosen for, and without a way to
 * read the size that bound is an assertion rather than something a test can check. Mutation made
 * the point: removing the eviction entirely changes no ANSWER, so every answer-comparing test
 * passes while the cache grows without limit — a memory leak no correctness suite can see.
 *
 * `seen` is the admission filter's occupancy; it holds TEXTS only, never statements.
 */
export const parseCacheStats = (): {
  size: number;
  seen: number;
  cap: number;
  liftHits: number;
  liftStores: number;
} => ({
  size: parseCache.size,
  seen: seenOnce.size,
  cap: PARSE_CACHE_CAP,
  liftHits: liftSlotHits,
  liftStores: liftSlotStores,
});

/**
 * AUTO-PARAMETERIZATION (item 1502), and the ORDER of these three steps is the design.
 *
 * 1. Ask the parse cache first. A caller who already uses parameters sends a repeating text, hits
 *    here, and never pays a byte for anything below — which is the point: the sloppy caller must
 *    not be subsidised by the careful one. (A tokenize is ~865 ns against a cached call of
 *    1-4 us, so paying it unconditionally would be a 20-60% regression for correct code.)
 * 2. On a MISS, try lifting literals into parameters. Items 1499-1501: parse+plan is 3.1-6.9x the
 *    execution of a cheap query, interpolated text misses by construction, and item 1501's gate
 *    found the rewrite answer-safe in every position tested and route-safe in all but `LIMIT`,
 *    which `normalizeLiterals`' allowlist excludes by construction.
 * 3. If the rewritten text does not PARSE, fall back to the original. A rewrite can only produce
 *    invalid syntax, never different semantics, for the positions the allowlist admits — so a
 *    parse failure is the safe failure, and taking it costs one wasted parse on a path that was
 *    going to parse anyway.
 *
 * ⚠️ THE GUARD IS AROUND THE PARSE AND NOT AROUND `execute`, deliberately. Retrying a failed
 * `execute` would re-run a statement that may already have written — an INSERT that raised halfway
 * would apply twice. `execute` is called exactly once here, on whichever statement step 2 or 3
 * settled on.
 *
 * ⚠️ USER PARAMS WIN over synthetic ones. They cannot actually collide — the synthetic namespace is
 * `__ap<n>` — but spreading them last means a future namespace change cannot silently shadow a
 * caller's own binding.
 */
export const query = <R extends Row = Row>(
  graph: Graph,
  text: string,
  params?: Record<string, unknown>,
): R[] => {
  const chain = graph.maxOperatorChain;
  const cached = parseCacheHit(text, chain);

  if (cached !== undefined) {
    return execute<R>(cached, graph, withClock(graph, params));
  }

  let memoed: Normalized | undefined;

  for (let s = 0; s < LIFT_SLOTS; s += 1) {
    if (liftSlotTexts[s] === text) {
      memoed = liftSlotValues[s];
      liftSlotHits += 1;
      break;
    }
  }

  const lifted = memoed ?? normalizeLiterals(text);

  if (lifted !== undefined) {
    try {
      const stmt = parseCached(lifted.text, chain);

      // Only AFTER the lifted text has parsed. A lift whose text does not parse falls through
      // below, and remembering it would commit every later call of that text to the same wasted
      // parse.
      if (memoed === undefined) {
        liftSlotTexts[liftSlotNext] = text;
        liftSlotValues[liftSlotNext] = lifted;
        liftSlotNext = (liftSlotNext + 1) % LIFT_SLOTS;
        liftSlotStores += 1;
      }

      return execute<R>(
        stmt,
        graph,
        withClock(
          graph,
          params === undefined ? { ...lifted.params } : { ...lifted.params, ...params },
        ),
      );
    } catch {
      // Fall through to the original text, whose parse will raise the caller's real error if there
      // is one. Nothing has executed at this point.
    }
  }

  return execute<R>(parseCached(text, chain), graph, withClock(graph, params));
};

/**
 * Bind a graph and return a runner. Supports both a tagged-template form
 *   gql(g)`MATCH (a:Person) WHERE a.name = ${name} RETURN a`
 * and a plain-string form (with optional `$name` bindings)
 *   gql(g)('MATCH (a:Person) WHERE a.name = $name RETURN a', { name })
 *
 * Template `${}` substitutions compile to `$p0…$pn` **bindings** — values bind
 * to already-parsed param slots at execute time and never touch the parser, so
 * quotes/operators/keywords in a value stay inert data. (They are NOT spliced
 * into the query text.) Templates own the `$p<n>` namespace — don't hand-write
 * `$p0` inside a template that also has `${}` substitutions. This is the same
 * convention as `@lenke/native`'s `RustGraph.query`, so consumers feel no seam
 * between engines.
 */
export const gql = <R extends Row = Row>(graph: Graph) => {
  return (strings: TemplateStringsArray | string, ...values: unknown[]): R[] => {
    if (typeof strings === 'string') {
      const params = values[0] as Record<string, unknown> | undefined;

      return execute<R>(
        parseCached(strings, graph.maxOperatorChain),
        graph,
        withClock(graph, params),
      );
    }

    const params: Record<string, unknown> = {};
    const text = strings.reduce((acc, part, i) => {
      if (i >= values.length) {
        return acc + part;
      }

      params[`p${i}`] = values[i];

      return `${acc + part}$p${i}`;
    }, '');

    // The TEMPLATE form caches well: `${}` substitutions become `$p0…$pn` BINDINGS, so the text is
    // identical across calls with different values — which is the shape a cache wants.
    return execute<R>(parseCached(text, graph.maxOperatorChain), graph, withClock(graph, params));
  };
};

/**
 * Parse a query string to its AST without executing (useful for tooling/tests).
 * Returns a {@link Statement}: a {@link Query}, or a {@link TxControl} for a
 * `START TRANSACTION`/`COMMIT`/`ROLLBACK` command.
 */
export const parseQuery = (text: string): Statement => parse(text);

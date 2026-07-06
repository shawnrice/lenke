# TinkerPop parity gaps

Tracked gaps surfaced while importing TinkerPop reference scenarios as
tests. Each item is something where our v2 implementation diverges from
the canonical TinkerPop semantics in a way that's worth fixing (versus
intentional design differences, which live as inline `// doc:` comments
in the test files and aren't tracked here).

## Data-model differences (not gaps)

TinkerPop's reference graph is a **multi-graph with first-class
properties** — each property is itself an `Element` with an ID, label,
and meta-properties, and a key can hold multiple values (cardinality:
single/list/set). Our property-label graph is simpler: properties are
a flat `Record<string, unknown>`, one value per key, no property
identity.

Several apparent "drifts" from TinkerPop docs are direct consequences
of this model choice and are _not_ tracked as gaps:

- `valueMap()` returns `{key: value}` instead of `{key: [value]}`.
  TinkerPop wraps everything in lists to be cardinality-polymorphic; we
  don't need to because we don't have list cardinality.
- `propertyMap()` returns flat values instead of property objects
  (`vp[name->marko]`). We don't have property objects.
- `id()` on the result of `properties()` emits `undefined`. Properties
  don't have identity in our model.

If we ever adopt multi-property semantics in core, these become real
gaps. Until then, they're documented in `// doc:` comments inline.

## Feature gaps surfaced by docs

These are missing capabilities, not behavioral drift. Tests note them
where applicable.

(The TS engine is currently gap-free here: `match()`, `subgraph()`, and
`shortestPath()` are implemented, `math()` resolves `as_`-bound names projected
by `by()`, and `by()` supports comparator/token forms. The gremlin test package
has no skipped tests.)

### Cross-engine parity (TS engine ⟷ Rust core)

The Rust gremlin engine (`crates/lenke-core/src/gremlin`) mirrors the TS package
step-for-step. Parity is verified by a differential runner
(`packages/native/src/gremlin-conformance.test.ts`): a single TS `Plan` is run
through the TS engine in-process and the Rust core over `bun:ffi`, and the
canonical JSON results are compared.

The only remaining divergences are the **TS-superset features** — steps that
exist in the TS DSL but not (yet) in the text-driven Rust engine:

- **Closures** (`map(fn)`/`filter(fn)`/`sideEffect(fn)`/`fold(seed, fn)`): a JS
  closure can't cross the Groovy-text boundary at all. This is permanent; use
  the sub-traversal forms for cross-engine plans.
- **`regex`** predicate: not yet in the Rust engine (needs a regex dependency;
  the `regex` crate is linear-time and does not support backreferences or
  lookaround — a narrow, documented divergence from JS `RegExp`). _(In progress.)_

Now at parity (previously TS-only):

- **`math()`** — the Rust engine ships the same infix evaluator (`+ - * /`,
  parens, `_`/`as_`-bound operands, cycling `by()` projection); non-numeric
  operands fault on both engines.
- **`branch()`** — `branch(test).option(match, …)…option(none, …)`; the `none`
  default is TinkerPop's `Pick.none`. Routes each traverser by its test result.

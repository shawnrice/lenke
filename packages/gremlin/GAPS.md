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
of this model choice and are *not* tracked as gaps:

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

### `subgraph()` not implemented

`executor.ts` throws "not yet implemented" for the `subgraph` step;
`subgraph.test.ts` is a `test.skip` stub.

### `Scope.local` on aggregation steps

`Scope.local` is wired through `take`/`skip`/`limit`/`range`/`tail` —
they slice each traverser's iterable value when given the local-scope
arg. Not yet wired through `count`/`sum`/`min`/`max`/`mean`. Doc form
`g.V().valueMap().count(Scope.local)` (count keys per map) is reachable
on the slice-family but not the aggregate-family.

### `math()` doesn't resolve `as_`-bound names

`math('a + b').by('age')` references named positions tagged with `as_`.
We don't resolve those — `math` only sees the current value.


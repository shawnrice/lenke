# @pl-graph/fp

> Lazy, curried iterable combinators for composing data transformations over any `Iterable`.

A small functional toolkit for working with synchronous iterables. Transformations (`map`, `filter`, `flatMap`, …) are lazy generators that produce nothing until consumed, terminals (`toArray`, `reduce`, `count`, …) materialize a result, and `pipe` threads a value through a chain. Reach for it when you want point-free, allocation-light pipelines over arrays, `Set`s, `Map`s, or custom generators without pulling in a larger FP runtime.

## Install

```bash
bun add @pl-graph/fp
```

## Usage

Every combinator has two forms: a data-last curried form `fn(args)` that returns a unary function for `pipe`, and a data-first form `fn(args, iterable)` that runs immediately.

```ts
import { pipe, map, filter, take, toArray, reduce, groupBy } from '@pl-graph/fp';

const numbers = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

// Curried form composed with `pipe`. Nothing runs until `toArray` consumes it.
const evenSquares = pipe(
  filter((n: number) => n % 2 === 0),
  map((n) => n * n),
  take(3),
  toArray,
)(numbers);
// [4, 16, 36]

// Terminals can also be used data-first.
const total = reduce((acc: number, n: number) => acc + n, 0, numbers);
// 55

const byParity = groupBy((n: number) => (n % 2 === 0 ? 'even' : 'odd'), numbers);
// Map { 'odd' => [1,3,5,7,9], 'even' => [2,4,6,8,10] }
```

Because sources are lazy, you can guard materializing terminals against infinite iterables with `bounded`:

```ts
import { bounded, count, take } from '@pl-graph/fp';

function* naturals() {
  for (let i = 1; ; i++) yield i;
}

bounded(count)(naturals());   // caps consumption (default 1_000_000)
count(take(100, naturals())); // or cap explicitly with `take`
```

## Exports

Lazy combinators return an `Iterable` and consume their input on demand; terminals (marked internally with `boundary(...)`) fully materialize their input.

- Transform (lazy): `map`, `filter` / `select`, `reject`, `flatMap`, `flatten`, `pick`, `enumerate`, `intersperse`, `zip`, `window`, `chunk`, `sideEffect`
- Slice / dedupe (lazy): `take`, `takeWhile`, `takeLast`, `skip`, `skipWhile`, `dropLast`, `slice`, `before`, `after`, `distinct`, `uniq`, `uniqBy`
- Sets (lazy): `union`, `intersection`, `difference`
- Terminals: `toArray`, `reduce`, `count`, `first`, `last`, `find`, `findIndex`, `every`, `some`, `equals`, `partition`, `groupBy`, `keyBy`, `sort`, `sortBy`
- Numeric terminals: `sum`, `sumBy`, `min`, `minBy`, `max`, `maxBy`, `mean`
- Composition & guards: `pipe`, `bounded`, `boundary`

`pipe` also supports an explicit-input form, `pipe<I>()(fn0, fn1, …)`, for anchoring chains that begin with a generic combinator (e.g. `skip`, `take`) which has no upstream type to infer from. Author your own terminals by wrapping them in `boundary(...)` so `bounded` recognizes them.

## License

Apache-2.0

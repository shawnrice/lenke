# @pl-graph/list

> A lazy, iterator-backed list with array-like methods and a known (or infinite) length.

`List<T>` wraps a generator function rather than a materialized array, so transformations like `map`, `filter`, `take`, and `skip` compose lazily and only do work when you iterate the result. Reach for it when you are chaining operations over iterables, working with potentially infinite sequences, or want array-style methods without eagerly copying data at each step.

## Install

```bash
bun add @pl-graph/list
```

## Usage

```ts
import { List } from '@pl-graph/list';

// Build a list from values, an array, a Set, or any iterable.
const numbers = List.of(1, 2, 3, 4, 5, 6);
const fromArray = List.from([10, 20, 30]);
const fromSet = List.from(new Set([1, 1, 2, 3]));

// Transformations are lazy and chainable; nothing runs until you consume.
const result = numbers
  .filter((n) => n % 2 === 0) // 2, 4, 6
  .map((n) => n * 10) // 20, 40, 60
  .take(2); // 20, 40

console.log(result.toArray()); // [20, 40]

// Lists are iterable.
for (const n of result) {
  console.log(n);
}

// Works with infinite generators; length is Infinity until bounded.
function* naturals() {
  let i = 0;
  while (true) yield i++;
}

const firstFive = List.from(naturals)
  .map((n) => n * n)
  .take(5);
console.log(firstFive.toArray()); // [0, 1, 4, 9, 16]

// Element access.
firstFive.head(); // 0
firstFive.last(); // 16
firstFive.tail().toArray(); // [1, 4, 9, 16]
```

## API

### Constructors

- `new List(generator, length?)` — wrap a generator function; `length` defaults to `Infinity`.
- `List.of(...args)` — create a list from explicit values.
- `List.from(iterable)` — create a list from any iterable (array, `Set`, generator, another `List`). Length is inferred from `length`/`size` when present.
- `List.empty()` — an empty list.
- `List.isList(x)` — type guard for `List` instances.

### Properties

- `length: number` — known element count, or `Infinity` when unknown.

### Lazy transformations (return a new `List`)

`after(predicate)`, `before(predicate)`, `distinct()`, `filter(predicate)`, `map(mapper)`, `reject(predicate)`, `sideEffect(effect)`, `skip(n)`, `skipWhile(predicate)`, `take(n)`, `takeWhile(predicate)`, `tail()`, `sort(sorter)` (sorting buffers into an intermediary array), `toList()` (clone).

### Terminal operations

- `equals(list, comparator?)` — compare element-by-element.
- `every(predicate)`, `some(predicate)` — boolean reductions.
- `head()` — first element or `undefined`.
- `last()` — final element or `undefined`.
- `toArray()` — materialize into an array.
- `[Symbol.iterator]()` — iterate with `for...of` or spread.

## License

Apache-2.0

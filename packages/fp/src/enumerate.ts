export function* enumerate<T>(iterable: Iterable<T>): Iterable<[number, T]> {
  let index = 0;
  for (const item of iterable) {
    yield [index++, item];
  }
}

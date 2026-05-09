export function* zip<T1, T2>(a: Iterable<T1>, b: Iterable<T2>): Iterable<[T1, T2]> {
  const i1 = a[Symbol.iterator]();
  const i2 = b[Symbol.iterator]();

  while (true) {
    const r1 = i1.next();
    const r2 = i2.next();
    if (r1.done || r2.done) {
      return;
    }
    yield [r1.value, r2.value];
  }
}

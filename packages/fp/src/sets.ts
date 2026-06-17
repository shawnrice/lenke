export function* union<T>(a: Iterable<T>, b: Iterable<T>): Iterable<T> {
  const seen = new Set<T>();

  for (const x of a) {
    if (!seen.has(x)) {
      seen.add(x);

      yield x;
    }
  }

  for (const x of b) {
    if (!seen.has(x)) {
      seen.add(x);

      yield x;
    }
  }
}

export function* intersection<T>(a: Iterable<T>, b: Iterable<T>): Iterable<T> {
  const sb = new Set(b);

  for (const x of a) {
    if (sb.has(x)) {
      yield x;
    }
  }
}

export function* difference<T>(a: Iterable<T>, b: Iterable<T>): Iterable<T> {
  const sb = new Set(b);

  for (const x of a) {
    if (!sb.has(x)) {
      yield x;
    }
  }
}

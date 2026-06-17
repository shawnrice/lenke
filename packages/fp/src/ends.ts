export const first = <T>(iterable: Iterable<T>): T | undefined => {
  for (const item of iterable) {
    return item;
  }

  return undefined;
};

export const last = <T>(iterable: Iterable<T>): T | undefined => {
  let seen: T | undefined = undefined;

  for (const item of iterable) {
    seen = item;
  }

  return seen;
};

export function* takeLast<T>(count: number, iterable: Iterable<T>): Iterable<T> {
  if (count <= 0) {
    return;
  }

  const buf: T[] = [];

  for (const item of iterable) {
    buf.push(item);

    if (buf.length > count) {
      buf.shift();
    }
  }

  yield* buf;
}

export function* dropLast<T>(count: number, iterable: Iterable<T>): Iterable<T> {
  if (count <= 0) {
    yield* iterable;

    return;
  }

  const buf: T[] = [];

  for (const item of iterable) {
    buf.push(item);

    if (buf.length > count) {
      yield buf.shift() as T;
    }
  }
}

export function* chunk<T>(size: number, iterable: Iterable<T>): Iterable<readonly T[]> {
  if (size <= 0) {
    return;
  }
  let bucket: T[] = [];
  for (const item of iterable) {
    bucket.push(item);
    if (bucket.length === size) {
      yield bucket;
      bucket = [];
    }
  }
  if (bucket.length) {
    yield bucket;
  }
}

export function* window<T>(size: number, iterable: Iterable<T>): Iterable<readonly T[]> {
  if (size <= 0) {
    return;
  }

  const buffer: T[] = [];
  for (const item of iterable) {
    buffer.push(item);
    if (buffer.length === size) {
      yield buffer.slice();
      buffer.shift();
    }
  }
}

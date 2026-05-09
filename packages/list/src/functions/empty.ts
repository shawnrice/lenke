import { List } from '../List.js';

export function empty<T = never>(): List<T> {
  return new List<T>(function* noop() {}, 0);
}

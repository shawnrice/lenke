import { List } from '../List.js';

export const isList = <T>(x: unknown): x is List<T> => x instanceof List;

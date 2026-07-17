import { describe, expect, test } from 'bun:test';

import { Graph } from './core/index.js';
import { defineNode, type StandardSchemaV1 } from './schema.js';

/** Await a promise expected to reject, returning the thrown error (fails if it resolves). */
const rejection = async (p: Promise<unknown>): Promise<unknown> => {
  try {
    await p;
  } catch (error) {
    return error;
  }

  throw new Error('expected the promise to reject, but it resolved');
};

// A hand-rolled Standard Schema (https://standardschema.dev) — no validation
// library dependency. Anything exposing this `~standard` shape (Zod ≥3.24,
// Valibot, ArkType, …) works identically; this proves the adapter honors the
// spec: it awaits `validate`, stores the OUTPUT (so coercion persists), and
// surfaces issues as a thrown error.
type User = { name: string; age?: number };

const userSchema = (opts: { async?: boolean } = {}): StandardSchemaV1<User, User> => ({
  '~standard': {
    version: 1,
    vendor: 'test',
    validate: (input) => {
      const run = (): { value: User } | { issues: { message: string; path: string[] }[] } => {
        if (typeof input !== 'object' || input === null) {
          return { issues: [{ message: 'expected an object', path: [] }] };
        }

        const o = input as Record<string, unknown>;
        const issues: { message: string; path: string[] }[] = [];

        if (typeof o.name !== 'string') {
          issues.push({ message: 'name must be a string', path: ['name'] });
        }

        if (o.age !== undefined && typeof o.age !== 'number') {
          issues.push({ message: 'age must be a number', path: ['age'] });
        }

        if (issues.length) {
          return { issues };
        }

        // Coerce: trim the name — the stored value is this normalized output.
        const value: User = { name: (o.name as string).trim() };

        if (o.age !== undefined) {
          value.age = o.age as number;
        }

        return { value };
      };

      return opts.async ? Promise.resolve(run()) : run();
    },
  },
});

describe('defineNode: Standard Schema adapter', () => {
  test('create() validates, stores the coerced output, and returns the vertex', async () => {
    const g = new Graph();
    const User = defineNode('User', userSchema());

    const v = await User.create(g, { name: '  ada  ', age: 36 });

    expect(v.labels).toContain('User');
    // The trimmed OUTPUT is persisted, not the raw input.
    expect(v.getProperty<string>('name')).toBe('ada');
    expect(v.getProperty<number>('age')).toBe(36);
    expect(g.vertexCount).toBe(1);
  });

  test('an optional field may be omitted', async () => {
    const g = new Graph();
    const User = defineNode('User', userSchema());

    const v = await User.create(g, { name: 'lin' });

    expect(v.getProperty<string>('name')).toBe('lin');
    expect(v.getProperty('age')).toBeUndefined();
  });

  test('invalid input throws ConstraintViolation and writes NOTHING', async () => {
    const g = new Graph();
    const User = defineNode('User', userSchema());

    const err = await rejection(User.create(g, { age: 5 } as unknown as User));
    expect(String(err)).toMatch(/name must be a string/);
    // The structured issues are attached (not just the joined message string), so a
    // caller can handle failures field-by-field.
    const { details } = err as { details?: { issues?: { message: string; path: string }[] } };
    expect(details?.issues).toEqual([{ message: 'name must be a string', path: 'name' }]);
    // The failed create left the graph untouched — validation is before the write.
    expect(g.vertexCount).toBe(0);
  });

  test('an async schema is awaited', async () => {
    const g = new Graph();
    const User = defineNode('User', userSchema({ async: true }));

    const v = await User.create(g, { name: 'kai' });
    expect(v.getProperty<string>('name')).toBe('kai');

    expect(String(await rejection(User.create(g, { name: 42 } as unknown as User)))).toMatch(
      /name must be a string/,
    );
  });

  test('parse() validates without writing', async () => {
    const g = new Graph();
    const User = defineNode('User', userSchema());

    const value = await User.parse({ name: '  eve  ' });
    expect(value).toEqual({ name: 'eve' });
    expect(g.vertexCount).toBe(0);

    expect(String(await rejection(User.parse({} as unknown as User)))).toMatch(
      /name must be a string/,
    );
  });
});

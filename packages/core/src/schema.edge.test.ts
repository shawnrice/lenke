import { describe, expect, test } from 'bun:test';

import { Graph } from './core/index.js';
import { defineEdge, type StandardSchemaV1 } from './schema.js';

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
// library dependency, mirroring schema.test.ts. Proves the edge adapter honors
// the spec: it awaits `validate`, stores the OUTPUT (so coercion persists), and
// surfaces issues as a thrown error.
type Follows = { since: number; tag?: string };

const followsSchema = (opts: { async?: boolean } = {}): StandardSchemaV1<Follows, Follows> => ({
  '~standard': {
    version: 1,
    vendor: 'test',
    validate: (input) => {
      const run = (): { value: Follows } | { issues: { message: string; path: string[] }[] } => {
        if (typeof input !== 'object' || input === null) {
          return { issues: [{ message: 'expected an object', path: [] }] };
        }

        const o = input as Record<string, unknown>;
        const issues: { message: string; path: string[] }[] = [];

        if (typeof o.since !== 'number') {
          issues.push({ message: 'since must be a number', path: ['since'] });
        }

        if (o.tag !== undefined && typeof o.tag !== 'string') {
          issues.push({ message: 'tag must be a string', path: ['tag'] });
        }

        if (issues.length) {
          return { issues };
        }

        // Coerce: trim the tag — the stored value is this normalized output.
        const value: Follows = { since: o.since as number };

        if (o.tag !== undefined) {
          value.tag = (o.tag as string).trim();
        }

        return { value };
      };

      return opts.async ? Promise.resolve(run()) : run();
    },
  },
});

const twoVertices = () => {
  const g = new Graph();
  const a = g.addVertex({ labels: ['User'], properties: { name: 'ada' } });
  const b = g.addVertex({ labels: ['User'], properties: { name: 'lin' } });

  return { g, a, b };
};

describe('defineEdge: Standard Schema adapter', () => {
  test('create() with Vertex endpoints validates, stores coerced output, returns the edge', async () => {
    const { g, a, b } = twoVertices();
    const Follows = defineEdge('FOLLOWS', followsSchema());

    const e = await Follows.create(g, a, b, { since: 2020, tag: '  close  ' });

    expect(e.labels).toContain('FOLLOWS');
    expect(e.from.id).toBe(a.id);
    expect(e.to.id).toBe(b.id);
    // The trimmed OUTPUT is persisted, not the raw input.
    expect(e.getProperty<number>('since')).toBe(2020);
    expect(e.getProperty<string>('tag')).toBe('close');
    expect(g.edgeCount).toBe(1);
  });

  test('create() accepts bare vertex ids as endpoints (Marcus ergonomic tax)', async () => {
    const { g, a, b } = twoVertices();
    const Follows = defineEdge('FOLLOWS', followsSchema());

    const e = await Follows.create(g, a.id, b.id, { since: 1999 });

    expect(e.from.id).toBe(a.id);
    expect(e.to.id).toBe(b.id);
    expect(e.getProperty<number>('since')).toBe(1999);
    expect(e.getProperty('tag')).toBeUndefined();
  });

  test('an unknown endpoint id throws MissingVertex and writes NOTHING', async () => {
    const { g, a } = twoVertices();
    const Follows = defineEdge('FOLLOWS', followsSchema());

    expect(String(await rejection(Follows.create(g, a.id, 'nope', { since: 1 })))).toMatch(
      /'to' endpoint vertex 'nope'/,
    );
    expect(g.edgeCount).toBe(0);
  });

  test('invalid input throws ConstraintViolation and writes NOTHING', async () => {
    const { g, a, b } = twoVertices();
    const Follows = defineEdge('FOLLOWS', followsSchema());

    expect(
      String(await rejection(Follows.create(g, a, b, { tag: 'x' } as unknown as Follows))),
    ).toMatch(/since must be a number/);
    // The failed create left the graph untouched — validation is before the write.
    expect(g.edgeCount).toBe(0);
  });

  test('an async schema is awaited', async () => {
    const { g, a, b } = twoVertices();
    const Follows = defineEdge('FOLLOWS', followsSchema({ async: true }));

    const e = await Follows.create(g, a, b, { since: 2001 });
    expect(e.getProperty<number>('since')).toBe(2001);

    expect(
      String(await rejection(Follows.create(g, a, b, { since: 'no' } as unknown as Follows))),
    ).toMatch(/since must be a number/);
  });

  test('parse() validates without writing', async () => {
    const { g } = twoVertices();
    const Follows = defineEdge('FOLLOWS', followsSchema());

    const value = await Follows.parse({ since: 2020, tag: '  x  ' });
    expect(value).toEqual({ since: 2020, tag: 'x' });
    expect(g.edgeCount).toBe(0);

    expect(String(await rejection(Follows.parse({} as unknown as Follows)))).toMatch(
      /since must be a number/,
    );
  });

  test('composes with engine edge constraints (createEdgeTypeConstraint)', async () => {
    const { g, a, b } = twoVertices();
    g.createEdgeTypeConstraint('FOLLOWS', 'since', 'number');
    const Follows = defineEdge('FOLLOWS', followsSchema());

    const e = await Follows.create(g, a, b, { since: 2020 });
    expect(e.getProperty<number>('since')).toBe(2020);
    expect(g.edgeCount).toBe(1);
  });
});

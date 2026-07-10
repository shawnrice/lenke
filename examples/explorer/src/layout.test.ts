import { describe, expect, test } from 'bun:test';

import { createLayout, type LayoutEdge } from './layout.ts';

const totalSpeed = (layout: ReturnType<typeof createLayout>): number =>
  [...layout.nodes.values()].reduce((s, n) => s + Math.hypot(n.vx, n.vy), 0);

describe('force layout', () => {
  const ids = ['a', 'b', 'c', 'd', 'e'];
  const edges: LayoutEdge[] = [
    { from: 'a', to: 'b' },
    { from: 'b', to: 'c' },
    { from: 'c', to: 'd' },
    { from: 'd', to: 'e' },
  ];

  test('is deterministic (no RNG) — same seed, same result', () => {
    const run = () => {
      const l = createLayout(ids, edges);

      for (let i = 0; i < 50; i++) {
        l.step();
      }

      return [...l.nodes.values()].map((n) => `${n.x.toFixed(4)},${n.y.toFixed(4)}`);
    };

    expect(run()).toEqual(run());
  });

  test('settles: kinetic energy decays and positions stay finite', () => {
    const l = createLayout(ids, edges);

    for (let i = 0; i < 20; i++) {
      l.step();
    }

    const early = totalSpeed(l);

    for (let i = 0; i < 400; i++) {
      l.step();
    }

    expect(totalSpeed(l)).toBeLessThan(early);

    for (const n of l.nodes.values()) {
      expect(Number.isFinite(n.x)).toBe(true);
      expect(Number.isFinite(n.y)).toBe(true);
    }
  });

  test('edges pull their endpoints near the spring length', () => {
    const l = createLayout(ids, edges);

    for (let i = 0; i < 600; i++) {
      l.step();
    }

    const a = l.nodes.get('a')!;
    const b = l.nodes.get('b')!;

    // adjacent nodes end up roughly a spring-length apart, not flung to opposite
    // sides of the canvas
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(200);
  });

  test('a pinned node does not move', () => {
    const l = createLayout(ids, edges);
    const pinned = l.nodes.get('a')!;
    pinned.pinned = true;
    pinned.x = 100;
    pinned.y = 100;

    for (let i = 0; i < 100; i++) {
      l.step();
    }

    expect(pinned.x).toBe(100);
    expect(pinned.y).toBe(100);
  });
});

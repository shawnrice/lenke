// A tiny force-directed layout — deliberately hand-rolled (no graph-viz library)
// to keep the example dependency-free, mirroring service-map's bare-<table>
// stance. Coulomb-style repulsion between every node, Hooke springs along edges,
// and a gentle pull to the origin; integrated with velocity damping.
//
// Deterministic: nodes seed on a circle with an index-derived jitter (no RNG), so
// the layout is stable and unit-testable. O(n²) per step — fine for the dozens-
// of-nodes graphs an explorer shows; not a large-graph renderer.

export type LayoutNode = {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  pinned: boolean;
};
export type LayoutEdge = { from: string; to: string };

export type LayoutOptions = {
  repulsion?: number;
  spring?: number;
  springLength?: number;
  gravity?: number;
  damping?: number;
  radius?: number;
};

export type Layout = {
  nodes: Map<string, LayoutNode>;
  step: () => void;
};

export const createLayout = (
  ids: readonly string[],
  edges: readonly LayoutEdge[],
  options: LayoutOptions = {},
): Layout => {
  const repulsion = options.repulsion ?? 9000;
  const spring = options.spring ?? 0.02;
  const springLength = options.springLength ?? 90;
  const gravity = options.gravity ?? 0.03;
  const damping = options.damping ?? 0.85;
  const radius = options.radius ?? 220;

  const nodes = new Map<string, LayoutNode>();

  ids.forEach((id, i) => {
    const angle = (i / Math.max(1, ids.length)) * Math.PI * 2;
    // Index-derived jitter breaks the perfectly-symmetric ring so repulsion has
    // a direction to resolve — without a random seed.
    const jitter = ((i * 53) % 31) - 15;

    nodes.set(id, {
      id,
      x: Math.cos(angle) * radius + jitter,
      y: Math.sin(angle) * radius - jitter,
      vx: 0,
      vy: 0,
      pinned: false,
    });
  });

  const step = (): void => {
    const list = [...nodes.values()];

    for (let i = 0; i < list.length; i++) {
      const a = list[i];

      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const dist = Math.hypot(dx, dy) || 0.01;
        const force = repulsion / (dist * dist);
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;

        a.vx += fx;
        a.vy += fy;
        b.vx -= fx;
        b.vy -= fy;
      }
    }

    for (const edge of edges) {
      const a = nodes.get(edge.from);
      const b = nodes.get(edge.to);

      if (!a || !b) {
        continue;
      }

      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.hypot(dx, dy) || 0.01;
      const force = (dist - springLength) * spring;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;

      a.vx += fx;
      a.vy += fy;
      b.vx -= fx;
      b.vy -= fy;
    }

    for (const node of list) {
      if (node.pinned) {
        node.vx = 0;
        node.vy = 0;

        continue;
      }

      node.vx = (node.vx - node.x * gravity) * damping;
      node.vy = (node.vy - node.y * gravity) * damping;
      node.x += node.vx;
      node.y += node.vy;
    }
  };

  return { nodes, step };
};

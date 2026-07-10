// The force-directed view of a cluster's call graph — the same hand-rolled
// layout the explorer example uses, here wired to the SAME live query data as
// the table. So a status flip (or its blast radius) repaints the graph in real
// time: a `down` service turns red, everything transitively depending on it
// turns amber, and the failure visibly spreads along the edges.
import {
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useReducer,
  useRef,
} from 'react';

import { createLayout } from './layout.ts';

export type GraphNode = { sid: string; name: string; tier: string; status: string };
export type GraphEdge = { from: string; to: string };

const TIER_COLOR: Record<string, string> = {
  edge: '#38bdf8',
  api: '#a78bfa',
  core: '#34d399',
  data: '#fbbf24',
};

const nodeFill = (n: GraphNode, impacted: boolean): string => {
  if (n.status === 'down') {
    return '#ef4444';
  }

  if (impacted) {
    return '#f59e0b';
  }

  return TIER_COLOR[n.tier] ?? '#94a3b8';
};

const toSvg = (svg: SVGSVGElement, e: ReactPointerEvent): { x: number; y: number } => {
  const ctm = svg.getScreenCTM();

  if (!ctm) {
    return { x: 0, y: 0 };
  }

  const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());

  return { x: p.x, y: p.y };
};

export const ServiceGraph = ({
  nodes,
  edges,
  impacted,
  selected,
  onSelect,
}: {
  nodes: readonly GraphNode[];
  edges: readonly GraphEdge[];
  impacted: ReadonlySet<string>;
  selected: string | null;
  onSelect: (sid: string | null) => void;
}): React.JSX.Element => {
  const byId = useMemo(() => new Map(nodes.map((n) => [n.sid, n])), [nodes]);

  // Rebuild the layout only when the topology (which nodes/edges) changes — NOT
  // on every status flip, so the simulation isn't reset when a node turns red.
  const topology = `${nodes.map((n) => n.sid).join(',')}|${edges.map((e) => `${e.from}>${e.to}`).join(',')}`;
  const layout = useMemo(
    () =>
      createLayout(
        nodes.map((n) => n.sid),
        edges as GraphEdge[],
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the topology signature, not the array identities
    [topology],
  );

  const [, frame] = useReducer((x: number) => x + 1, 0);
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<string | null>(null);
  const moved = useRef(false);

  useEffect(() => {
    let raf = 0;

    const tick = (): void => {
      layout.step();
      layout.step();
      frame();
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);

    return () => cancelAnimationFrame(raf);
  }, [layout]);

  const onDown =
    (sid: string) =>
    (e: ReactPointerEvent): void => {
      e.stopPropagation();
      drag.current = sid;
      moved.current = false;

      const p = layout.nodes.get(sid);

      if (p) {
        p.pinned = true;
      }

      svgRef.current?.setPointerCapture(e.pointerId);
    };

  const onMove = (e: ReactPointerEvent): void => {
    if (!drag.current || !svgRef.current) {
      return;
    }

    const { x, y } = toSvg(svgRef.current, e);
    const p = layout.nodes.get(drag.current);

    if (p) {
      p.x = x;
      p.y = y;
    }

    moved.current = true;
  };

  const onUp = (e: ReactPointerEvent): void => {
    if (!drag.current) {
      return;
    }

    const p = layout.nodes.get(drag.current);

    if (p) {
      p.pinned = false;
    }

    if (!moved.current) {
      onSelect(drag.current);
    }

    svgRef.current?.releasePointerCapture(e.pointerId);
    drag.current = null;
  };

  return (
    <svg
      ref={svgRef}
      viewBox="-320 -300 640 600"
      style={{
        width: '100%',
        height: 420,
        background: '#0d0f14',
        border: '1px solid #2a2e39',
        borderRadius: 6,
        touchAction: 'none',
      }}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerDown={() => onSelect(null)}
    >
      <defs>
        <marker
          id="svc-arrow"
          viewBox="0 0 10 10"
          refX="16"
          refY="5"
          markerWidth="5"
          markerHeight="5"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#3a4152" />
        </marker>
      </defs>

      {edges.map((e) => {
        const a = layout.nodes.get(e.from);
        const b = layout.nodes.get(e.to);

        if (!a || !b) {
          return null;
        }

        // An edge into a down service, or between two impacted services, traces
        // the failure — draw it hot.
        const hot =
          byId.get(e.to)?.status === 'down' || (impacted.has(e.from) && impacted.has(e.to));

        return (
          <line
            key={`${e.from}>${e.to}`}
            x1={a.x}
            y1={a.y}
            x2={b.x}
            y2={b.y}
            stroke={hot ? '#f59e0b' : '#3a4152'}
            strokeWidth={hot ? 1.6 : 1}
            opacity={hot ? 0.9 : 0.5}
            markerEnd="url(#svc-arrow)"
          />
        );
      })}

      {nodes.map((n) => {
        const p = layout.nodes.get(n.sid);

        if (!p) {
          return null;
        }

        return (
          <g
            key={n.sid}
            transform={`translate(${p.x} ${p.y})`}
            onPointerDown={onDown(n.sid)}
            style={{ cursor: 'grab' }}
          >
            <circle
              r={9}
              fill={nodeFill(n, impacted.has(n.sid))}
              stroke={selected === n.sid ? '#fff' : '#0d0f14'}
              strokeWidth={selected === n.sid ? 2.5 : 1}
            />
            <text x={12} y={3} fill="#c9d1e0" fontSize={9} style={{ pointerEvents: 'none' }}>
              {n.name}
            </text>
          </g>
        );
      })}
    </svg>
  );
};

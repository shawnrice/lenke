import { Graph } from '@lenke/core';
import { createTestTinkerGraph } from '@lenke/gremlin';
import { deserialize, type FormatName } from '@lenke/serialization';
import {
  type PointerEvent as ReactPointerEvent,
  StrictMode,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import { createRoot } from 'react-dom/client';

import { createLayout } from './layout.ts';
import { type GNode, highlightFromQuery, toModel } from './model.ts';

const FORMAT_BY_EXT: Record<string, FormatName> = {
  ndjson: 'ndjson',
  jsonl: 'ndjson',
  csv: 'csv',
  graphson: 'graphson',
};

// A stable per-label color from a cheap string hash.
const colorFor = (label: string | undefined): string => {
  if (!label) {
    return 'hsl(220 8% 55%)';
  }

  let h = 0;

  for (let i = 0; i < label.length; i++) {
    h = (h * 31 + label.charCodeAt(i)) >>> 0;
  }

  return `hsl(${h % 360} 60% 58%)`;
};

const nodeName = (node: GNode): string => {
  const { name } = node.properties;

  return typeof name === 'string' ? name : `#${node.id}`;
};

// A property value → display string (null is a stored value; lists/objects JSON).
const showValue = (value: unknown): string => {
  if (value === null) {
    return 'null';
  }

  if (typeof value === 'object') {
    return JSON.stringify(value);
  }

  return String(value);
};

const toSvgCoords = (svg: SVGSVGElement, event: ReactPointerEvent): { x: number; y: number } => {
  const ctm = svg.getScreenCTM();

  if (!ctm) {
    return { x: 0, y: 0 };
  }

  const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(ctm.inverse());

  return { x: point.x, y: point.y };
};

const Explorer = ({ initialGraph }: { initialGraph: Graph }): React.JSX.Element => {
  const [graph, setGraph] = useState(initialGraph);
  const model = useMemo(() => toModel(graph), [graph]);
  const layout = useMemo(
    () =>
      createLayout(
        model.nodes.map((n) => n.id),
        model.edges.map((e) => ({ from: e.from, to: e.to })),
      ),
    [model],
  );

  const [, frame] = useReducer((x: number) => x + 1, 0);
  const [selected, setSelected] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<Set<string> | null>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);

  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<string | null>(null);
  const moved = useRef(false);

  // Run the simulation on every animation frame.
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
  }, [layout, frame]);

  // A new graph resets the view.
  useEffect(() => {
    setSelected(null);
    setHighlight(null);
    setError(null);
  }, [graph]);

  const runQuery = (): void => {
    if (!text.trim()) {
      setHighlight(null);
      setError(null);

      return;
    }

    try {
      setHighlight(highlightFromQuery(graph, text));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setHighlight(null);
    }
  };

  const loadFile = async (file: File): Promise<void> => {
    const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
    const format = FORMAT_BY_EXT[ext];

    if (!format) {
      setError(`Can't infer a codec from ".${ext}" — try .ndjson, .csv, or .graphson.`);

      return;
    }

    try {
      setGraph(deserialize(await file.text(), format, new Graph()));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const onNodeDown =
    (id: string) =>
    (event: ReactPointerEvent): void => {
      event.stopPropagation();
      drag.current = id;
      moved.current = false;

      const node = layout.nodes.get(id);

      if (node) {
        node.pinned = true;
      }

      svgRef.current?.setPointerCapture(event.pointerId);
    };

  const onPointerMove = (event: ReactPointerEvent): void => {
    if (!drag.current || !svgRef.current) {
      return;
    }

    const { x, y } = toSvgCoords(svgRef.current, event);
    const node = layout.nodes.get(drag.current);

    if (node) {
      node.x = x;
      node.y = y;
    }

    moved.current = true;
  };

  const onPointerUp = (event: ReactPointerEvent): void => {
    if (!drag.current) {
      return;
    }

    const node = layout.nodes.get(drag.current);

    if (node) {
      node.pinned = false;
    }

    if (!moved.current) {
      setSelected(drag.current);
    }

    svgRef.current?.releasePointerCapture(event.pointerId);
    drag.current = null;
  };

  const dimmed = (id: string): boolean => highlight !== null && !highlight.has(id);
  const selectedNode = model.nodes.find((n) => n.id === selected) ?? null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <header
        style={{
          padding: '10px 14px',
          borderBottom: '1px solid #2a2e39',
          display: 'flex',
          gap: 12,
          alignItems: 'center',
          flexWrap: 'wrap',
        }}
      >
        <strong>lenke · graph explorer</strong>
        <span style={{ color: '#8b93a7' }}>
          {model.nodes.length} vertices · {model.edges.length} edges
        </span>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && runQuery()}
          placeholder="GQL — e.g. MATCH (p:PERSON) WHERE p.age > 30 RETURN p"
          spellCheck={false}
          style={{
            flex: 1,
            minWidth: 280,
            padding: '6px 10px',
            background: '#0d0f14',
            color: '#e6e6e6',
            border: '1px solid #2a2e39',
            borderRadius: 6,
            font: 'inherit',
          }}
        />
        <button type="button" onClick={runQuery}>
          Highlight
        </button>
        <button
          type="button"
          onClick={() => {
            setText('');
            setHighlight(null);
          }}
        >
          Clear
        </button>
        <button type="button" onClick={() => setGraph(createTestTinkerGraph())}>
          Sample
        </button>
        <label style={{ cursor: 'pointer', color: '#8b93a7' }}>
          Load file…
          <input
            type="file"
            accept=".ndjson,.jsonl,.csv,.graphson"
            style={{ display: 'none' }}
            onChange={(e) => {
              const file = e.target.files?.[0];

              if (file) {
                void loadFile(file);
              }
            }}
          />
        </label>
      </header>

      {error && (
        <div
          style={{
            padding: '6px 14px',
            background: '#3a1a1a',
            color: '#ff9d9d',
            fontFamily: 'monospace',
          }}
        >
          {error}
        </div>
      )}

      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <svg
          ref={svgRef}
          viewBox="-360 -360 720 720"
          style={{ flex: 1, background: '#0d0f14', touchAction: 'none' }}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerDown={() => setSelected(null)}
        >
          <defs>
            <marker
              id="arrow"
              viewBox="0 0 10 10"
              refX="18"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="#3a4152" />
            </marker>
          </defs>

          {model.edges.map((edge) => {
            const a = layout.nodes.get(edge.from);
            const b = layout.nodes.get(edge.to);

            if (!a || !b) {
              return null;
            }

            const faded = dimmed(edge.from) || dimmed(edge.to);

            return (
              <line
                key={edge.id}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke="#3a4152"
                strokeWidth={1.5}
                opacity={faded ? 0.1 : 0.7}
                markerEnd="url(#arrow)"
              />
            );
          })}

          {model.nodes.map((node) => {
            const p = layout.nodes.get(node.id);

            if (!p) {
              return null;
            }

            const faded = dimmed(node.id);

            return (
              <g
                key={node.id}
                transform={`translate(${p.x} ${p.y})`}
                onPointerDown={onNodeDown(node.id)}
                style={{ cursor: 'grab' }}
                opacity={faded ? 0.2 : 1}
              >
                <circle
                  r={14}
                  fill={colorFor(node.labels[0])}
                  stroke={selected === node.id ? '#fff' : '#0d0f14'}
                  strokeWidth={selected === node.id ? 3 : 1.5}
                />
                <text x={18} y={4} fill="#c9d1e0" fontSize={11} style={{ pointerEvents: 'none' }}>
                  {nodeName(node)}
                </text>
              </g>
            );
          })}
        </svg>

        {selectedNode && (
          <aside
            style={{ width: 260, borderLeft: '1px solid #2a2e39', padding: 14, overflow: 'auto' }}
          >
            <div style={{ color: '#8b93a7' }}>vertex #{selectedNode.id}</div>
            <div style={{ margin: '6px 0' }}>
              {selectedNode.labels.map((l) => (
                <span
                  key={l}
                  style={{
                    background: colorFor(l),
                    color: '#0d0f14',
                    borderRadius: 4,
                    padding: '1px 6px',
                    marginRight: 4,
                    fontSize: 12,
                  }}
                >
                  {l}
                </span>
              ))}
            </div>
            <table style={{ borderCollapse: 'collapse', width: '100%' }}>
              <tbody>
                {Object.entries(selectedNode.properties).map(([k, v]) => (
                  <tr key={k}>
                    <td style={{ color: '#8b93a7', paddingRight: 8, verticalAlign: 'top' }}>{k}</td>
                    <td style={{ fontFamily: 'monospace' }}>{showValue(v)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </aside>
        )}
      </div>
    </div>
  );
};

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <Explorer initialGraph={createTestTinkerGraph()} />
  </StrictMode>,
);

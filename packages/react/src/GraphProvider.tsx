import type { Edge, Graph, Vertex } from '@pl-graph/core';
import * as React from 'react';

import { GraphContext } from './GraphContext.js';

type GraphProviderProps<V = Vertex, E = Edge> = { graph: Graph<V, E>; children: React.ReactNode };

export const GraphProvider = <V extends Vertex = Vertex, E extends Edge = Edge>(
  props: GraphProviderProps<V, E>,
): React.JSX.Element => {
  const { children, graph } = props;

  const value = React.useMemo(() => ({ graph }), [graph]);

  return <GraphContext.Provider value={value}>{children}</GraphContext.Provider>;
};

GraphProvider.displayName = 'GraphProvider';

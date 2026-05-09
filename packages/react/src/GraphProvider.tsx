import * as React from 'react';

import { GraphContext } from './GraphContext.js';

import type { Edge, Graph, Vertex } from '@pl-graph/core';

type GraphProviderProps<V = Vertex, E = Edge> = { graph: Graph<V, E>; children: React.ReactNode };

export const GraphProvider = <V extends Vertex = Vertex, E extends Edge = Edge>(
  props: GraphProviderProps<V, E>,
): JSX.Element => {
  const { children, graph } = props;

  const value = React.useMemo(() => ({ graph }), [graph]);

  return <GraphContext.Provider value={value}>{children}</GraphContext.Provider>;
};

GraphProvider.displayName = 'GraphProvider';

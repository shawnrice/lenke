import type { Graph } from '@pl-graph/core';
import * as React from 'react';

import { GraphContext } from './GraphContext.js';

type GraphProviderProps = { graph: Graph; children: React.ReactNode };

export const GraphProvider = (props: GraphProviderProps): React.JSX.Element => {
  const { children, graph } = props;

  const value = React.useMemo(() => ({ graph }), [graph]);

  return <GraphContext.Provider value={value}>{children}</GraphContext.Provider>;
};

GraphProvider.displayName = 'GraphProvider';

import React from 'react';

import type { NullaryFn } from '@pl-graph/fp';

import { useGraphContext } from './GraphContext.js';
import { useForceUpdate } from './useForceUpdate.js';

/**
 * Subscribes to the graph
 *
 * This will force a re-render whenever the graph creates a new snapshot
 */
export const useGraphSubscription = (listener?: NullaryFn): void => {
  const { graph } = useGraphContext();
  const update = useForceUpdate();

  React.useEffect(() => graph.subscribe(listener ?? update), [graph, listener, update]);
};

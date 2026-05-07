import { useEffect } from 'react';

import { useGraphContext } from './GraphContext.js';

/**
 * Subscribe a side-effect callback to graph changes. The listener fires once
 * per graph mutation (after `enableEvents` / `disableEvents` rules are
 * applied). Returns nothing — for derived values that should drive renders,
 * use `useGraphSelector` instead.
 */
export const useGraphSubscription = (listener: () => void): void => {
  const { graph } = useGraphContext();

  useEffect(() => graph.subscribe(listener), [graph, listener]);
};

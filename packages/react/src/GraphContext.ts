import { Graph } from '@lenke/core';
import * as React from 'react';

export type GraphState = { graph: Graph };

const defaultGraph = new Graph();

export const GraphContext = React.createContext<GraphState>({ graph: defaultGraph });
GraphContext.displayName = 'GraphContext';

export const useGraphContext = (): GraphState => React.useContext(GraphContext);

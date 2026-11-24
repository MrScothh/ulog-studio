import { createContext, useContext } from 'react';
import type { ModeSegment } from '../core/types';
import type { ChartTheme } from './theme';

export interface ChartCtx {
  logId: string;
  duration: number;
  modes: ModeSegment[];
  paramChanges: { t: number; name: string; value: number }[];
  theme: ChartTheme;
  showParamChanges: boolean;
  /** report capture: charts register a snapshot function */
  register?: (id: string, title: string, snap: () => string | undefined) => () => void;
  staticWidth?: number;
}

export const ChartContext = createContext<ChartCtx | null>(null);
export function useChartCtx(): ChartCtx {
  const c = useContext(ChartContext);
  if (!c) throw new Error('ChartContext missing');
  return c;
}

/** Plot/page specifications produced by the analysis engine (worker) and rendered by the UI. */
import type { Spectrogram } from './dsp';

export type Num = Float64Array | Float32Array | number[];

export interface TimeSeries {
  label: string;
  t: Num;
  y: Num;
  color?: number; // categorical slot index (0..7) or -1 for neutral gray
  step?: boolean;
  dash?: boolean;
  points?: boolean; // draw markers only
  width?: number;
}

export interface Mark { x: number; label: string; color?: number }

export interface TimePlotSpec {
  kind: 'time';
  id: string;
  title: string;
  yLabel?: string;
  series: TimeSeries[];
  yRange?: [number, number];
  height?: number;
  note?: string;
  noModes?: boolean;
}

export interface FreqSeries { label: string; y: Num; color?: number; dash?: boolean; width?: number; points?: boolean }
export interface FreqPlotSpec {
  kind: 'freq';
  id: string;
  title: string;
  xLabel?: string;
  yLabel?: string;
  x: Num;
  series: FreqSeries[];
  logX?: boolean;
  logY?: boolean;
  xRange?: [number, number];
  yRange?: [number, number];
  marks?: Mark[];
  hmarks?: { y: number; label: string }[];
  bands?: { x0: number; x1: number; label: string; color?: number }[];
  height?: number;
  note?: string;
}

export interface XYSeries { label: string; x: Num; y: Num; t?: Num; hdg?: Num; color?: number; points?: boolean; dash?: boolean }
export interface XYPlotSpec {
  kind: 'xy';
  id: string;
  title: string;
  xLabel?: string;
  yLabel?: string;
  series: XYSeries[];
  equal?: boolean;
  height?: number;
  note?: string;
}

export interface SpectrogramSpec {
  kind: 'spectrogram';
  id: string;
  title: string;
  yLabel?: string;
  sg: Spectrogram;
  height?: number;
  note?: string;
  marks?: { y: number; label: string }[];
}

export interface TableSpec {
  kind: 'table';
  id: string;
  title: string;
  columns: string[];
  rows: (string | number | null)[][];
  rowTone?: (Tone | undefined)[];
  note?: string;
  maxHeight?: number;
  searchable?: boolean;
}

export interface KVSpec { kind: 'kv'; id: string; title: string; items: [string, string][]; note?: string }

export type Tone = 'good' | 'warning' | 'danger' | 'info' | 'neutral';
export interface Finding { tone: Tone; title: string; detail?: string }
export interface FindingsSpec { kind: 'findings'; id: string; title: string; items: Finding[] }

export interface TextSpec { kind: 'text'; id: string; title?: string; text: string; mono?: boolean; tone?: Tone }

export interface MapSpec {
  kind: 'map';
  id: string;
  title: string;
  lat: Num;
  lon: Num;
  t: Num;
  /** height above home / takeoff [m], same samples as lat/lon */
  alt?: Num;
  /** heading [deg, 0 = north], same samples */
  hdg?: Num;
  home?: [number, number];
  segments: { i0: number; i1: number; mode: number }[];
}

export interface BarSpec { kind: 'bars'; id: string; title: string; categories: string[]; values: number[]; unit?: string; note?: string; signed?: boolean }

/** Flight replay: time base and the values shown while playing (from vehicle_local_position). */
export interface ReplaySpec {
  kind: 'replay';
  id: string;
  t0: number;
  t1: number;
  start: number; // takeoff (or log start)
  t: Num;
  height: Num; // above the local origin [m]
  speed: Num; // horizontal ground speed [m/s]
  vz: Num; // climb rate [m/s], positive up
  hdg: Num; // [deg]
}

/** Signal chain drawn as lanes of boxes joined by arrows (e.g. the gyro filter chain). */
export interface FlowStep { title: string; sub?: string; kind?: 'source' | 'filter' | 'sink' | 'off' }
export interface FlowSpec { kind: 'flow'; id: string; title: string; lanes: { label: string; steps: FlowStep[] }[]; note?: string }

export interface StatSpec { kind: 'stats'; id: string; items: { label: string; value: string; sub?: string; tone?: Tone }[] }

export type PlotSpec = TimePlotSpec | FreqPlotSpec | XYPlotSpec | SpectrogramSpec | TableSpec | KVSpec | FindingsSpec | TextSpec | MapSpec | StatSpec | BarSpec | ReplaySpec | FlowSpec;

export interface Section { id: string; title: string; description?: string; items: PlotSpec[]; /** start collapsed (advanced details) */ collapsed?: boolean }
export interface PageSpec { id: string; sections: Section[] }

export interface ModeSegment { t0: number; t1: number; mode: number; name: string; color: string }

export interface TimelineAlert { t: number; severity: 'danger' | 'warning' | 'info'; kind: 'event' | 'message' | 'failsafe' | 'dropout' | 'param' | 'takeoff' | 'landing'; text: string; detail?: string }

export interface LogSummary {
  id: string;
  fileName: string;
  sizeBytes: number;
  durationS: number;
  startTimestamp: number;
  utcStart?: number; // ms epoch
  hw?: string;
  sw?: string;
  swVersion?: string;
  vehicleName?: string;
  airframe?: string;
  modes: ModeSegment[];
  armed: [number, number][];
  airborne: [number, number][];
  topicCount: number;
  warnings: string[];
  dropouts: { t: number; durationMs: number }[];
  paramChanges: { t: number; name: string; value: number }[];
  hasFifoGyro: boolean;
  hasFifoAccel: boolean;
  isSupportedVersion: boolean;
  alerts: TimelineAlert[];
}

export interface TopicField { topic: string; field: string }

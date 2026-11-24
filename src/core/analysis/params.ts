/** Parameter tables & diffs (log vs log, log vs QGroundControl .params files). */
import type { ULog } from '../ulog';
import { PARAM_META } from '../px4';

export interface ParamSet { name: string; values: Map<string, number>; source: 'log' | 'params-file' }

/** Parse a QGroundControl .params file (tab separated: vehicle, component, name, value, type). */
export function parseQgcParams(text: string, name: string): ParamSet {
  const values = new Map<string, number>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\t|\s+/);
    if (parts.length >= 4) {
      const v = Number(parts[3]);
      if (!Number.isNaN(v)) values.set(parts[2], v);
    } else if (parts.length === 2) {
      const v = Number(parts[1]);
      if (!Number.isNaN(v)) values.set(parts[0], v);
    }
  }
  return { name, values, source: 'params-file' };
}

export function fmtParam(name: string, v: number | undefined): string {
  if (v === undefined) return '—';
  const m = PARAM_META[name];
  if (m?.t === 'INT32' || Number.isInteger(v)) {
    const label = m?.v?.[String(v)];
    return label ? `${v} (${label})` : String(v);
  }
  const dec = m?.dec;
  if (dec !== undefined) return v.toFixed(Math.max(dec, sigDigits(v)));
  return String(+v.toPrecision(7));
}
function sigDigits(v: number): number {
  const s = String(+v.toPrecision(7));
  const i = s.indexOf('.');
  return i < 0 ? 0 : Math.min(6, s.length - i - 1);
}

const eq = (a: number, b: number) => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));

export interface DiffRow { name: string; values: (number | undefined)[]; group: string; desc: string }

export function diffParams(sets: ParamSet[], opts: { includeMissing?: boolean; ignorePrefixes?: string[] } = {}): DiffRow[] {
  const names = new Set<string>();
  for (const s of sets) for (const k of s.values.keys()) names.add(k);
  const ign = opts.ignorePrefixes ?? [];
  const out: DiffRow[] = [];
  for (const n of [...names].sort()) {
    if (ign.some((p) => n.startsWith(p))) continue;
    const vals = sets.map((s) => s.values.get(n));
    const present = vals.filter((v): v is number => v !== undefined);
    const missing = present.length < vals.length;
    if (missing && !opts.includeMissing) continue;
    if (!missing && present.every((v) => eq(v, present[0]))) continue;
    out.push({ name: n, values: vals, group: PARAM_META[n]?.g ?? '', desc: PARAM_META[n]?.s ?? '' });
  }
  return out;
}

/** Non-default parameters (Flight Review semantics: defaults from the log's 'Q' messages, fallback to bundled metadata). */
export function nonDefaultParams(log: ULog): { name: string; value: number; def?: number; frameDef?: number; min?: number; max?: number; desc: string; notFrameDefault: boolean }[] {
  const out = [];
  for (const [name, value] of [...log.params.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (name.startsWith('RC') || name.startsWith('CAL_')) continue;
    const meta = PARAM_META[name];
    const ld = log.defaultParams.get(name);
    const sys = ld?.system ?? meta?.d;
    const frame = ld?.airframe ?? sys;
    if (sys !== undefined && eq(sys, value) && (frame === undefined || eq(frame, value))) continue;
    if (sys === undefined && !meta) {
      out.push({ name, value, desc: '(unknown)', notFrameDefault: true });
      continue;
    }
    out.push({ name, value, def: sys, frameDef: frame, min: meta?.min, max: meta?.max, desc: meta?.s ?? '', notFrameDefault: frame === undefined || !eq(frame, value) });
  }
  return out.filter((r) => r.def === undefined || !eq(r.def, r.value) || r.notFrameDefault);
}

export function logParamSet(log: ULog, name: string): ParamSet {
  return { name, values: new Map(log.params), source: 'log' };
}

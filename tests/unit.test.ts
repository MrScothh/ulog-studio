/** Unit tests that need no flight logs: a synthetic ULog file and DSP sanity checks. */
import { describe, it, expect } from 'vitest';
import { ULog } from '../src/core/ulog';
import { welch, peakIn, px4Notch, lowpass2, biquadResponse, cabs, carg, filtfilt, butterworth, alphaLpf, applyResponse, lfilter } from '../src/core/dsp';
import { applyChain, chainResponse, FilterConfig } from '../src/core/analysis/filters';
import { loopAt } from '../src/core/analysis/plantid';
import { EventParser } from '../src/core/events';
import { parseQgcParams, diffParams } from '../src/core/analysis/params';

class W {
  parts: number[] = [];
  u8(v: number) { this.parts.push(v & 255); }
  u16(v: number) { this.u8(v); this.u8(v >> 8); }
  u32(v: number) { for (let i = 0; i < 4; i++) this.u8(v >>> (8 * i)); }
  u64(v: number) { this.u32(v % 4294967296); this.u32(Math.floor(v / 4294967296)); }
  f32(v: number) { const b = new Uint8Array(new Float32Array([v]).buffer); b.forEach((x) => this.u8(x)); }
  str(s: string) { for (const c of new TextEncoder().encode(s)) this.u8(c); }
  msg(type: string, body: (w: W) => void) { const w = new W(); body(w); this.u16(w.parts.length); this.u8(type.charCodeAt(0)); this.parts.push(...w.parts); }
  bytes() { return new Uint8Array(this.parts); }
}

function synthLog(): Uint8Array {
  const w = new W();
  [0x55, 0x4c, 0x6f, 0x67, 0x01, 0x12, 0x35].forEach((b) => w.u8(b));
  w.u8(1); w.u64(1_000_000);
  w.msg('B', (b) => { for (let i = 0; i < 40; i++) b.u8(0); });
  w.msg('I', (b) => { const k = 'char[9] ver_hw'; b.u8(k.length); b.str(k); b.str('PX4_TEST\0'); });
  w.msg('F', (b) => b.str('vec:float x;float y;'));
  w.msg('F', (b) => b.str('test_topic:uint64_t timestamp;float a;vec[2] v;uint8_t flags;uint8_t[3] _padding0;'));
  w.msg('P', (b) => { const k = 'float MC_ROLLRATE_P'; b.u8(k.length); b.str(k); b.f32(0.15); });
  w.msg('A', (b) => { b.u8(0); b.u16(7); b.str('test_topic'); });
  for (let i = 0; i < 5; i++) {
    w.msg('D', (b) => { b.u16(7); b.u64(1_000_000 + i * 10_000); b.f32(i * 0.5); b.f32(1); b.f32(2); b.f32(3); b.f32(4); b.u8(i); });
  }
  w.msg('L', (b) => { b.u8('6'.charCodeAt(0)); b.u64(1_020_000); b.str('hello'); });
  w.msg('O', (b) => b.u16(42));
  w.msg('X', (b) => b.u8(0)); // garbage type -> resync
  return w.bytes();
}

describe('ULog parser', () => {
  it('decodes formats, nested arrays, params, messages and dropouts', () => {
    const log = new ULog(synthLog());
    expect(log.infoString('ver_hw')).toBe('PX4_TEST');
    expect(log.params.get('MC_ROLLRATE_P')).toBe(0.15);
    const d = log.topic('test_topic')!;
    expect(d.count).toBe(5);
    expect(Array.from(d.cols['a'])).toEqual([0, 0.5, 1, 1.5, 2]);
    expect(d.cols['v[1].y'][2]).toBe(4);
    expect(d.cols['flags'][4]).toBe(4);
    expect(d.t[1]).toBeCloseTo(0.01, 9);
    expect(log.logs[0]).toMatchObject({ level: 6, message: 'hello' });
    expect(log.dropouts[0].durationMs).toBe(42);
    expect(log.corruptBytes).toBeGreaterThan(0);
  });
});

describe('DSP', () => {
  it('Welch PSD finds a 45 Hz tone', () => {
    const fs = 1000;
    const x = Float64Array.from({ length: 8000 }, (_, i) => Math.sin((2 * Math.PI * 45 * i) / fs) + 0.01 * Math.sin(i));
    expect(peakIn(welch(x, fs, 1024), 20, 200).f).toBeCloseTo(45, 0);
  });
  it('PX4 notch rejects its centre and the LPF is -3 dB at cutoff', () => {
    expect(cabs(biquadResponse(px4Notch(50, 20, 2000), 50, 2000))).toBeLessThan(1e-6);
    expect(20 * Math.log10(cabs(biquadResponse(lowpass2(40, 2000), 40, 2000)))).toBeCloseTo(-3.01, 1);
  });
  it('filtfilt keeps phase (no lag on a slow sine)', () => {
    const fs = 500;
    const x = Float64Array.from({ length: 2000 }, (_, i) => Math.sin((2 * Math.PI * 2 * i) / fs));
    const y = filtfilt(butterworth(4, 30, fs), x);
    expect(Math.abs(y[1000] - x[1000])).toBeLessThan(0.01);
  });
});

describe('PX4 gyro filter chain model', () => {
  const cfg: FilterConfig = { fs: 2000, ctrlRate: 667, notches: [{ f: 42, bw: 20 }, { f: 0, bw: 20 }], lpf: 40, dlpf: 25 };
  /** amplitude and phase (deg) of y at f, by projection over the second half of the signal */
  const tone = (y: ArrayLike<number>, f: number, fs: number) => {
    let c = 0, s = 0;
    const n0 = Math.floor(y.length / 2);
    for (let i = n0; i < y.length; i++) { const w = (2 * Math.PI * f * i) / fs; c += y[i] * Math.cos(w); s += y[i] * Math.sin(w); }
    const n = y.length - n0;
    return { amp: (2 * Math.hypot(c, s)) / n, ph: (Math.atan2(c, s) * 180) / Math.PI };
  };
  it('the time-domain chain matches its frequency response on the rate and D paths', () => {
    const f = 10;
    const x = Float64Array.from({ length: 8000 }, (_, i) => Math.sin((2 * Math.PI * f * i) / cfg.fs));
    const { vel, acc } = applyChain(cfg, x);
    const r = chainResponse(cfg, [f]);
    const v = tone(vel, f, cfg.fs), a = tone(acc, f, cfg.fs);
    expect(v.amp).toBeCloseTo(cabs(r.p[0]), 3);
    expect(v.ph).toBeCloseTo((carg(r.p[0]) * 180) / Math.PI, 1);
    // acc = d/dt of the filtered rate, then the D low-pass: |jω·H_d|, phase 90° + arg H_d
    expect(a.amp / (2 * Math.PI * f)).toBeCloseTo(cabs(r.d[0]), 3);
    expect(a.ph - 90).toBeCloseTo((carg(r.d[0]) * 180) / Math.PI, 1);
    // the D path carries the rate-path filters plus its own: more lag
    expect(carg(r.d[0])).toBeLessThan(carg(r.p[0]));
  });
  it('the D-term low-pass is first order (PX4 AlphaFilter)', () => {
    const q = alphaLpf(25, 2000)!;
    expect(20 * Math.log10(cabs(biquadResponse(q, 25, 2000)))).toBeCloseTo(-3, 0);
    expect(20 * Math.log10(cabs(biquadResponse(q, 250, 2000)))).toBeGreaterThan(-21);
    expect(alphaLpf(0, 2000)).toBeUndefined();
    expect(alphaLpf(1200, 2000)).toBeUndefined();
  });
  it('FFT filtering by a response equals direct filtering', () => {
    const fs = 500, q = lowpass2(30, fs);
    const x = Float64Array.from({ length: 3000 }, (_, i) => Math.sin(i * 0.37) + Math.cos(i * 0.011) * ((i * 7919) % 13) / 13);
    const a = applyResponse(x, fs, (f) => Array.from(f, (v) => biquadResponse(q, v, fs)));
    const b = lfilter(q, x, false);
    let err = 0;
    for (let i = 0; i < x.length; i++) err = Math.max(err, Math.abs(a[i] - b[i]));
    expect(err).toBeLessThan(1e-6);
  });
  it('margins of a delayed integrator loop match the closed form', () => {
    // L = K e^(-sd) / s with K = 2π·5: crossover 5 Hz, PM = 90 − 360·5·d, phase crossover at 1/(4d), GM = 20·log10(1/(4d·5))
    const d = 0.01;
    const noFilters: FilterConfig = { fs: 8000, ctrlRate: 8000, notches: [], lpf: 0, dlpf: 0 };
    const fit = { axis: 'roll' as const, K: 2 * Math.PI * 5, tau: 0, delay: d, r2: 1, t0: 0, t1: 1, fs: 8000, n: 1 };
    const f = Float64Array.from({ length: 20000 }, (_, i) => 0.1 * 1.0005 ** i);
    const m = loopAt(fit, { k: 1, p: 1, i: 0, d: 0 }, noFilters, {}, f).margins!;
    expect(m.fc).toBeCloseTo(5, 1);
    expect(m.pm).toBeCloseTo(72, 0);
    expect(m.fGm).toBeCloseTo(25, 0);
    expect(m.gm).toBeCloseTo(20 * Math.log10(5), 1);
  });
});

describe('events & params', () => {
  it('formats libevents templates with enums and units', () => {
    const p = new EventParser({ version: 2, components: { '1': { namespace: 'px4', enums: { mode_t: { type: 'uint8_t', entries: { '2': { name: 'pos', description: 'Position' } } } }, event_groups: { default: { events: { '5': { name: 'x', message: 'Mode {1}, alt {2:.1m}', arguments: [{ name: 'm', type: 'mode_t' }, { name: 'a', type: 'float' }] } } } } } } });
    const args = new Uint8Array(5); args[0] = 2; new DataView(args.buffer).setFloat32(1, 12.34, true);
    expect(p.decode((1 << 24) | 5, args)?.message).toBe('Mode Position, alt 12.3 m');
  });
  it('parses QGC .params and diffs sets', () => {
    const a = parseQgcParams('# x\n1\t1\tMC_ROLL_P\t6.5\t9\n1\t1\tSDLOG_PROFILE\t17\t6\n', 'a');
    const b = parseQgcParams('1\t1\tMC_ROLL_P\t6.5\t9\n1\t1\tSDLOG_PROFILE\t1\t6\n', 'b');
    const d = diffParams([a, b]);
    expect(d.map((r) => r.name)).toEqual(['SDLOG_PROFILE']);
  });
});

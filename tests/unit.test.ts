/** Unit tests that need no flight logs: a synthetic ULog file and DSP sanity checks. */
import { describe, it, expect } from 'vitest';
import { ULog } from '../src/core/ulog';
import { welch, peakIn, px4Notch, lowpass2, biquadResponse, cabs, filtfilt, butterworth } from '../src/core/dsp';
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

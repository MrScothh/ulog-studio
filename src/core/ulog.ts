/**
 * ULog (PX4) parser — columnar, zero-dependency, runs in a Web Worker or Node.
 *
 * Format reference: https://docs.px4.io/main/en/dev_log/ulog_file_format.html
 * The file is indexed once (message offsets per subscription); topics are decoded lazily
 * into Float64Array columns on first access and cached.
 */

export const TYPE_SIZE: Record<string, number> = {
  int8_t: 1, uint8_t: 1, int16_t: 2, uint16_t: 2, int32_t: 4, uint32_t: 4,
  int64_t: 8, uint64_t: 8, float: 4, double: 8, bool: 1, char: 1,
};

const SYNC_MAGIC = [0x2f, 0x73, 0x13, 0x20, 0x25, 0x0c, 0xbb, 0x12];
const VALID_TYPES = new Set('BFIMPQARDLCSO'.split('').map((c) => c.charCodeAt(0)));

export interface FormatField { type: string; name: string; count: number; isArray: boolean }
export interface FlatField { name: string; type: string; offset: number; count: number }

export interface TopicMeta {
  key: string; // name or name_<multi>
  name: string;
  multi: number;
  count: number;
  fields: string[]; // numeric fields (flattened)
  stringFields: string[];
  t0: number; // s since log start
  t1: number;
  rate: number; // mean logged rate (Hz)
}

export interface LogMessage { t: number; level: number; tag?: number; message: string }
export interface Dropout { t: number; durationMs: number }
export interface ParamChange { t: number; name: string; value: number }

export type InfoValue = string | number | Uint8Array;

export interface TopicData {
  key: string;
  count: number;
  t: Float64Array; // seconds since log start (from 'timestamp')
  cols: Record<string, Float64Array>;
  strings: Record<string, string[]>;
}

interface SubIndex {
  msgId: number;
  name: string;
  multi: number;
  key: string;
  offsets: number[]; // byte offset of payload (after msg_id)
  sizes: number[];
}

const td = new TextDecoder('utf-8');

function decodeStr(b: Uint8Array): string {
  let end = b.length;
  const z = b.indexOf(0);
  if (z >= 0) end = z;
  return td.decode(b.subarray(0, end));
}

export function parseFormatFields(s: string): FormatField[] {
  const out: FormatField[] = [];
  for (const raw of s.split(';')) {
    const f = raw.trim();
    if (!f) continue;
    const sp = f.lastIndexOf(' ');
    if (sp < 0) continue;
    let type = f.slice(0, sp).trim();
    const name = f.slice(sp + 1).trim();
    let count = 1;
    let isArray = false;
    const m = /^(.+)\[(\d+)\]$/.exec(type);
    if (m) { type = m[1]; count = parseInt(m[2], 10); isArray = true; }
    out.push({ type, name, count, isArray });
  }
  return out;
}

export class ULog {
  readonly bytes: Uint8Array;
  readonly dv: DataView;
  version = 0;
  startTimestamp = 0; // µs (boot time base)
  lastTimestamp = 0; // µs
  formats = new Map<string, FormatField[]>();
  info: Record<string, InfoValue> = {};
  infoMulti: Record<string, InfoValue[]> = {};
  params = new Map<string, number>();
  paramTypes = new Map<string, string>();
  defaultParams = new Map<string, { system?: number; airframe?: number }>();
  changedParams: ParamChange[] = [];
  logs: LogMessage[] = [];
  dropouts: Dropout[] = [];
  compatFlags: number[] = [];
  incompatFlags: number[] = [];
  appendedOffsets: number[] = [];
  corruptBytes = 0;
  warnings: string[] = [];

  private subsById = new Map<number, SubIndex>();
  private subsByKey = new Map<string, SubIndex>();
  private flatCache = new Map<string, { fields: FlatField[]; size: number }>();
  private topicCache = new Map<string, TopicData>();

  constructor(buffer: ArrayBuffer | Uint8Array) {
    this.bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    this.dv = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
    this.parse();
  }

  private u64(off: number): number {
    return this.dv.getUint32(off, true) + this.dv.getUint32(off + 4, true) * 4294967296;
  }

  private i64(off: number): number {
    return this.dv.getUint32(off, true) + this.dv.getInt32(off + 4, true) * 4294967296;
  }

  private parse() {
    const b = this.bytes;
    if (b.length < 16) throw new Error('File too small to be a ULog');
    const magic = [0x55, 0x4c, 0x6f, 0x67, 0x01, 0x12, 0x35];
    for (let i = 0; i < 7; i++) if (b[i] !== magic[i]) throw new Error('Not a ULog file (bad magic)');
    this.version = b[7];
    this.startTimestamp = this.u64(8);
    this.lastTimestamp = this.startTimestamp;

    let pos = 16;
    let end = b.length;
    let appendedIdx = 0;
    const n = b.length;
    while (true) {
      while (pos + 3 <= end) {
        const size = this.dv.getUint16(pos, true);
        const type = b[pos + 2];
        if (!VALID_TYPES.has(type) || pos + 3 + size > end) {
          if (pos + 3 + size > end && VALID_TYPES.has(type) && end === n) break; // truncated tail
          const next = this.findSync(pos + 1, end);
          if (next < 0) { this.corruptBytes += end - pos; pos = end; break; }
          this.corruptBytes += next - pos;
          pos = next;
          continue;
        }
        const body = pos + 3;
        pos = body + size;
        this.handle(type, body, size);
        if (type === 0x42 /* B */ && this.appendedOffsets.length) {
          const off = this.appendedOffsets.find((o) => o > 0);
          if (off && off < n) end = off;
        }
      }
      // appended data sections
      const nextOff = this.appendedOffsets.filter((o) => o > 0)[appendedIdx];
      if (nextOff !== undefined && nextOff < n && end !== n) {
        appendedIdx++;
        pos = nextOff;
        const following = this.appendedOffsets.filter((o) => o > nextOff)[0];
        end = following && following < n ? following : n;
        continue;
      }
      break;
    }
    if (this.corruptBytes > 0) this.warnings.push(`Corrupt/unknown data skipped: ${this.corruptBytes} bytes`);
  }

  private findSync(from: number, end: number): number {
    const b = this.bytes;
    for (let i = from; i + 8 <= end; i++) {
      if (b[i] === SYNC_MAGIC[0] && b[i + 1] === SYNC_MAGIC[1] && b[i + 2] === SYNC_MAGIC[2] && b[i + 3] === SYNC_MAGIC[3]
        && b[i + 4] === SYNC_MAGIC[4] && b[i + 5] === SYNC_MAGIC[5] && b[i + 6] === SYNC_MAGIC[6] && b[i + 7] === SYNC_MAGIC[7]) {
        return i + 8;
      }
    }
    return -1;
  }

  private handle(type: number, body: number, size: number) {
    const b = this.bytes;
    switch (type) {
      case 0x44: { // D
        if (size < 2) return;
        const id = this.dv.getUint16(body, true);
        const s = this.subsById.get(id);
        if (size >= 10) {
          const ts = this.u64(body + 2);
          if (ts > this.lastTimestamp && ts < this.lastTimestamp + 3.6e9 * 24) this.lastTimestamp = ts;
        }
        if (s) { s.offsets.push(body + 2); s.sizes.push(size - 2); }
        return;
      }
      case 0x41: { // A
        const multi = b[body];
        const id = this.dv.getUint16(body + 1, true);
        const name = decodeStr(b.subarray(body + 3, body + size));
        const key = multi === 0 ? name : `${name}_${multi}`;
        let s = this.subsByKey.get(key);
        if (!s) {
          s = { msgId: id, name, multi, key, offsets: [], sizes: [] };
          this.subsByKey.set(key, s);
        }
        this.subsById.set(id, s);
        return;
      }
      case 0x52: { // R (remove subscription)
        const id = this.dv.getUint16(body, true);
        this.subsById.delete(id);
        return;
      }
      case 0x46: { // F
        const s = decodeStr(b.subarray(body, body + size));
        const c = s.indexOf(':');
        if (c < 0) return;
        this.formats.set(s.slice(0, c), parseFormatFields(s.slice(c + 1)));
        return;
      }
      case 0x49: case 0x4d: { // I, M
        const multi = type === 0x4d;
        const cont = multi ? b[body] : 0;
        const o = multi ? body + 1 : body;
        const kl = b[o];
        const key = decodeStr(b.subarray(o + 1, o + 1 + kl));
        const sp = key.indexOf(' ');
        const t = key.slice(0, sp);
        const name = key.slice(sp + 1);
        const vOff = o + 1 + kl;
        const vEnd = body + size;
        const v = this.decodeValue(t, vOff, vEnd);
        if (!multi) { this.info[name] = v; return; }
        const list = this.infoMulti[name] ?? (this.infoMulti[name] = []);
        if (cont && list.length) {
          const prev = list[list.length - 1];
          if (typeof prev === 'string' && typeof v === 'string') list[list.length - 1] = prev + v;
          else if (prev instanceof Uint8Array && v instanceof Uint8Array) {
            const m = new Uint8Array(prev.length + v.length); m.set(prev); m.set(v, prev.length); list[list.length - 1] = m;
          } else list.push(v);
        } else list.push(v);
        return;
      }
      case 0x50: case 0x51: { // P, Q
        let o = body;
        let defType = 0;
        if (type === 0x51) { defType = b[o]; o++; }
        const kl = b[o];
        const key = decodeStr(b.subarray(o + 1, o + 1 + kl));
        const sp = key.indexOf(' ');
        const t = key.slice(0, sp);
        const name = key.slice(sp + 1);
        const raw = this.decodeValue(t, o + 1 + kl, body + size);
        if (typeof raw !== 'number') return;
        // float32 parameters: keep the 7 significant digits QGroundControl shows (0.15 instead of 0.15000000596)
        const v = t === 'float' ? +raw.toPrecision(7) : raw;
        if (type === 0x51) {
          const d = this.defaultParams.get(name) ?? {};
          if (defType & 1) d.system = v;
          if (defType & 2) d.airframe = v;
          if (!defType) d.system = v;
          this.defaultParams.set(name, d);
          return;
        }
        const old = this.params.get(name);
        if (this.subsById.size > 0 && old !== undefined && old !== v) {
          this.changedParams.push({ t: (this.lastTimestamp - this.startTimestamp) / 1e6, name, value: v });
        }
        this.params.set(name, v);
        this.paramTypes.set(name, t);
        return;
      }
      case 0x4c: { // L
        if (size < 9) return;
        const lvl = b[body];
        const ts = this.u64(body + 1);
        this.logs.push({ t: (ts - this.startTimestamp) / 1e6, level: lvl >= 48 ? lvl - 48 : lvl, message: decodeStr(b.subarray(body + 9, body + size)) });
        return;
      }
      case 0x43: { // C (tagged)
        if (size < 11) return;
        const lvl = b[body];
        const tag = this.dv.getUint16(body + 1, true);
        const ts = this.u64(body + 3);
        this.logs.push({ t: (ts - this.startTimestamp) / 1e6, level: lvl >= 48 ? lvl - 48 : lvl, tag, message: decodeStr(b.subarray(body + 11, body + size)) });
        return;
      }
      case 0x4f: { // O
        this.dropouts.push({ t: (this.lastTimestamp - this.startTimestamp) / 1e6, durationMs: this.dv.getUint16(body, true) });
        return;
      }
      case 0x42: { // B flag bits
        if (size < 40) return;
        this.compatFlags = Array.from(b.subarray(body, body + 8));
        this.incompatFlags = Array.from(b.subarray(body + 8, body + 16));
        this.appendedOffsets = [this.u64(body + 16), this.u64(body + 24), this.u64(body + 32)];
        if (this.incompatFlags[0] & ~1 || this.incompatFlags.slice(1).some((x) => x)) {
          this.warnings.push('Unknown incompatible ULog flags set; parsing anyway');
        }
        if (!(this.incompatFlags[0] & 1)) this.appendedOffsets = [];
        return;
      }
      default:
        return; // S (sync) and others
    }
  }

  private decodeValue(type: string, off: number, end: number): InfoValue {
    const m = /^(.+)\[(\d+)\]$/.exec(type);
    const base = m ? m[1] : type;
    if (base === 'char') return decodeStr(this.bytes.subarray(off, end));
    if (m) {
      if (base === 'uint8_t' || base === 'int8_t' || base === 'bool') return this.bytes.slice(off, end);
      return this.bytes.slice(off, end);
    }
    return this.readScalar(base, off);
  }

  readScalar(type: string, off: number): number {
    const dv = this.dv;
    switch (type) {
      case 'int8_t': return dv.getInt8(off);
      case 'uint8_t': case 'bool': case 'char': return dv.getUint8(off);
      case 'int16_t': return dv.getInt16(off, true);
      case 'uint16_t': return dv.getUint16(off, true);
      case 'int32_t': return dv.getInt32(off, true);
      case 'uint32_t': return dv.getUint32(off, true);
      case 'int64_t': return this.i64(off);
      case 'uint64_t': return this.u64(off);
      case 'float': return dv.getFloat32(off, true);
      case 'double': return dv.getFloat64(off, true);
      default: return NaN;
    }
  }

  /** Flatten a (possibly nested) message format into primitive fields with byte offsets. */
  flatten(formatName: string): { fields: FlatField[]; size: number } {
    const cached = this.flatCache.get(formatName);
    if (cached) return cached;
    const fields: FlatField[] = [];
    const rec = (fmt: string, prefix: string, base: number, depth: number): number => {
      const ff = this.formats.get(fmt);
      if (!ff || depth > 8) return 0;
      let off = base;
      for (const f of ff) {
        const ts = TYPE_SIZE[f.type];
        if (f.name.startsWith('_padding')) {
          off += (ts ?? 1) * f.count;
          continue;
        }
        if (ts !== undefined) {
          if (f.type === 'char') {
            fields.push({ name: prefix + f.name, type: 'char', offset: off, count: f.count });
            off += f.count;
          } else if (f.isArray) {
            for (let j = 0; j < f.count; j++) fields.push({ name: `${prefix}${f.name}[${j}]`, type: f.type, offset: off + j * ts, count: 1 });
            off += ts * f.count;
          } else {
            fields.push({ name: prefix + f.name, type: f.type, offset: off, count: 1 });
            off += ts;
          }
        } else {
          for (let j = 0; j < f.count; j++) {
            const p = prefix + f.name + (f.isArray ? `[${j}]` : '') + '.';
            off = rec(f.type, p, off, depth + 1);
          }
        }
      }
      return off;
    };
    const size = rec(formatName, '', 0, 0);
    const res = { fields, size };
    this.flatCache.set(formatName, res);
    return res;
  }

  topicKeys(): string[] {
    return [...this.subsByKey.values()].filter((s) => s.offsets.length > 0).map((s) => s.key).sort();
  }

  has(key: string): boolean {
    const s = this.subsByKey.get(key);
    return !!s && s.offsets.length > 0;
  }

  topicMeta(key: string): TopicMeta | undefined {
    const s = this.subsByKey.get(key);
    if (!s || !s.offsets.length) return undefined;
    const { fields } = this.flatten(s.name);
    const first = s.offsets[0];
    const last = s.offsets[s.offsets.length - 1];
    const t0 = (this.u64(first) - this.startTimestamp) / 1e6;
    const t1 = (this.u64(last) - this.startTimestamp) / 1e6;
    return {
      key, name: s.name, multi: s.multi, count: s.offsets.length,
      fields: fields.filter((f) => f.type !== 'char').map((f) => f.name),
      stringFields: fields.filter((f) => f.type === 'char').map((f) => f.name),
      t0, t1, rate: s.offsets.length > 1 && t1 > t0 ? (s.offsets.length - 1) / (t1 - t0) : 0,
    };
  }

  allTopicMeta(): TopicMeta[] {
    return this.topicKeys().map((k) => this.topicMeta(k)!).filter(Boolean);
  }

  /** Decode a topic into columns (cached). */
  topic(key: string): TopicData | undefined {
    const c = this.topicCache.get(key);
    if (c) return c;
    const s = this.subsByKey.get(key);
    if (!s || !s.offsets.length) return undefined;
    const { fields } = this.flatten(s.name);
    const n = s.offsets.length;
    const cols: Record<string, Float64Array> = {};
    const strings: Record<string, string[]> = {};
    const dv = this.dv;
    const offs = s.offsets;
    const sizes = s.sizes;
    for (const f of fields) {
      if (f.type === 'char') {
        const arr: string[] = new Array(n);
        for (let i = 0; i < n; i++) {
          const o = offs[i] + f.offset;
          arr[i] = f.offset + f.count <= sizes[i] ? decodeStr(this.bytes.subarray(o, o + f.count)) : '';
        }
        strings[f.name] = arr;
        continue;
      }
      const col = new Float64Array(n);
      const fo = f.offset;
      const sz = TYPE_SIZE[f.type];
      for (let i = 0; i < n; i++) {
        if (fo + sz > sizes[i]) { col[i] = NaN; continue; }
        const o = offs[i] + fo;
        switch (f.type) {
          case 'float': col[i] = dv.getFloat32(o, true); break;
          case 'double': col[i] = dv.getFloat64(o, true); break;
          case 'uint8_t': case 'bool': col[i] = dv.getUint8(o); break;
          case 'int8_t': col[i] = dv.getInt8(o); break;
          case 'uint16_t': col[i] = dv.getUint16(o, true); break;
          case 'int16_t': col[i] = dv.getInt16(o, true); break;
          case 'uint32_t': col[i] = dv.getUint32(o, true); break;
          case 'int32_t': col[i] = dv.getInt32(o, true); break;
          case 'uint64_t': col[i] = dv.getUint32(o, true) + dv.getUint32(o + 4, true) * 4294967296; break;
          case 'int64_t': col[i] = dv.getUint32(o, true) + dv.getInt32(o + 4, true) * 4294967296; break;
          default: col[i] = NaN;
        }
      }
      cols[f.name] = col;
    }
    const ts = cols['timestamp'];
    const t = new Float64Array(n);
    if (ts) for (let i = 0; i < n; i++) t[i] = (ts[i] - this.startTimestamp) / 1e6;
    const res: TopicData = { key, count: n, t, cols, strings };
    this.topicCache.set(key, res);
    return res;
  }

  /** Convenience: time base from timestamp_sample when present (more accurate for sensors/controllers). */
  sampleTime(key: string): Float64Array | undefined {
    const d = this.topic(key);
    if (!d) return undefined;
    const ts = d.cols['timestamp_sample'];
    if (!ts) return d.t;
    const out = new Float64Array(d.count);
    for (let i = 0; i < d.count; i++) out[i] = ts[i] > 0 ? (ts[i] - this.startTimestamp) / 1e6 : d.t[i];
    return out;
  }

  get durationS(): number {
    return (this.lastTimestamp - this.startTimestamp) / 1e6;
  }

  infoString(name: string): string | undefined {
    const v = this.info[name];
    return typeof v === 'string' ? v : undefined;
  }

  infoNumber(name: string): number | undefined {
    const v = this.info[name];
    return typeof v === 'number' ? v : undefined;
  }

  dropCache(key?: string) {
    if (key) this.topicCache.delete(key); else this.topicCache.clear();
  }
}

/** Continuous sample stream from a *_fifo topic (sensor_gyro_fifo / sensor_accel_fifo). */
export interface FifoStream { t: Float64Array; x: Float64Array; y: Float64Array; z: Float64Array; fs: number; gaps: number }

export function unpackFifo(log: ULog, key: string, tRange?: [number, number]): FifoStream | undefined {
  const d = log.topic(key);
  if (!d) return undefined;
  const ts = d.cols['timestamp_sample'] ?? d.cols['timestamp'];
  const ns = d.cols['samples'];
  const dtc = d.cols['dt'];
  const scale = d.cols['scale'];
  if (!ns || !dtc || !scale || !d.cols['x[0]']) return undefined;
  let maxN = 0;
  while (d.cols[`x[${maxN}]`]) maxN++;
  let total = 0;
  const lo = tRange ? tRange[0] : -Infinity;
  const hi = tRange ? tRange[1] : Infinity;
  for (let i = 0; i < d.count; i++) {
    const tt = (ts[i] - log.startTimestamp) / 1e6;
    if (tt < lo || tt > hi) continue;
    total += Math.min(maxN, ns[i]);
  }
  const t = new Float64Array(total), x = new Float64Array(total), y = new Float64Array(total), z = new Float64Array(total);
  let k = 0;
  let gaps = 0;
  let lastT = NaN;
  const dts: number[] = [];
  const X: Float64Array[] = [], Y: Float64Array[] = [], Z: Float64Array[] = [];
  for (let j = 0; j < maxN; j++) { X.push(d.cols[`x[${j}]`]); Y.push(d.cols[`y[${j}]`]); Z.push(d.cols[`z[${j}]`]); }
  for (let i = 0; i < d.count; i++) {
    const tLast = (ts[i] - log.startTimestamp) / 1e6;
    if (tLast < lo || tLast > hi) continue;
    const n = Math.min(maxN, ns[i]);
    const dt = dtc[i] / 1e6;
    const sc = scale[i];
    if (dts.length < 200) dts.push(dt);
    for (let j = 0; j < n; j++) {
      const tt = tLast - dt * (n - 1 - j);
      t[k] = tt; x[k] = X[j][i] * sc; y[k] = Y[j][i] * sc; z[k] = Z[j][i] * sc;
      if (!isNaN(lastT) && tt - lastT > 2.5 * dt) gaps++;
      lastT = tt;
      k++;
    }
  }
  dts.sort((a, b) => a - b);
  const med = dts.length ? dts[dts.length >> 1] : 0;
  return { t: t.subarray(0, k), x: x.subarray(0, k), y: y.subarray(0, k), z: z.subarray(0, k), fs: med > 0 ? 1 / med : 0, gaps };
}

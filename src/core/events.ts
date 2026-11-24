/**
 * PX4 events decoding (port of mavlink/libevents python parser, BSD-3).
 * Metadata source: the `metadata_events` info message embedded in the log (xz-compressed JSON, PX4 >= 1.15),
 * falling back to the bundled all_events.json shipped with the app.
 */
import type { ULog } from './ulog';
import { XzReadableStream } from 'xz-decompress';
import bundledDefs from '../assets/px4/all_events.json';

export interface EventDefs {
  version: number;
  components: Record<string, {
    namespace: string;
    enums?: Record<string, EnumDef>;
    event_groups?: Record<string, { events?: Record<string, EventDef> }>;
    navigation_mode_groups?: unknown;
  }>;
}
interface EnumDef { type: string; description?: string; is_bitfield?: boolean; separator?: string; entries: Record<string, { name: string; description: string }> }
interface EventDef { name: string; message: string; description?: string; type?: string; arguments?: { name: string; type: string; description?: string }[] }

export interface DecodedEvent {
  t: number;
  id: number;
  name: string;
  group: string;
  level: number; // external log level 0..7 (emergency..debug)
  internalLevel: number;
  message: string;
  description: string;
  sequence: number;
  known: boolean;
}

export const LOG_LEVELS = ['EMERGENCY', 'ALERT', 'CRITICAL', 'ERROR', 'WARNING', 'NOTICE', 'INFO', 'DEBUG', 'PROTOCOL', 'DISABLED'];

const BASE: Record<string, [number, (dv: DataView, o: number) => number]> = {
  uint8_t: [1, (d, o) => d.getUint8(o)],
  int8_t: [1, (d, o) => d.getInt8(o)],
  uint16_t: [2, (d, o) => d.getUint16(o, true)],
  int16_t: [2, (d, o) => d.getInt16(o, true)],
  uint32_t: [4, (d, o) => d.getUint32(o, true)],
  int32_t: [4, (d, o) => d.getInt32(o, true)],
  uint64_t: [8, (d, o) => d.getUint32(o, true) + d.getUint32(o + 4, true) * 4294967296],
  int64_t: [8, (d, o) => d.getUint32(o, true) + d.getInt32(o + 4, true) * 4294967296],
  float: [4, (d, o) => d.getFloat32(o, true)],
};

export class EventParser {
  private comps = new Map<number, { ns: string; groups: [string, Map<number, EventDef>][] }>();
  private enums = new Map<string, EnumDef>();
  profile = 'dev';

  constructor(defs: EventDefs) {
    for (const [cid, comp] of Object.entries(defs.components ?? {})) {
      const groups: [string, Map<number, EventDef>][] = [];
      for (const [gname, g] of Object.entries(comp.event_groups ?? {})) {
        const m = new Map<number, EventDef>();
        for (const [sid, ev] of Object.entries(g.events ?? {})) m.set(parseInt(sid, 10), ev);
        groups.push([gname, m]);
      }
      this.comps.set(parseInt(cid, 10), { ns: comp.namespace, groups });
      for (const [ename, e] of Object.entries(comp.enums ?? {})) this.enums.set(`${comp.namespace}::${ename}`, e);
    }
  }

  merge(other: EventParser) {
    for (const [cid, c] of other.comps) if (!this.comps.has(cid)) this.comps.set(cid, c);
    for (const [k, e] of other.enums) if (!this.enums.has(k)) this.enums.set(k, e);
  }

  lookup(id: number): { ev: EventDef; group: string; ns: string } | undefined {
    const comp = this.comps.get((id >>> 24) & 0xff);
    if (!comp) return undefined;
    const sub = id & 0xffffff;
    for (const [g, m] of comp.groups) {
      const ev = m.get(sub);
      if (ev) return { ev, group: g, ns: comp.ns };
    }
    return undefined;
  }

  decode(id: number, args: Uint8Array): { name: string; group: string; message: string; description: string } | undefined {
    const f = this.lookup(id);
    if (!f) return undefined;
    const dv = new DataView(args.buffer, args.byteOffset, args.byteLength);
    const values: { v: number; e?: EnumDef }[] = [];
    let off = 0;
    for (const a of f.ev.arguments ?? []) {
      let base = a.type;
      let e: EnumDef | undefined;
      if (!BASE[base]) {
        e = this.enums.get(base.includes('::') ? base : `${f.ns}::${base}`);
        base = e?.type ?? 'uint8_t';
      }
      const [sz, rd] = BASE[base] ?? BASE.uint8_t;
      values.push({ v: off + sz <= args.length ? rd(dv, off) : NaN, e });
      off += sz;
    }
    return {
      name: f.ev.name,
      group: f.group,
      message: this.process(f.ev.message, values),
      description: f.ev.description ? this.process(f.ev.description, values) : '',
    };
  }

  private display(val: { v: number; e?: EnumDef }): string | number {
    const { v, e } = val;
    if (!e) return v;
    if (e.is_bitfield) {
      const size = BASE[e.type]?.[0] ?? 1;
      const parts: string[] = [];
      for (let i = 0; i < size * 8; i++) {
        const bit = 2 ** i;
        if (Math.floor(v / bit) % 2 === 1) {
          const ent = e.entries[String(bit)];
          parts.push(ent ? ent.description : `(unknown: ${v})`);
        }
      }
      return parts.join(e.separator ?? '|');
    }
    const ent = e.entries[String(v)];
    return ent ? ent.description : `(unknown: ${v})`;
  }

  /** libevents message template processing (tags, escapes, {N[:.D][unit]} arguments). */
  process(msgIn: string, values: { v: number; e?: EnumDef }[]): string {
    let msg = msgIn;
    let i = 0;
    while (i < msg.length) {
      const c = msg[i];
      if (c === '\\') { msg = msg.slice(0, i) + msg.slice(i + 1); i++; continue; }
      if (c === '<') {
        const m = /^<([a-z]+)(?: ([a-z]+)="([^"]*)")?>/.exec(msg.slice(i));
        if (!m) { i++; continue; }
        const tag = m[1];
        const contentStart = i + m[0].length;
        const endIdx = msg.indexOf(`</${tag}>`, contentStart);
        if (endIdx < 0) { i++; continue; }
        let content = msg.slice(contentStart, endIdx);
        if (tag === 'profile') {
          const p = m[3] ?? '';
          const remove = p.startsWith('!') ? this.profile === p.slice(1) : this.profile !== p;
          if (remove) content = '';
        } else if (tag === 'a') {
          // keep the text only
        } else if (tag === 'param') {
          // parameter name kept as-is
        } else content = '';
        msg = msg.slice(0, i) + content + msg.slice(endIdx + tag.length + 3);
        i += tag === 'profile' ? 0 : content.length;
        continue;
      }
      if (c === '{') {
        const end = msg.indexOf('}', i);
        if (end < 0) { i++; continue; }
        const m = /^(\d+)(?::(?:\.(\d+))?)?(m|m_v|m\/s|m\^2|C)?$/.exec(msg.slice(i + 1, end));
        if (!m) { i++; continue; }
        const idx = parseInt(m[1], 10) - 1;
        if (idx < 0 || idx >= values.length) { i++; continue; }
        const d = this.display(values[idx]);
        let s = typeof d === 'number' && m[2] !== undefined ? d.toFixed(parseInt(m[2], 10)) : String(typeof d === 'number' && !Number.isInteger(d) ? +d.toPrecision(6) : d);
        if (m[3]) s += ' ' + (m[3] === 'm_v' ? 'm' : m[3]);
        msg = msg.slice(0, i) + s + msg.slice(end + 1);
        i += s.length;
        continue;
      }
      i++;
    }
    return msg.trim();
  }
}

/** Decompress xz data using the WASM decoder (browser + worker). */
export async function xzDecompress(data: Uint8Array): Promise<Uint8Array> {
  const stream = new XzReadableStream(new Blob([data as BlobPart]).stream());
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

let bundled: EventParser | undefined;
async function bundledParser(): Promise<EventParser> {
  if (!bundled) {
    bundled = new EventParser(bundledDefs as unknown as EventDefs);
  }
  return bundled;
}

export interface EventsResult { events: DecodedEvent[]; source: 'log' | 'bundled' | 'none'; sha256?: string }

export async function decodeLogEvents(log: ULog): Promise<EventsResult> {
  const d = log.topic('event');
  let parser: EventParser | undefined;
  let source: EventsResult['source'] = 'none';
  const raw = log.infoMulti['metadata_events']?.[0] ?? log.info['metadata_events'];
  if (raw instanceof Uint8Array && raw.length > 6) {
    try {
      const json = new TextDecoder().decode(await xzDecompress(raw));
      parser = new EventParser(JSON.parse(json));
      source = 'log';
      parser.merge(await bundledParser());
    } catch {
      parser = undefined;
    }
  }
  if (!parser) { parser = await bundledParser(); source = 'bundled'; }
  const events: DecodedEvent[] = [];
  if (d) {
    const argCols: Float64Array[] = [];
    for (let j = 0; d.cols[`arguments[${j}]`]; j++) argCols.push(d.cols[`arguments[${j}]`]);
    for (let i = 0; i < d.count; i++) {
      const id = d.cols['id'][i] >>> 0;
      const args = new Uint8Array(argCols.length);
      for (let j = 0; j < argCols.length; j++) args[j] = argCols[j][i];
      const lv = d.cols['log_levels']?.[i] ?? 6;
      const dec = parser.decode(id, args);
      events.push({
        t: d.t[i], id, sequence: d.cols['event_sequence']?.[i] ?? 0,
        level: lv & 0xf, internalLevel: (lv >> 4) & 0xf,
        name: dec?.name ?? `0x${id.toString(16)}`,
        group: dec?.group ?? '',
        message: dec?.message ?? `Unknown event 0x${id.toString(16).padStart(8, '0')}`,
        description: dec?.description ?? '',
        known: !!dec,
      });
    }
  }
  return { events, source, sha256: log.infoString('metadata_events_sha256') };
}

import { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Tooltip, ToggleButton, Button, makeStyles, tokens } from '@fluentui/react-components';
import { ArrowExpandRegular, ArrowMinimizeRegular, ZoomFitRegular, LocationArrowRegular } from '@fluentui/react-icons';
import type { MapSpec } from '../core/types';
import { FLIGHT_MODES } from '../core/px4';
import { useChartCtx } from './ChartContext';
import { ChartFrame } from './ChartFrame';
import { useCursorT, cursorSync, useTimeRange } from './timeSync';
import { useReplayState, replayState, locate, lerp, lerpDeg } from './replayState';
import { fmtTime } from './theme';
import { prefs } from '../app/prefs';

type Basemap = 'offline' | 'satellite';

/** Satellite imagery is opt-in: tile requests tell the provider which area is being looked at. */
const SATELLITE = {
  url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  attribution: 'Imagery © Esri, Maxar, Earthstar Geographics, GIS User Community',
  // z19+ is missing in many rural areas (grey "not available" tiles): overzoom from 18 instead
  maxNativeZoom: 18,
};

const TRAIL_S = 15; // seconds of track drawn behind the drone

const useStyles = makeStyles({
  seg: { display: 'inline-flex', gap: '2px', padding: '2px', borderRadius: tokens.borderRadiusMedium, backgroundColor: tokens.colorNeutralBackground3 },
  legend: { display: 'flex', gap: '14px', flexWrap: 'wrap', alignItems: 'center', fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground3, paddingTop: '6px' },
  dot: { display: 'inline-block', width: '10px', height: '10px', borderRadius: '50%', marginRight: '5px', verticalAlign: '-1px' },
  line: { display: 'inline-block', width: '16px', height: '4px', borderRadius: '2px', marginRight: '5px', verticalAlign: '2px' },
});

function lighten(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => Math.round(c + (255 - c) * k));
  return `rgb(${ch.join(',')})`;
}

function lb(a: ArrayLike<number>, v: number): number {
  let lo = 0, hi = a.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < v) lo = m + 1; else hi = m; }
  return lo;
}

/** Drone marker: an arrow pointing along the heading. */
const droneIcon = L.divIcon({
  className: 'drone-marker',
  iconSize: [30, 30],
  iconAnchor: [15, 15],
  html: '<svg viewBox="0 0 30 30" width="30" height="30"><g class="drone-rot"><path d="M15 3 L24 25 L15 20 L6 25 Z" fill="#ffd166" stroke="#1f1f1f" stroke-width="2" stroke-linejoin="round"/></g></svg>',
});

/**
 * Trajectory map. Offline by default (track only, no basemap); satellite imagery (Esri World Imagery) is opt-in.
 * The track is coloured by flight mode, follows the timeline zoom (selected stretch highlighted), shares the cursor
 * with every chart and shows the drone (with heading and a short trail) during a replay.
 */
export function MapView({ spec }: { spec: MapSpec }) {
  const s = useStyles();
  const ctx = useChartCtx();
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const drone = useRef<L.Marker | null>(null);
  const trail = useRef<L.Polyline | null>(null);
  const label = useRef<L.Tooltip | null>(null);
  const tracks = useRef<{ line: L.Polyline; casing: L.Polyline; i0: number; i1: number }[]>([]);
  const focus = useRef<L.LayerGroup | null>(null);
  const stored = prefs.get<string>('basemap', 'offline');
  const [base, setBase] = useState<Basemap>(stored === 'satellite' ? 'satellite' : 'offline');
  const [tall, setTall] = useState(false);
  const cursorT = useCursorT();
  const range = useTimeRange(ctx.logId);
  const replay = useReplayState();
  const pts = useMemo(() => Array.from(spec.lat, (la, i) => L.latLng(la, spec.lon[i])), [spec]);
  const onImagery = base === 'satellite';

  // map + track
  useEffect(() => {
    if (!el.current) return;
    const m = L.map(el.current, { zoomControl: true, attributionControl: true, preferCanvas: true, zoomSnap: 0.25, scrollWheelZoom: false, maxZoom: 21 });
    m.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noreferrer">Leaflet</a>');
    map.current = m;
    const casingColor = ctx.theme.dark || onImagery ? 'rgba(0,0,0,0.75)' : 'rgba(255,255,255,0.9)';
    tracks.current = spec.segments.map((sg) => {
      const baseCol = FLIGHT_MODES[sg.mode]?.[1] ?? '#888888';
      const color = ctx.theme.dark || onImagery ? lighten(baseCol, 0.3) : baseCol;
      const seg = pts.slice(sg.i0, sg.i1 + 1);
      const casing = L.polyline(seg, { color: casingColor, weight: 6, opacity: 1, interactive: false }).addTo(m);
      const line = L.polyline(seg, { color, weight: 3, opacity: 1, interactive: false }).addTo(m);
      return { line, casing, i0: sg.i0, i1: sg.i1 };
    });
    focus.current = L.layerGroup().addTo(m);
    const mk = (p: L.LatLng, color: string, tip: string) => L.circleMarker(p, { radius: 6, color: '#ffffff', weight: 2, fillColor: color, fillOpacity: 1 }).addTo(m).bindTooltip(tip);
    if (spec.home) L.circleMarker(L.latLng(spec.home[0], spec.home[1]), { radius: 9, color: '#2a78d6', weight: 3, fillOpacity: 0.15 }).addTo(m).bindTooltip('Home');
    mk(pts[0], '#1baf7a', `Start ${fmtTime(spec.t[0])}`);
    mk(pts[pts.length - 1], '#e34948', `End ${fmtTime(spec.t[spec.t.length - 1])}`);
    L.control.scale({ imperial: false }).addTo(m);
    m.fitBounds(L.latLngBounds(pts).pad(0.15));
    trail.current = L.polyline([], { color: '#ffd166', weight: 4, opacity: 0.95, interactive: false });
    drone.current = L.marker(pts[0], { icon: droneIcon, interactive: false, keyboard: false, zIndexOffset: 1000 });
    label.current = L.tooltip({ permanent: true, direction: 'top', offset: [0, -16], className: 'map-cursor-label' });
    // plain wheel scrolls the page; Ctrl+wheel zooms (same as the charts)
    const host = el.current;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      m.setZoomAround(m.mouseEventToContainerPoint(e as unknown as MouseEvent), m.getZoom() + (e.deltaY < 0 ? 0.5 : -0.5));
    };
    host.addEventListener('wheel', onWheel, { passive: false });
    // hover near the track → flight cursor (ignored while a replay is running)
    const step = Math.max(1, Math.floor(pts.length / 4000));
    m.on('mousemove', (e: L.LeafletMouseEvent) => {
      if (replayState.get().playing) return;
      const p0 = m.latLngToContainerPoint(e.latlng);
      let best = -1, bd = 24 * 24;
      for (let i = 0; i < pts.length; i += step) {
        const q = m.latLngToContainerPoint(pts[i]);
        const d = (q.x - p0.x) ** 2 + (q.y - p0.y) ** 2;
        if (d < bd) { bd = d; best = i; }
      }
      cursorSync.set(best >= 0 ? spec.t[best] : null, 'ext');
    });
    m.on('mouseout', () => { if (!replayState.get().playing) cursorSync.set(null, 'ext'); });
    // the user moving the map turns "follow" off
    m.on('dragstart', () => { if (replayState.get().playing) replayState.set({ follow: false }); });
    const ro = new ResizeObserver(() => m.invalidateSize());
    ro.observe(host);
    return () => { ro.disconnect(); host.removeEventListener('wheel', onWheel); m.remove(); map.current = null; };
  }, [spec, pts, ctx.theme, onImagery]);

  // basemap
  useEffect(() => {
    const m = map.current;
    if (!m || base === 'offline') return;
    const layer = L.tileLayer(SATELLITE.url, { maxZoom: 21, maxNativeZoom: SATELLITE.maxNativeZoom, attribution: SATELLITE.attribution, referrerPolicy: 'no-referrer' } as L.TileLayerOptions).addTo(m);
    layer.bringToBack();
    return () => { m.removeLayer(layer); };
  }, [base, spec, ctx.theme]);

  // timeline zoom → highlight that stretch of the track, dim the rest
  useEffect(() => {
    const m = map.current, f = focus.current;
    if (!m || !f) return;
    f.clearLayers();
    const zoomed = range && (range[0] > spec.t[0] || range[1] < spec.t[spec.t.length - 1]);
    for (const tr of tracks.current) { tr.line.setStyle({ opacity: zoomed ? 0.3 : 1 }); tr.casing.setStyle({ opacity: zoomed ? 0.3 : 1 }); }
    if (!zoomed) return;
    const a = Math.max(0, lb(spec.t, range![0]) - 1), b = Math.min(pts.length - 1, lb(spec.t, range![1]));
    if (b <= a) return;
    for (const tr of tracks.current) {
      const i0 = Math.max(a, tr.i0), i1 = Math.min(b, tr.i1);
      if (i1 <= i0) continue;
      const seg = pts.slice(i0, i1 + 1);
      L.polyline(seg, { color: '#000000', weight: 8, opacity: 0.8, interactive: false }).addTo(f);
      L.polyline(seg, { color: tr.line.options.color, weight: 5, opacity: 1, interactive: false }).addTo(f);
    }
  }, [range, spec, pts, ctx.theme, onImagery]);

  // drone at the flight cursor: interpolated position, heading arrow, trail, label (time · mode · height)
  useEffect(() => {
    const m = map.current, d = drone.current, lab = label.current, tr = trail.current;
    if (!m || !d || !lab || !tr) return;
    if (cursorT == null || cursorT < spec.t[0] || cursorT > spec.t[spec.t.length - 1]) { d.remove(); lab.remove(); tr.remove(); return; }
    const [i, f] = locate(spec.t, cursorT);
    const p = L.latLng(lerp(spec.lat, i, f), lerp(spec.lon, i, f));
    d.setLatLng(p);
    if (!m.hasLayer(d)) d.addTo(m);
    const rot = d.getElement()?.querySelector<SVGGElement>('.drone-rot');
    const hdg = spec.hdg ? lerpDeg(spec.hdg, i, f) : NaN;
    if (rot) rot.setAttribute('transform', Number.isFinite(hdg) ? `rotate(${hdg} 15 15)` : '');
    const j0 = lb(spec.t, cursorT - TRAIL_S);
    tr.setLatLngs([...pts.slice(j0, i + 1), p]);
    if (!m.hasLayer(tr)) tr.addTo(m);
    const mode = ctx.modes.find((md) => cursorT >= md.t0 && cursorT < md.t1);
    const h = spec.alt ? ` · ${lerp(spec.alt, i, f).toFixed(1)} m` : '';
    lab.setLatLng(p).setContent(`${fmtTime(cursorT)}${mode ? ` · ${mode.name}` : ''}${h}`);
    if (!m.hasLayer(lab)) lab.addTo(m);
    // follow the drone while replaying: re-centre when it leaves the middle of the view
    if (replay.playing && replay.follow) {
      const size = m.getSize(), q = m.latLngToContainerPoint(p);
      if (q.x < size.x * 0.25 || q.x > size.x * 0.75 || q.y < size.y * 0.25 || q.y > size.y * 0.75) m.panTo(p, { animate: true, duration: 0.4 });
    }
  }, [cursorT, spec, pts, ctx.modes, replay.playing, replay.follow]);

  useEffect(() => { map.current?.invalidateSize(); }, [tall]);

  const fit = () => {
    const m = map.current;
    if (!m) return;
    if (range) {
      const a = lb(spec.t, range[0]), b = Math.max(a + 1, lb(spec.t, range[1]));
      const sel = pts.slice(a, b);
      if (sel.length > 1) { m.fitBounds(L.latLngBounds(sel).pad(0.2)); return; }
    }
    m.fitBounds(L.latLngBounds(pts).pad(0.15));
  };
  const pick = (b: Basemap) => { setBase(b); prefs.set('basemap', b); };
  const modesShown = [...new Map(ctx.modes.map((md) => [md.name, md.color])).entries()];

  const controls = (
    <>
      <div className={s.seg} role="radiogroup" aria-label="Basemap">
        <Tooltip relationship="description" content="No basemap: nothing is downloaded."><ToggleButton size="small" appearance="subtle" checked={base === 'offline'} onClick={() => pick('offline')}>Offline</ToggleButton></Tooltip>
        <Tooltip relationship="description" content="Esri World Imagery, loaded from the internet: the provider learns the area you are looking at."><ToggleButton size="small" appearance="subtle" checked={base === 'satellite'} onClick={() => pick('satellite')}>Satellite</ToggleButton></Tooltip>
      </div>
      <Tooltip relationship="label" content="Follow the drone during the replay"><ToggleButton size="small" appearance="subtle" icon={<LocationArrowRegular />} checked={replay.follow} onClick={() => replayState.set({ follow: !replay.follow })} /></Tooltip>
      <Tooltip relationship="label" content={range ? 'Fit the zoomed stretch' : 'Fit the whole track'}><Button size="small" appearance="subtle" icon={<ZoomFitRegular />} onClick={fit} /></Tooltip>
      <Tooltip relationship="label" content={tall ? 'Smaller map' : 'Taller map'}><Button size="small" appearance="subtle" icon={tall ? <ArrowMinimizeRegular /> : <ArrowExpandRegular />} onClick={() => setTall(!tall)} /></Tooltip>
    </>
  );
  return (
    <ChartFrame title={spec.title} extra={controls}>
      {/* Leaflet owns the inner element's classes: React must never rewrite them, so the state class lives on the wrapper */}
      <div className={`map-frame ${base === 'offline' ? 'map-offline' : 'map-online'}`}>
        <div ref={el} className="map-host" style={{ height: tall ? 680 : 440 }} />
      </div>
      <div className={s.legend}>
        {modesShown.map(([n, c]) => <span key={n}><span className={s.line} style={{ backgroundColor: c }} />{n}</span>)}
        <span><span className={s.dot} style={{ backgroundColor: '#1baf7a' }} />Start</span>
        <span><span className={s.dot} style={{ backgroundColor: '#e34948' }} />End</span>
        {spec.home && <span><span className={s.dot} style={{ border: '2px solid #2a78d6', width: 8, height: 8 }} />Home</span>}
        <span><span className={s.line} style={{ backgroundColor: '#ffd166' }} />Last {TRAIL_S} s</span>
        <span>Ctrl+wheel to zoom</span>
      </div>
    </ChartFrame>
  );
}

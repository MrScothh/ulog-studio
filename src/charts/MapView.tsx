import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Switch, Tooltip } from '@fluentui/react-components';
import type { MapSpec } from '../core/types';
import { FLIGHT_MODES } from '../core/px4';
import { useChartCtx } from './ChartContext';
import { ChartFrame } from './ChartFrame';
import { useCursorT, cursorSync } from './timeSync';
import { prefs } from '../app/prefs';

function lighten(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => Math.round(c + (255 - c) * k));
  return `rgb(${ch.join(',')})`;
}

/**
 * Trajectory map. Offline by default (no basemap: the track is drawn on a neutral canvas with a scale bar).
 * Online OpenStreetMap tiles are opt-in, because tile requests reveal the flight area to the tile server.
 */
export function MapView({ spec }: { spec: MapSpec }) {
  const ctx = useChartCtx();
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const cursor = useRef<L.CircleMarker | null>(null);
  const [tiles, setTiles] = useState<boolean>(prefs.get('osmTiles', false));
  const cursorT = useCursorT();

  useEffect(() => {
    if (!el.current) return;
    const m = L.map(el.current, { zoomControl: true, attributionControl: true, preferCanvas: true, zoomSnap: 0.25 });
    map.current = m;
    const pts = Array.from(spec.lat, (la, i) => L.latLng(la, spec.lon[i]));
    for (const s of spec.segments) {
      const base = FLIGHT_MODES[s.mode]?.[1] ?? '#888888';
      const color = ctx.theme.dark ? lighten(base, 0.35) : base;
      L.polyline(pts.slice(s.i0, s.i1 + 1), { color, weight: 3, opacity: 0.95 }).addTo(m).bindTooltip(FLIGHT_MODES[s.mode]?.[0] ?? `mode ${s.mode}`, { sticky: true });
    }
    L.circleMarker(pts[0], { radius: 5, color: '#1baf7a', fillOpacity: 1 }).addTo(m).bindTooltip('Start');
    L.circleMarker(pts[pts.length - 1], { radius: 5, color: '#e34948', fillOpacity: 1 }).addTo(m).bindTooltip('End');
    if (spec.home) L.circleMarker(L.latLng(spec.home[0], spec.home[1]), { radius: 7, color: '#2a78d6', weight: 2, fillOpacity: 0.2 }).addTo(m).bindTooltip('Home');
    L.control.scale({ imperial: false }).addTo(m);
    m.fitBounds(L.latLngBounds(pts).pad(0.15));
    cursor.current = L.circleMarker(pts[0], { radius: 7, color: ctx.theme.dark ? '#ffffff' : '#242424', weight: 3, fillColor: '#ffd166', fillOpacity: 1, interactive: false });
    // hover on the track → flight cursor (nearest point within 24 px)
    const step = Math.max(1, Math.floor(pts.length / 4000));
    m.on('mousemove', (e: L.LeafletMouseEvent) => {
      const p0 = m.latLngToContainerPoint(e.latlng);
      let best = -1, bd = 24 * 24;
      for (let i = 0; i < pts.length; i += step) {
        const q = m.latLngToContainerPoint(pts[i]);
        const d = (q.x - p0.x) ** 2 + (q.y - p0.y) ** 2;
        if (d < bd) { bd = d; best = i; }
      }
      cursorSync.set(best >= 0 ? spec.t[best] : null, 'ext');
    });
    m.on('mouseout', () => cursorSync.set(null, 'ext'));
    const ro = new ResizeObserver(() => m.invalidateSize());
    ro.observe(el.current);
    return () => { ro.disconnect(); m.remove(); map.current = null; };
  }, [spec, ctx.theme]);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    let layer: L.TileLayer | undefined;
    if (tiles) {
      layer = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap contributors' });
      layer.addTo(m);
    }
    return () => { if (layer) m.removeLayer(layer); };
  }, [tiles, spec]);

  useEffect(() => {
    const m = map.current, c = cursor.current;
    if (!m || !c) return;
    if (cursorT == null || cursorT < spec.t[0] || cursorT > spec.t[spec.t.length - 1]) { c.remove(); return; }
    let lo = 0, hi = spec.t.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (spec.t[mid] < cursorT) lo = mid; else hi = mid; }
    c.setLatLng([spec.lat[lo], spec.lon[lo]]);
    if (!m.hasLayer(c)) c.addTo(m);
  }, [cursorT, spec]);

  const toggle = (
    <Tooltip relationship="description" content="Loads OpenStreetMap tiles from the internet: the tile server learns the flight area. Off by default.">
      <Switch label="Online map" checked={tiles} onChange={(_, d) => { setTiles(d.checked); prefs.set('osmTiles', d.checked); }} />
    </Tooltip>
  );
  return (
    <ChartFrame title={spec.title} extra={toggle} note={tiles ? undefined : 'Offline view: no basemap is downloaded. Track coloured by flight mode.'}>
      <div ref={el} className={`map-host ${tiles ? '' : 'map-offline'}`} style={{ height: 380, borderRadius: 4 }} />
    </ChartFrame>
  );
}

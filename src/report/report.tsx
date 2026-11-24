/** Self-contained HTML report: every page of a flight, tables as HTML, charts rendered off-screen and embedded as PNG. */
import { createRoot } from 'react-dom/client';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import type { LogSummary, PageSpec, PlotSpec } from '../core/types';
import { getPage } from '../app/store';
import { engine } from '../app/engineClient';
import { ChartContext, ChartCtx } from '../charts/ChartContext';
import { chartTheme, ChartTheme } from '../charts/theme';
import { PageView } from '../components/Sections';
import { saveBytes, APP_VERSION } from '../app/platform';
import { LOG_LEVELS } from '../core/events';
import { LOG_ORDER } from './order';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
void LOG_LEVELS;

async function renderCharts(log: LogSummary, page: PageSpec): Promise<Map<string, string>> {
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-30000px;top:0;width:1100px;pointer-events:none;';
  document.body.appendChild(host);
  const snaps = new Map<string, () => string | undefined>();
  const theme: ChartTheme = chartTheme(false);
  const ctx: ChartCtx = {
    logId: `${log.id}:report`, duration: log.durationS, modes: log.modes, paramChanges: log.paramChanges, theme, showParamChanges: false,
    staticWidth: 1040, register: (id, _t, snap) => { snaps.set(id, snap); return () => undefined; },
  };
  const root = createRoot(host);
  root.render(<FluentProvider theme={webLightTheme}><ChartContext.Provider value={ctx}><PageView page={page} /></ChartContext.Provider></FluentProvider>);
  await new Promise((r) => setTimeout(r, 250));
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const out = new Map<string, string>();
  for (const [id, f] of snaps) { try { const u = f(); if (u) out.set(id, u); } catch { /* ignore */ } }
  root.unmount();
  host.remove();
  return out;
}

function itemHtml(it: PlotSpec, img: Map<string, string>): string {
  switch (it.kind) {
    case 'time': case 'freq': case 'xy': case 'spectrogram': {
      const src = img.get(it.id);
      const legend = 'series' in it ? `<div class="legend">${(it.series as { label: string }[]).map((s) => esc(s.label)).join(' · ')}</div>` : '';
      return `<figure><figcaption>${esc(it.title)}</figcaption>${src ? `<img src="${src}" alt="${esc(it.title)}">` : '<p class="muted">(chart not available)</p>'}${legend}${'note' in it && it.note ? `<p class="muted">${esc(it.note)}</p>` : ''}</figure>`;
    }
    case 'bars':
      return `<figure><figcaption>${esc(it.title)}</figcaption><table><tr>${it.categories.map((c) => `<th>${esc(c)}</th>`).join('')}</tr><tr>${it.values.map((v) => `<td>${v.toFixed(1)}${esc(it.unit ?? '')}</td>`).join('')}</tr></table></figure>`;
    case 'map': return `<p class="muted">Map: see the application (no basemap is embedded in reports).</p>`;
    case 'table':
      return `<figure><figcaption>${esc(it.title)}</figcaption><table><thead><tr>${it.columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${it.rows.map((r, i) => `<tr class="${it.rowTone?.[i] ?? ''}">${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>${it.note ? `<p class="muted">${esc(it.note)}</p>` : ''}</figure>`;
    case 'kv':
      return `<figure><figcaption>${esc(it.title)}</figcaption><dl>${it.items.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>${it.note ? `<p class="muted">${esc(it.note)}</p>` : ''}</figure>`;
    case 'findings':
      return `<figure><figcaption>${esc(it.title)}</figcaption><ul class="findings">${it.items.map((f) => `<li class="${f.tone}"><b>${esc(f.title)}</b>${f.detail ? `<br><span class="muted">${esc(f.detail)}</span>` : ''}</li>`).join('')}</ul></figure>`;
    case 'stats':
      return `<div class="stats">${it.items.map((x) => `<div class="stat ${x.tone ?? ''}"><span class="muted">${esc(x.label)}</span><b>${esc(x.value)}</b>${x.sub ? `<span class="muted">${esc(x.sub)}</span>` : ''}</div>`).join('')}</div>`;
    case 'text':
      return it.mono ? `<figure><figcaption>${esc(it.title ?? '')}</figcaption><pre>${esc(it.text)}</pre></figure>` : `<p class="note ${it.tone ?? ''}">${esc(it.text)}</p>`;
    default: return '';
  }
}

export async function exportReport(log: LogSummary, _theme: ChartTheme) {
  const pages: { title: string; spec: PageSpec }[] = [];
  for (const [key, title] of LOG_ORDER) {
    if (key === 'filters') pages.push({ title, spec: await engine().filters(log.id, { replay: true }) });
    else if (key === 'rateloop') pages.push({ title, spec: await engine().rateLoop(log.id, {}) });
    else pages.push({ title, spec: await getPage(log.id, key) });
  }
  let body = '';
  for (const p of pages) {
    const imgs = await renderCharts(log, p.spec);
    body += `<section class="page"><h1>${esc(p.title)}</h1>`;
    for (const sec of p.spec.sections) {
      body += `<h2>${esc(sec.title)}</h2>${sec.description ? `<p class="muted">${esc(sec.description)}</p>` : ''}`;
      body += sec.items.map((it) => itemHtml(it, imgs)).join('\n');
    }
    body += '</section>';
  }
  const modes = log.modes.map((m) => `<span class="mode" style="border-left:6px solid ${m.color}">${esc(m.name)} ${m.t0.toFixed(0)}–${m.t1.toFixed(0)} s</span>`).join(' ');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(log.fileName)} — flight report</title>
<style>
:root{color-scheme:light;--fg:#242424;--muted:#616161;--line:#e0e0e0;--bg:#fafafa}
body{font:14px/1.45 "Segoe UI Variable Text","Segoe UI",system-ui,sans-serif;color:var(--fg);background:var(--bg);margin:0;padding:24px 32px;max-width:1120px;margin:auto}
h1{font-size:22px;margin:32px 0 8px;border-bottom:2px solid var(--line);padding-bottom:6px}h2{font-size:16px;margin:22px 0 6px}
figure{margin:10px 0 14px;padding:10px 12px;background:#fff;border:1px solid var(--line);border-radius:6px;break-inside:avoid}
figcaption{font-weight:600;margin-bottom:6px}img{max-width:100%;display:block}
table{border-collapse:collapse;width:100%;font-size:12px;font-variant-numeric:tabular-nums}th,td{border-bottom:1px solid var(--line);padding:3px 6px;text-align:left;vertical-align:top}th{background:#f3f3f3}
tr.warning td{background:#fff4ce}tr.danger td{background:#fde7e9}
dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 16px;margin:0}dt{color:var(--muted)}dd{margin:0}
.muted{color:var(--muted);font-size:12px}.legend{color:var(--muted);font-size:12px;margin-top:4px}
ul.findings{list-style:none;padding:0;margin:0}ul.findings li{padding:6px 10px;margin:4px 0;border-left:4px solid #888;background:#f5f5f5}
li.good{border-color:#107c10}li.warning{border-color:#f7630c}li.danger{border-color:#c50f1f}li.info{border-color:#0f6cbd}
.stats{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px;margin:8px 0}.stat{display:flex;flex-direction:column;padding:8px 10px;background:#fff;border:1px solid var(--line);border-radius:6px}.stat b{font-size:18px}
pre{font:12px Consolas,monospace;white-space:pre;overflow:auto;max-height:400px}.mode{display:inline-block;padding:1px 6px;margin:2px;background:#fff;border:1px solid var(--line)}
@media print{body{background:#fff;padding:0}.page{break-before:page}figure{border:none;padding:0}}
</style></head><body>
<header><div class="muted">ULog Studio ${esc(APP_VERSION)} · report generated ${esc(new Date().toLocaleString())}</div>
<h1 style="border:none;margin-top:6px">${esc(log.fileName)}</h1>
<p>${esc(log.swVersion ?? '')} · ${esc(log.hw ?? '')}${log.airframe ? ' · ' + esc(log.airframe) : ''} · duration ${log.durationS.toFixed(0)} s${log.utcStart ? ' · ' + esc(new Date(log.utcStart).toISOString().replace('T', ' ').slice(0, 19)) + ' UTC' : ''}</p>
<p>${modes}</p></header>
${body}
</body></html>`;
  await saveBytes(html, `${log.fileName.replace(/\.ulg$/i, '')}_report.html`, 'text/html');
}

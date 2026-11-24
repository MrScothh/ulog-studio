import { useMemo, useState } from 'react';
import {
  makeStyles, tokens, Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell, SearchBox, Caption1, Text, Body1Strong, mergeClasses,
} from '@fluentui/react-components';
import { CheckmarkCircleFilled, WarningFilled, ErrorCircleFilled, InfoFilled, CircleFilled, ArrowRightRegular } from '@fluentui/react-icons';
import type { PlotSpec, TableSpec, KVSpec, FindingsSpec, StatSpec, TextSpec, FlowSpec, Tone } from '../core/types';
import { TimePlot } from '../charts/TimePlot';
import { FreqPlot } from '../charts/FreqPlot';
import { XYPlot } from '../charts/XYPlot';
import { SpectrogramPlot } from '../charts/SpectrogramPlot';
import { BarChart } from '../charts/BarChart';
import { MapView } from '../charts/MapView';
import { ReplayBar } from './ReplayBar';
import { saveCsv } from '../app/platform';

const useStyles = makeStyles({
  panel: {
    backgroundColor: tokens.colorNeutralBackground1, border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge,
    padding: '10px 12px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '8px',
  },
  head: { display: 'flex', alignItems: 'center', gap: '12px', minHeight: '28px' },
  title: { fontSize: tokens.fontSizeBase300, fontWeight: tokens.fontWeightSemibold, flexGrow: 1 },
  note: { color: tokens.colorNeutralForeground3 },
  tableWrap: { overflow: 'auto', borderTop: `1px solid ${tokens.colorNeutralStroke2}` },
  table: { tableLayout: 'auto', minWidth: '100%' },
  th: { position: 'sticky', top: 0, backgroundColor: tokens.colorNeutralBackground2, zIndex: 1, fontWeight: tokens.fontWeightSemibold, whiteSpace: 'nowrap' },
  td: { verticalAlign: 'top', paddingTop: '4px', paddingBottom: '4px', fontVariantNumeric: 'tabular-nums' },
  firstCol: { fontWeight: tokens.fontWeightSemibold, whiteSpace: 'nowrap' },
  rowWarning: { boxShadow: `inset 3px 0 0 ${tokens.colorPaletteMarigoldBorderActive}` },
  rowDanger: { boxShadow: `inset 3px 0 0 ${tokens.colorPaletteRedBorderActive}` },
  rowGood: { boxShadow: `inset 3px 0 0 ${tokens.colorPaletteGreenBorderActive}` },
  kv: { display: 'grid', gridTemplateColumns: 'minmax(140px, max-content) 1fr', columnGap: '16px', rowGap: '6px', alignItems: 'baseline' },
  kvKey: { color: tokens.colorNeutralForeground3 },
  kvVal: { fontVariantNumeric: 'tabular-nums', overflowWrap: 'anywhere' },
  findings: { display: 'flex', flexDirection: 'column', gap: '6px' },
  finding: { display: 'flex', gap: '10px', alignItems: 'flex-start', padding: '8px 10px', borderRadius: tokens.borderRadiusMedium, backgroundColor: tokens.colorNeutralBackground2 },
  fIcon: { fontSize: '18px', flexShrink: 0, marginTop: '1px' },
  fText: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 },
  fDetail: { color: tokens.colorNeutralForeground2, overflowWrap: 'anywhere' },
  clamp: { display: '-webkit-box', WebkitLineClamp: '1', WebkitBoxOrient: 'vertical', overflow: 'hidden' },
  fClickable: { cursor: 'pointer', ':hover': { backgroundColor: tokens.colorNeutralBackground2Hover } },
  stats: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '8px' },
  stat: { padding: '10px 12px', borderRadius: tokens.borderRadiusLarge, border: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground1, display: 'flex', flexDirection: 'column', gap: '2px' },
  statLabel: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200 },
  statValue: { fontSize: tokens.fontSizeBase500, fontWeight: tokens.fontWeightSemibold, fontVariantNumeric: 'tabular-nums', display: 'flex', alignItems: 'center', gap: '6px' },
  pre: { fontFamily: tokens.fontFamilyMonospace, fontSize: tokens.fontSizeBase200, whiteSpace: 'pre', overflow: 'auto', maxHeight: '320px', margin: 0, color: tokens.colorNeutralForeground2 },
  textTone: { padding: '10px 12px', borderRadius: tokens.borderRadiusMedium, backgroundColor: tokens.colorNeutralBackground2, display: 'flex', gap: '10px', alignItems: 'flex-start' },
  textBody: { whiteSpace: 'pre-line', maxWidth: '120ch' },
  lanes: { display: 'flex', flexDirection: 'column', gap: '10px' },
  lane: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
  laneLabel: { width: '92px', flexShrink: 0, color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200, fontWeight: tokens.fontWeightSemibold },
  steps: { display: 'flex', alignItems: 'stretch', gap: '6px', flexWrap: 'wrap', flexGrow: 1, minWidth: 0 },
  stepWrap: { display: 'flex', alignItems: 'center', gap: '6px' },
  step: {
    display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: '1px', padding: '6px 10px', minHeight: '40px',
    borderRadius: tokens.borderRadiusMedium, border: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground2,
  },
  stepEnd: { backgroundColor: tokens.colorBrandBackground2, border: `1px solid ${tokens.colorBrandStroke2}` },
  stepOff: { backgroundColor: 'transparent', border: `1px dashed ${tokens.colorNeutralStroke1}`, color: tokens.colorNeutralForeground3 },
  stepTitle: { fontSize: tokens.fontSizeBase300, fontWeight: tokens.fontWeightSemibold, whiteSpace: 'nowrap' },
  stepSub: { color: tokens.colorNeutralForeground3, fontSize: tokens.fontSizeBase200, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' },
  arrow: { color: tokens.colorNeutralForeground4, flexShrink: 0 },
});

export function toneIcon(tone: Tone | undefined, className?: string) {
  switch (tone) {
    case 'good': return <CheckmarkCircleFilled className={className} style={{ color: tokens.colorPaletteGreenForeground1 }} aria-label="OK" />;
    case 'warning': return <WarningFilled className={className} style={{ color: tokens.colorPaletteMarigoldForeground1 }} aria-label="Warning" />;
    case 'danger': return <ErrorCircleFilled className={className} style={{ color: tokens.colorPaletteRedForeground1 }} aria-label="Problem" />;
    case 'info': return <InfoFilled className={className} style={{ color: tokens.colorBrandForeground1 }} aria-label="Info" />;
    default: return <CircleFilled className={className} style={{ color: tokens.colorNeutralForeground4 }} aria-hidden />;
  }
}

function TableView({ spec }: { spec: TableSpec }) {
  const s = useStyles();
  const [q, setQ] = useState('');
  const rows = useMemo(() => {
    const idx = spec.rows.map((_, i) => i);
    if (!q.trim()) return idx;
    const ql = q.toLowerCase();
    return idx.filter((i) => spec.rows[i].some((c) => c !== null && String(c).toLowerCase().includes(ql)));
  }, [spec, q]);
  const limit = 3000;
  const csv = () => saveCsv([spec.columns, ...spec.rows].map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n'), `${spec.id}.csv`);
  return (
    <section className={s.panel} aria-label={spec.title}>
      <div className={s.head}>
        <span className={s.title}>{spec.title}</span>
        {spec.searchable && <SearchBox size="small" placeholder="Filter…" value={q} onChange={(_, d) => setQ(d.value)} style={{ width: 220 }} />}
        <Caption1 as="span" style={{ cursor: 'pointer', color: tokens.colorBrandForeground1 }} onClick={csv} role="button" tabIndex={0}>CSV</Caption1>
      </div>
      <div className={s.tableWrap} style={{ maxHeight: spec.maxHeight ?? 'none' }}>
        <Table size="extra-small" className={s.table} aria-label={spec.title}>
          <TableHeader>
            <TableRow>{spec.columns.map((c, i) => <TableHeaderCell key={i} className={s.th}>{c}</TableHeaderCell>)}</TableRow>
          </TableHeader>
          <TableBody>
            {rows.slice(0, limit).map((ri) => {
              const tone = spec.rowTone?.[ri];
              return (
                <TableRow key={ri} className={tone === 'warning' ? s.rowWarning : tone === 'danger' ? s.rowDanger : tone === 'good' ? s.rowGood : undefined}>
                  {spec.rows[ri].map((c, ci) => <TableCell key={ci} className={mergeClasses(s.td, ci === 0 && s.firstCol)}>{c === null ? '' : String(c)}</TableCell>)}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      {(spec.note || rows.length > limit) && <Caption1 className={s.note}>{spec.note}{rows.length > limit ? ` (showing ${limit} of ${rows.length})` : ''}</Caption1>}
    </section>
  );
}

function KVView({ spec }: { spec: KVSpec }) {
  const s = useStyles();
  return (
    <section className={s.panel} aria-label={spec.title}>
      <div className={s.head}><span className={s.title}>{spec.title}</span></div>
      <div className={s.kv}>
        {spec.items.map(([k, v], i) => (
          <div key={i} style={{ display: 'contents' }}>
            <Text className={s.kvKey}>{k}</Text>
            <Text className={s.kvVal}>{v}</Text>
          </div>
        ))}
      </div>
      {spec.note && <Caption1 className={s.note}>{spec.note}</Caption1>}
    </section>
  );
}

function FindingsView({ spec }: { spec: FindingsSpec }) {
  const s = useStyles();
  const [open, setOpen] = useState<Set<number>>(new Set());
  const toggle = (i: number) => setOpen((o) => { const n = new Set(o); if (n.has(i)) n.delete(i); else n.add(i); return n; });
  return (
    <section className={s.panel} aria-label={spec.title}>
      <div className={s.head}><span className={s.title}>{spec.title}</span></div>
      <div className={s.findings}>
        {spec.items.map((f, i) => (
          <div key={i} className={mergeClasses(s.finding, f.detail && s.fClickable)} onClick={() => f.detail && toggle(i)} role={f.detail ? 'button' : undefined} tabIndex={f.detail ? 0 : undefined} aria-expanded={f.detail ? open.has(i) : undefined}>
            {toneIcon(f.tone, s.fIcon)}
            <div className={s.fText}>
              <Body1Strong>{f.title}</Body1Strong>
              {f.detail && <Caption1 className={mergeClasses(s.fDetail, !open.has(i) && s.clamp)}>{f.detail}</Caption1>}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function StatsView({ spec }: { spec: StatSpec }) {
  const s = useStyles();
  return (
    <div className={s.stats}>
      {spec.items.map((it, i) => (
        <div key={i} className={s.stat}>
          <span className={s.statLabel}>{it.label}</span>
          <span className={s.statValue}>{it.tone && toneIcon(it.tone)}{it.value}</span>
          {it.sub && <Caption1 className={s.note}>{it.sub}</Caption1>}
        </div>
      ))}
    </div>
  );
}

function TextView({ spec }: { spec: TextSpec }) {
  const s = useStyles();
  if (spec.mono) {
    return (
      <section className={s.panel} aria-label={spec.title}>
        {spec.title && <div className={s.head}><span className={s.title}>{spec.title}</span></div>}
        <pre className={s.pre}>{spec.text}</pre>
      </section>
    );
  }
  return (
    <div className={s.textTone}>
      {toneIcon(spec.tone ?? 'info', s.fIcon)}
      <div className={s.fText}>
        {spec.title && <Body1Strong>{spec.title}</Body1Strong>}
        <Text className={s.textBody}>{spec.text}</Text>
      </div>
    </div>
  );
}

function FlowView({ spec }: { spec: FlowSpec }) {
  const s = useStyles();
  return (
    <section className={s.panel} aria-label={spec.title}>
      <div className={s.head}><span className={s.title}>{spec.title}</span></div>
      <div className={s.lanes}>
        {spec.lanes.map((lane, li) => (
          <div key={li} className={s.lane}>
            <span className={s.laneLabel}>{lane.label}</span>
            <div className={s.steps}>
              {lane.steps.map((st, i) => (
                <div key={i} className={s.stepWrap}>
                  {i > 0 && <ArrowRightRegular className={s.arrow} aria-hidden />}
                  <div className={mergeClasses(s.step, (st.kind === 'source' || st.kind === 'sink') && s.stepEnd, st.kind === 'off' && s.stepOff)}>
                    <span className={s.stepTitle}>{st.title}</span>
                    {st.sub && <span className={s.stepSub}>{st.sub}</span>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      {spec.note && <Caption1 className={s.note}>{spec.note}</Caption1>}
    </section>
  );
}

export function SpecItem({ spec }: { spec: PlotSpec }) {
  switch (spec.kind) {
    case 'time': return <TimePlot spec={spec} />;
    case 'freq': return <FreqPlot spec={spec} />;
    case 'xy': return <XYPlot spec={spec} />;
    case 'spectrogram': return <SpectrogramPlot spec={spec} />;
    case 'bars': return <BarChart spec={spec} />;
    case 'map': return <MapView spec={spec} />;
    case 'replay': return <ReplayBar spec={spec} />;
    case 'table': return <TableView spec={spec} />;
    case 'kv': return <KVView spec={spec} />;
    case 'findings': return <FindingsView spec={spec} />;
    case 'stats': return <StatsView spec={spec} />;
    case 'text': return <TextView spec={spec} />;
    case 'flow': return <FlowView spec={spec} />;
    default: return null;
  }
}

/** Items that look better side by side on wide screens. */
export function isHalfWidth(spec: PlotSpec): boolean {
  return spec.kind === 'kv' || spec.kind === 'bars' || spec.kind === 'map' || spec.kind === 'xy' || (spec.kind === 'freq' && !spec.id.startsWith('bode') && !spec.id.startsWith('step-plot') && !spec.id.startsWith('fft') && !spec.id.startsWith('filt') && !spec.id.startsWith('full-'));
}

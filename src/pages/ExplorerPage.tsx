import { useEffect, useMemo, useState } from 'react';
import { makeStyles, tokens, SearchBox, Button, Caption1, Tooltip, Badge, Spinner } from '@fluentui/react-components';
import { AddRegular, DeleteRegular, DismissRegular, ChevronRightRegular, ChevronDownRegular } from '@fluentui/react-icons';
import type { LogSummary, TimePlotSpec } from '../core/types';
import type { TopicMeta } from '../core/ulog';
import { engine } from '../app/engineClient';
import { TimePlot } from '../charts/TimePlot';

const useStyles = makeStyles({
  root: { display: 'grid', gridTemplateColumns: '300px minmax(0, 1fr)', gap: '16px', alignItems: 'start' },
  tree: { position: 'sticky', top: '0px', maxHeight: 'calc(100vh - 170px)', display: 'flex', flexDirection: 'column', gap: '8px', border: `1px solid ${tokens.colorNeutralStroke2}`, borderRadius: tokens.borderRadiusLarge, backgroundColor: tokens.colorNeutralBackground1, padding: '10px' },
  list: { overflow: 'auto', display: 'flex', flexDirection: 'column' },
  topic: { display: 'flex', alignItems: 'center', gap: '4px', padding: '3px 4px', borderRadius: tokens.borderRadiusMedium, cursor: 'pointer', ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover } },
  topicName: { flexGrow: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: tokens.fontSizeBase200 },
  field: { padding: '2px 6px 2px 26px', borderRadius: tokens.borderRadiusMedium, cursor: 'grab', fontSize: tokens.fontSizeBase200, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover } },
  panels: { display: 'flex', flexDirection: 'column', gap: '12px' },
  panel: { border: `1px dashed ${tokens.colorNeutralStroke1}`, borderRadius: tokens.borderRadiusLarge, padding: '8px', display: 'flex', flexDirection: 'column', gap: '6px' },
  active: { border: `1px solid ${tokens.colorBrandStroke1}` },
  chips: { display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' },
  empty: { padding: '28px', textAlign: 'center', color: tokens.colorNeutralForeground3 },
});

interface Panel { id: number; fields: { topic: string; field: string }[] }

/** PlotJuggler-style free plotting: pick or drag any logged field onto a panel. */
export function ExplorerPage({ log }: { log: LogSummary }) {
  const s = useStyles();
  const [topics, setTopics] = useState<TopicMeta[] | null>(null);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [panels, setPanels] = useState<Panel[]>([{ id: 1, fields: [] }]);
  const [activePanel, setActive] = useState(1);
  const [data, setData] = useState<Map<string, { t: Float64Array; y: Float32Array }>>(new Map());

  useEffect(() => { setTopics(null); engine().topics(log.id).then(setTopics); setPanels([{ id: 1, fields: [] }]); setData(new Map()); }, [log.id]);

  const filtered = useMemo(() => {
    if (!topics) return [];
    const ql = q.toLowerCase().trim();
    if (!ql) return topics.map((t) => ({ t, fields: t.fields }));
    return topics.map((t) => ({ t, fields: t.key.toLowerCase().includes(ql) ? t.fields : t.fields.filter((f) => `${t.key}.${f}`.toLowerCase().includes(ql)) })).filter((x) => x.fields.length);
  }, [topics, q]);

  const add = async (panelId: number, topic: string, field: string) => {
    const key = `${topic}/${field}`;
    if (!data.has(key)) {
      const r = await engine().series(log.id, topic, field);
      if (!r) return;
      setData((m) => new Map(m).set(key, r));
    }
    setPanels((ps) => ps.map((p) => (p.id === panelId && !p.fields.some((f) => f.topic === topic && f.field === field) ? { ...p, fields: [...p.fields, { topic, field }] } : p)));
  };

  const specs = useMemo(() => panels.map((p): TimePlotSpec | null => {
    const series = p.fields.map((f, i) => { const d = data.get(`${f.topic}/${f.field}`); return d ? { label: `${f.topic}.${f.field}`, t: d.t, y: d.y, color: i % 8 } : null; }).filter((x): x is NonNullable<typeof x> => !!x);
    return series.length ? { kind: 'time', id: `explorer-${p.id}`, title: `Panel ${p.id}`, series, height: 260 } : null;
  }), [panels, data]);

  if (!topics) return <Spinner label="Listing topics…" />;
  return (
    <div className={s.root}>
      <aside className={s.tree} aria-label="Logged topics">
        <SearchBox size="small" placeholder={`Search ${topics.length} topics / fields`} value={q} onChange={(_, d) => setQ(d.value)} />
        <Caption1 style={{ color: tokens.colorNeutralForeground3 }}>Click a field to add it to the selected panel, or drag it onto any panel.</Caption1>
        <div className={s.list}>
          {filtered.map(({ t, fields }) => {
            const isOpen = open.has(t.key) || (!!q && fields.length < 40);
            return (
              <div key={t.key}>
                <div className={s.topic} onClick={() => setOpen((o) => { const n = new Set(o); if (n.has(t.key)) n.delete(t.key); else n.add(t.key); return n; })}>
                  {isOpen ? <ChevronDownRegular /> : <ChevronRightRegular />}
                  <span className={s.topicName} title={t.key}>{t.key}</span>
                  <Tooltip relationship="label" content={`${t.count} messages, ${t.rate.toFixed(1)} Hz`}><Badge size="small" appearance="tint" color={t.rate >= 100 ? 'brand' : 'informative'}>{t.rate >= 10 ? t.rate.toFixed(0) : t.rate.toFixed(1)} Hz</Badge></Tooltip>
                </div>
                {isOpen && fields.filter((f) => f !== 'timestamp').map((f) => (
                  <div key={f} className={s.field} draggable title={`${t.key}.${f}`}
                    onDragStart={(e) => e.dataTransfer.setData('application/x-ulog-field', JSON.stringify({ topic: t.key, field: f }))}
                    onClick={() => void add(activePanel, t.key, f)}>{f}</div>
                ))}
              </div>
            );
          })}
        </div>
      </aside>
      <div className={s.panels}>
        {panels.map((p, idx) => (
          <div key={p.id} className={`${s.panel} ${p.id === activePanel ? s.active : ''}`} onClick={() => setActive(p.id)}
            onDragOver={(e) => { if (e.dataTransfer.types.includes('application/x-ulog-field')) e.preventDefault(); }}
            onDrop={(e) => { const raw = e.dataTransfer.getData('application/x-ulog-field'); if (raw) { e.preventDefault(); e.stopPropagation(); const f = JSON.parse(raw); void add(p.id, f.topic, f.field); } }}>
            <div className={s.chips}>
              {p.fields.map((f) => (
                <Badge key={`${f.topic}.${f.field}`} appearance="outline" shape="rounded" icon={<DismissRegular />} iconPosition="after"
                  style={{ cursor: 'pointer' }} onClick={(e) => { e.stopPropagation(); setPanels((ps) => ps.map((x) => (x.id === p.id ? { ...x, fields: x.fields.filter((y) => y !== f) } : x))); }}>{f.topic}.{f.field}</Badge>
              ))}
              <span style={{ flexGrow: 1 }} />
              {panels.length > 1 && <Tooltip relationship="label" content="Remove panel"><Button size="small" appearance="subtle" icon={<DeleteRegular />} onClick={(e) => { e.stopPropagation(); setPanels((ps) => ps.filter((x) => x.id !== p.id)); }} /></Tooltip>}
            </div>
            {specs[idx] ? <TimePlot spec={specs[idx]!} /> : <div className={s.empty}>Drop fields here or click them in the list{p.id === activePanel ? ' (this panel is selected)' : ''}.</div>}
          </div>
        ))}
        <Button icon={<AddRegular />} onClick={() => { const id = Math.max(...panels.map((p) => p.id)) + 1; setPanels([...panels, { id, fields: [] }]); setActive(id); }} style={{ alignSelf: 'flex-start' }}>Add panel</Button>
      </div>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { makeStyles, tokens, Subtitle2, Caption1, mergeClasses, Button } from '@fluentui/react-components';
import { ChevronDownRegular, ChevronRightRegular } from '@fluentui/react-icons';
import type { PageSpec, Section } from '../core/types';
import { SpecItem, isHalfWidth } from './SpecRenderer';
import { prefs } from '../app/prefs';

const useStyles = makeStyles({
  page: { display: 'flex', flexDirection: 'column', gap: '22px' },
  jump: { display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' },
  section: { display: 'flex', flexDirection: 'column', gap: '10px', scrollMarginTop: '230px' },
  head: { display: 'flex', alignItems: 'flex-start', gap: '4px', cursor: 'pointer', borderRadius: tokens.borderRadiusMedium, marginLeft: '-6px', padding: '2px 6px', ':hover': { backgroundColor: tokens.colorSubtleBackgroundHover } },
  headText: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 },
  chev: { marginTop: '3px', color: tokens.colorNeutralForeground3, flexShrink: 0 },
  desc: { color: tokens.colorNeutralForeground3, maxWidth: '110ch' },
  count: { color: tokens.colorNeutralForeground3, marginLeft: '6px', fontWeight: tokens.fontWeightRegular },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '12px', '@media (max-width: 1100px)': { gridTemplateColumns: 'minmax(0, 1fr)' } },
  full: { gridColumn: '1 / -1' },
  empty: { color: tokens.colorNeutralForeground3 },
});

const collapsedKey = (pageId: string, secId: string) => `collapsed:${pageId}:${secId}`;

export function SectionView({ section, pageId }: { section: Section; pageId?: string }) {
  const s = useStyles();
  const key = pageId ? collapsedKey(pageId, section.id) : '';
  const [collapsed, setCollapsed] = useState<boolean>(key ? prefs.get(key, section.collapsed ?? false) : section.collapsed ?? false);
  const toggle = () => { setCollapsed(!collapsed); if (key) prefs.set(key, !collapsed); };
  // "Jump to" opens a collapsed section
  useEffect(() => {
    const on = (e: Event) => { if ((e as CustomEvent<string>).detail === section.id) setCollapsed(false); };
    window.addEventListener('ulog-open-section', on);
    return () => window.removeEventListener('ulog-open-section', on);
  }, [section.id]);
  const charts = section.items.filter((i) => ['time', 'freq', 'xy', 'spectrogram', 'map', 'bars'].includes(i.kind)).length;
  return (
    <section id={`sec-${section.id}`} className={s.section}>
      <div className={s.head} onClick={toggle} role="button" tabIndex={0} aria-expanded={!collapsed} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } }}>
        {collapsed ? <ChevronRightRegular className={s.chev} /> : <ChevronDownRegular className={s.chev} />}
        <div className={s.headText}>
          <Subtitle2 as="h2" style={{ margin: 0 }}>{section.title}{collapsed && charts > 0 && <span className={s.count}>· {charts} chart{charts === 1 ? '' : 's'}</span>}</Subtitle2>
          {section.description && !collapsed && <Caption1 className={s.desc}>{section.description}</Caption1>}
        </div>
      </div>
      {!collapsed && (section.items.length ? (
        <div className={s.grid}>
          {section.items.map((it) => <div key={it.id} className={mergeClasses(!isHalfWidth(it) && s.full)} style={{ minWidth: 0 }}><SpecItem spec={it} /></div>)}
        </div>
      ) : <Caption1 className={s.empty}>No data for this section in the log.</Caption1>)}
    </section>
  );
}

/** Page = sections; with three or more sections a "Jump to" bar scrolls straight to one (navigation, not a filter). */
export function PageView({ page }: { page: PageSpec }) {
  const s = useStyles();
  const jump = (id: string) => {
    window.dispatchEvent(new CustomEvent('ulog-open-section', { detail: id }));
    requestAnimationFrame(() => document.getElementById(`sec-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };
  return (
    <div className={s.page}>
      {page.sections.length >= 3 && (
        <nav className={s.jump} aria-label="Sections">
          <Caption1 className={s.empty} style={{ marginRight: 4 }}>Jump to</Caption1>
          {page.sections.map((sec) => (
            <Button key={sec.id} size="small" shape="circular" appearance="outline" onClick={() => jump(sec.id)}>{sec.title}</Button>
          ))}
        </nav>
      )}
      {page.sections.map((sec) => <SectionView key={sec.id} section={sec} pageId={page.id} />)}
    </div>
  );
}

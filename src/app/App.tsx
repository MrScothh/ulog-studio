import iconUrl from '../assets/icon.svg';
import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import {
  FluentProvider, webLightTheme, webDarkTheme, makeStyles, tokens, Button, Tooltip, Tab, TabList, Menu, MenuTrigger, MenuPopover, MenuList, MenuItemRadio,
  NavDrawer, NavDrawerBody, NavItem, NavSectionHeader, NavDivider, Hamburger, Title3, Caption1, Badge, MessageBar, MessageBarBody, MessageBarActions, Spinner, Subtitle1, Body1, Switch, Text, mergeClasses,
} from '@fluentui/react-components';
import {
  FolderOpenRegular, DismissRegular, WeatherMoonRegular, WeatherSunnyRegular, DesktopRegular, DocumentArrowDownRegular,
  HomeRegular, TargetArrowRegular, FlashRegular, PulseSquareRegular, FilterRegular, BranchForkRegular, BatteryChargeRegular, LocationRegular,
  ServerRegular, OptionsRegular, ChatRegular, DataTrendingRegular, BranchCompareRegular, DocumentTableRegular, ArrowDownloadRegular,
} from '@fluentui/react-icons';
import { useStore, store, openFiles, closeLog, setTheme, setNavOpen, dismissLoading, PageKey, ThemePref } from './store';
import { chartTheme } from '../charts/theme';
import { ChartContext, ChartCtx } from '../charts/ChartContext';
import { StandardPage } from '../pages/StandardPage';
import { FiltersPage } from '../pages/FiltersPage';
import { RateLoopPage } from '../pages/RateLoopPage';
import { ExplorerPage } from '../pages/ExplorerPage';
import { ComparePage, ParamDiffPage } from '../pages/ComparePage';
import { FlightTimeline } from '../components/FlightTimeline';
import { Welcome } from './Welcome';
import { UpdateButton } from './Updates';
import { exportReport } from '../report/report';
import { APP_VERSION, initialFiles, isTauri } from './platform';
import { fmtTime } from '../charts/theme';

const PAGES: { key: PageKey; label: string; icon: React.ReactElement; group: string; time?: boolean; global?: boolean }[] = [
  { key: 'overview', label: 'Overview', icon: <HomeRegular />, group: 'Flight' },
  { key: 'tracking', label: 'Tracking', icon: <TargetArrowRegular />, group: 'Flight', time: true },
  { key: 'actuators', label: 'Actuators', icon: <FlashRegular />, group: 'Flight', time: true },
  { key: 'vibration', label: 'Vibration', icon: <PulseSquareRegular />, group: 'Flight', time: true },
  { key: 'power', label: 'Power', icon: <BatteryChargeRegular />, group: 'Flight', time: true },
  { key: 'sensors', label: 'GPS & estimator', icon: <LocationRegular />, group: 'Flight', time: true },
  { key: 'system', label: 'System', icon: <ServerRegular />, group: 'Flight', time: true },
  { key: 'filters', label: 'Gyro filters', icon: <FilterRegular />, group: 'Tuning' },
  { key: 'rateloop', label: 'Rate loop', icon: <BranchForkRegular />, group: 'Tuning' },
  { key: 'params', label: 'Parameters', icon: <OptionsRegular />, group: 'Data' },
  { key: 'messages', label: 'Messages & events', icon: <ChatRegular />, group: 'Data' },
  { key: 'explorer', label: 'Explorer', icon: <DataTrendingRegular />, group: 'Data', time: true },
  { key: 'compare', label: 'Compare flights', icon: <BranchCompareRegular />, group: 'Multiple logs', global: true },
  { key: 'pdiff', label: 'Parameter diff', icon: <DocumentTableRegular />, group: 'Multiple logs', global: true },
];

const useStyles = makeStyles({
  root: { height: '100vh', display: 'flex', flexDirection: 'column', backgroundColor: tokens.colorNeutralBackground2, color: tokens.colorNeutralForeground1 },
  top: { height: '48px', flexShrink: 0, display: 'flex', alignItems: 'center', gap: '8px', padding: '0 8px 0 4px', backgroundColor: tokens.colorNeutralBackground1, borderBottom: `1px solid ${tokens.colorNeutralStroke2}` },
  brand: { display: 'flex', alignItems: 'center', gap: '8px', paddingRight: '8px', whiteSpace: 'nowrap', fontWeight: tokens.fontWeightSemibold, fontSize: tokens.fontSizeBase300 },
  tabs: { flexGrow: 1, minWidth: 0, overflowX: 'auto', overflowY: 'hidden', scrollbarWidth: 'thin' },
  tab: { maxWidth: '260px' },
  tabInner: { display: 'flex', alignItems: 'center', gap: '6px' },
  tabClose: { minWidth: '20px', height: '20px', padding: 0 },
  right: { display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0 },
  body: { flexGrow: 1, display: 'flex', minHeight: 0 },
  nav: { height: '100%', borderRight: `1px solid ${tokens.colorNeutralStroke2}`, width: '240px', minWidth: '240px', flexShrink: 0 },
  // compact icon rail for narrow windows (the full menu opens from the hamburger)
  rail: { width: '52px', flexShrink: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px', padding: '8px 0', overflowY: 'auto', borderRight: `1px solid ${tokens.colorNeutralStroke2}`, backgroundColor: tokens.colorNeutralBackground2 },
  railSep: { width: '28px', height: '1px', backgroundColor: tokens.colorNeutralStroke2, margin: '4px 0' },
  railBtn: { minWidth: '40px', width: '40px', height: '36px', position: 'relative' },
  railOn: { backgroundColor: tokens.colorSubtleBackgroundSelected, '::before': { content: '""', position: 'absolute', left: '-6px', top: '9px', bottom: '9px', width: '3px', borderRadius: '2px', backgroundColor: tokens.colorCompoundBrandStroke } },
  main: { flexGrow: 1, minWidth: 0, overflowY: 'auto', overflowX: 'hidden', scrollbarGutter: 'stable' },
  mainInner: { maxWidth: '1680px', margin: '0 auto', padding: '16px 24px 48px 24px', display: 'flex', flexDirection: 'column', gap: '16px' },
  header: { display: 'flex', flexDirection: 'column', gap: '10px', position: 'sticky', top: 0, zIndex: 5, backgroundColor: tokens.colorNeutralBackground2, padding: '12px 0 10px 0', marginTop: '-16px' },
  headRow: { display: 'flex', alignItems: 'baseline', gap: '6px 14px', flexWrap: 'wrap', minWidth: 0 },
  timeline: { padding: '10px 12px 6px 12px', boxShadow: tokens.shadow2, borderRadius: tokens.borderRadiusLarge, backgroundColor: tokens.colorNeutralBackground1, border: `1px solid ${tokens.colorNeutralStroke2}` },
  meta: { color: tokens.colorNeutralForeground3 },
  drop: { position: 'fixed', inset: 0, zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(15,108,189,0.12)', border: `3px dashed ${tokens.colorBrandStroke1}`, pointerEvents: 'none' },
  dropCard: { padding: '24px 32px', borderRadius: tokens.borderRadiusXLarge, backgroundColor: tokens.colorNeutralBackground1, boxShadow: tokens.shadow16 },
  loading: { display: 'flex', flexDirection: 'column', gap: '6px' },
});

function useNarrow(): boolean {
  const q = '(max-width: 1100px)';
  const [n, setN] = useState(() => window.matchMedia?.(q).matches ?? false);
  useEffect(() => {
    const m = window.matchMedia?.(q);
    if (!m) return;
    const f = () => setN(m.matches);
    m.addEventListener('change', f);
    return () => m.removeEventListener('change', f);
  }, []);
  return n;
}

function useSystemDark(): boolean {
  const [d, setD] = useState(() => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false);
  useEffect(() => {
    const m = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!m) return;
    const f = () => setD(m.matches);
    m.addEventListener('change', f);
    return () => m.removeEventListener('change', f);
  }, []);
  return d;
}

export async function filesFromList(list: FileList | File[]) {
  const arr = Array.from(list);
  await openFiles(arr.map((f) => ({ name: f.name, data: () => f.arrayBuffer() })));
}

export function App() {
  const s = useStyles();
  const themePref = useStore((x) => x.theme);
  const sysDark = useSystemDark();
  const dark = themePref === 'dark' || (themePref === 'system' && sysDark);
  const logs = useStore((x) => x.logs);
  const activeId = useStore((x) => x.activeId);
  const page = useStore((x) => x.page);
  const loading = useStore((x) => x.loading);
  const navOpen = useStore((x) => x.navOpen);
  const showParamChanges = useStore((x) => x.showParamChanges);
  const paramFiles = useStore((x) => x.paramFiles);
  const active = logs.find((l) => l.id === activeId);
  // narrow windows (e.g. 150 % scaling on a laptop): the navigation becomes an overlay so charts keep the width
  const narrow = useNarrow();
  const [overlayOpen, setOverlayOpen] = useState(false);
  const navVisible = narrow ? overlayOpen : navOpen;
  const [dragging, setDragging] = useState(false);
  const [reportBusy, setReportBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const dragDepth = useRef(0);

  useEffect(() => { document.documentElement.style.colorScheme = dark ? 'dark' : 'light'; document.documentElement.dataset.theme = dark ? 'dark' : 'light'; }, [dark]);
  useEffect(() => { void initialFiles().then((f) => { if (f.length) void openFiles(f); }); }, []);
  useEffect(() => { mainRef.current?.scrollTo({ top: 0 }); }, [page, activeId]);

  const ct = useMemo(() => chartTheme(dark), [dark]);
  const ctx: ChartCtx | null = useMemo(() => active ? ({ logId: active.id, duration: active.durationS, modes: active.modes, paramChanges: active.paramChanges, theme: ct, showParamChanges }) : null, [active, ct, showParamChanges]);
  const pageDef = PAGES.find((p) => p.key === page)!;

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); dragDepth.current = 0; setDragging(false);
    if (e.dataTransfer.files?.length) void filesFromList(e.dataTransfer.files);
  }, []);

  const doReport = async () => {
    if (!active) return;
    setReportBusy(true);
    try { await exportReport(active, ct); } finally { setReportBusy(false); }
  };

  const themeIcon = themePref === 'dark' ? <WeatherMoonRegular /> : themePref === 'light' ? <WeatherSunnyRegular /> : <DesktopRegular />;
  return (
    <FluentProvider theme={dark ? webDarkTheme : webLightTheme} style={{ background: 'transparent' }}>
      <div className={s.root}
        onDragEnter={(e) => { if (e.dataTransfer.types.includes('Files')) { dragDepth.current++; setDragging(true); } }}
        onDragLeave={() => { dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDragging(false); }}
        onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); }}
        onDrop={onDrop}>
        <header className={s.top}>
          <Hamburger onClick={() => (narrow ? setOverlayOpen(!overlayOpen) : setNavOpen(!navOpen))} aria-label="Toggle navigation" />
          <div className={s.brand}><img src={iconUrl} width={20} height={20} alt="" />ULog Studio</div>
          <Tooltip content="Open .ulg logs or QGroundControl .params files (or drop them anywhere)" relationship="description">
            <Button appearance="primary" icon={<FolderOpenRegular />} onClick={() => fileInput.current?.click()}>Open</Button>
          </Tooltip>
          <input ref={fileInput} type="file" multiple accept=".ulg,.params,.txt" hidden onChange={(e) => { if (e.target.files) void filesFromList(e.target.files); e.target.value = ''; }} />
          <div className={s.tabs}>
            {logs.length > 0 && (
              <TabList size="small" selectedValue={activeId} onTabSelect={(_, d) => store.set({ activeId: d.value as string, page: pageDef.global ? 'overview' : page })}>
                {logs.map((l) => (
                  <Tab key={l.id} value={l.id} className={s.tab}>
                    <span className={s.tabInner} title={`${l.fileName} — ${l.swVersion ?? ''} ${l.hw ?? ''}`}>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.fileName.replace(/\.ulg$/i, '')}</span>
                      <Button as="a" size="small" appearance="transparent" className={s.tabClose} icon={<DismissRegular fontSize={12} />} aria-label={`Close ${l.fileName}`} onClick={(e) => { e.stopPropagation(); closeLog(l.id); }} />
                    </span>
                  </Tab>
                ))}
              </TabList>
            )}
          </div>
          <div className={s.right}>
            {active && (
              <Tooltip content="Export an HTML report of this flight (all pages, charts as images)" relationship="description">
                <Button appearance="subtle" icon={reportBusy ? <Spinner size="tiny" /> : <DocumentArrowDownRegular />} disabled={reportBusy} onClick={doReport}>Report</Button>
              </Tooltip>
            )}
            {isTauri && <UpdateButton />}
            <Menu>
              <MenuTrigger disableButtonEnhancement>
                <Tooltip content="Theme" relationship="label"><Button appearance="subtle" icon={themeIcon} /></Tooltip>
              </MenuTrigger>
              <MenuPopover>
                <MenuList checkedValues={{ theme: [themePref] }} onCheckedValueChange={(_, d) => setTheme(d.checkedItems[0] as ThemePref)}>
                  <MenuItemRadio name="theme" value="system" icon={<DesktopRegular />}>Use system setting</MenuItemRadio>
                  <MenuItemRadio name="theme" value="light" icon={<WeatherSunnyRegular />}>Light</MenuItemRadio>
                  <MenuItemRadio name="theme" value="dark" icon={<WeatherMoonRegular />}>Dark</MenuItemRadio>
                </MenuList>
              </MenuPopover>
            </Menu>
          </div>
        </header>
        <div className={s.body}>
          {(logs.length > 0 || paramFiles.length > 0) && narrow && !overlayOpen && (
            <nav className={s.rail} aria-label="Sections">
              {['Flight', 'Tuning', 'Data', 'Multiple logs'].map((g, gi) => (
                <div key={g} style={{ display: 'contents' }}>
                  {gi > 0 && <div className={s.railSep} />}
                  {PAGES.filter((p) => p.group === g).map((p) => (
                    <Tooltip key={p.key} content={p.label} relationship="label" positioning="after">
                      <Button appearance="subtle" icon={p.icon} className={mergeClasses(s.railBtn, page === p.key && s.railOn)} aria-current={page === p.key ? 'page' : undefined} onClick={() => store.set({ page: p.key })} />
                    </Tooltip>
                  ))}
                </div>
              ))}
            </nav>
          )}
          {(logs.length > 0 || paramFiles.length > 0) && (
            <NavDrawer open={navVisible} type={narrow ? 'overlay' : 'inline'} onOpenChange={(_, d) => { if (narrow) setOverlayOpen(d.open); }} surfaceMotion={narrow ? undefined : null}
              selectedValue={page} onNavItemSelect={(_, d) => { store.set({ page: d.value as PageKey }); if (narrow) setOverlayOpen(false); }} className={s.nav} size="small">
              <NavDrawerBody>
                {['Flight', 'Tuning', 'Data', 'Multiple logs'].map((g, gi) => (
                  <div key={g}>
                    {gi > 0 && <NavDivider />}
                    <NavSectionHeader>{g}</NavSectionHeader>
                    {PAGES.filter((p) => p.group === g).map((p) => <NavItem key={p.key} value={p.key} icon={p.icon}>{p.label}</NavItem>)}
                  </div>
                ))}
              </NavDrawerBody>
            </NavDrawer>
          )}
          <main className={s.main} ref={mainRef}>
            <div className={s.mainInner}>
              {loading.length > 0 && (
                <div className={s.loading}>
                  {loading.map((l) => (
                    <MessageBar key={l.name} intent={l.error ? 'error' : 'info'}>
                      <MessageBarBody>{l.error ? `Could not open ${l.name}: ${l.error}` : <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}><Spinner size="extra-tiny" /> Parsing {l.name}…</span>}</MessageBarBody>
                      {l.error && <MessageBarActions><Button size="small" onClick={() => dismissLoading(l.name)}>Dismiss</Button></MessageBarActions>}
                    </MessageBar>
                  ))}
                </div>
              )}
              {!logs.length && !loading.length && !paramFiles.length && <Welcome onOpen={() => fileInput.current?.click()} />}
              {!active && paramFiles.length > 0 && <ParamDiffPage />}
              {active && ctx && (
                <ChartContext.Provider value={ctx}>
                  <div className={s.header}>
                    {pageDef.global ? (
                      <div className={s.headRow}><Title3 as="h1" style={{ margin: 0 }}>{pageDef.label}</Title3></div>
                    ) : (
                      <div className={s.timeline}>
                        <FlightTimeline log={active} title={
                          <div className={s.headRow}>
                            <Title3 as="h1" style={{ margin: 0 }}>{pageDef.label}</Title3>
                            <Body1 className={s.meta} title={`${active.fileName} · ${active.swVersion ?? ''} · ${active.hw ?? ''}`}>{active.fileName.replace(/\.ulg$/i, '')} · {active.swVersion ?? 'unknown version'}{active.airframe ? ` · ${active.airframe}` : ''} · {fmtTime(active.durationS)}</Body1>
                            {!active.isSupportedVersion && <Badge color="warning" appearance="tint">PX4 &lt; 1.17: partially supported</Badge>}
                            {pageDef.time && active.paramChanges.length > 0 && <Switch checked={showParamChanges} onChange={(_, d) => store.set({ showParamChanges: d.checked })} label={`Param changes (${active.paramChanges.length})`} />}
                          </div>
                        } />
                      </div>
                    )}
                  </div>
                  {page === 'filters' ? <FiltersPage log={active} />
                    : page === 'rateloop' ? <RateLoopPage log={active} />
                      : page === 'explorer' ? <ExplorerPage log={active} />
                        : page === 'compare' ? <ComparePage />
                          : page === 'pdiff' ? <ParamDiffPage />
                            : <StandardPage log={active} page={page} />}
                </ChartContext.Provider>
              )}
              {!active && logs.length === 0 && loading.length === 0 && null}
            </div>
          </main>
        </div>
        {dragging && (
          <div className={s.drop}>
            <div className={s.dropCard}>
              <Subtitle1 as="p" style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 10 }}><ArrowDownloadRegular fontSize={24} />Drop .ulg logs or .params files</Subtitle1>
              <Caption1>Files are analysed locally — nothing is uploaded.</Caption1>
            </div>
          </div>
        )}
        <Text style={{ display: 'none' }}>{APP_VERSION}</Text>
      </div>
    </FluentProvider>
  );
}

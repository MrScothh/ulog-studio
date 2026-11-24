/**
 * End-to-end check of the web builds with a real browser (local Chrome/Edge via playwright-core, temporary profile).
 *   node tests/e2e.mjs single <log.ulg> [outDir]   -> dist-single/index.html opened from file://
 *   node tests/e2e.mjs pwa    <log.ulg> [outDir]   -> dist-web served on localhost, then reloaded OFFLINE from the service worker
 *   E2E_URL=https://… node tests/e2e.mjs url <log.ulg>  -> same, against a deployed copy
 * Logs stay local: they are handed to the page through a file input, nothing leaves the machine.
 */
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [mode, logPath, outDir = 'e2e-out'] = process.argv.slice(2);
if (!mode || !logPath) { console.error('usage: node tests/e2e.mjs single|pwa <log.ulg> [outDir]'); process.exit(2); }
mkdirSync(outDir, { recursive: true });
const exe = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find((p) => p && existsSync(p));
if (!exe) { console.error('No Chrome/Edge found (set CHROME_PATH)'); process.exit(2); }

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
function serve(dir) {
  return new Promise((ok) => {
    const srv = createServer((req, res) => {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p.endsWith('/')) p += 'index.html';
      const f = join(dir, p);
      if (!existsSync(f)) { res.statusCode = 404; res.end(); return; }
      res.setHeader('content-type', MIME[extname(f)] ?? 'application/octet-stream');
      res.end(readFileSync(f));
    }).listen(0, '127.0.0.1', () => ok(srv));
  });
}

const errors = [];
const browser = await chromium.launch({ executablePath: exe, headless: true });
// SCALE emulates Windows display scaling on a 1440x900-physical-pixel window (1, 1.25, 1.5); THEME light|dark
const SCALE = Number(process.env.SCALE ?? 1);
const context = await browser.newContext({ viewport: { width: Math.round(1440 / SCALE), height: Math.round(900 / SCALE) }, deviceScaleFactor: SCALE, colorScheme: process.env.THEME === 'dark' ? 'dark' : 'light' });
const page = await context.newPage();
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
let srv;
const t0 = Date.now();
try {
  if (mode === 'single') {
    await page.goto(pathToFileURL(resolve('dist-single/index.html')).href);
  } else {
    // pwa: local dist-web; url: a deployed copy (E2E_URL), e.g. the GitHub Pages site
    let url = process.env.E2E_URL;
    if (mode !== 'url' || !url) { srv = await serve(resolve('dist-web')); url = `http://127.0.0.1:${srv.address().port}/`; }
    await page.goto(url);
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    await page.reload();
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 15000 });
    srv?.close(); srv = undefined;
    await context.setOffline(true);
    await page.reload();
    console.log('PWA reloaded offline from the service worker cache');
  }
  await page.getByText('Analyse PX4 flight logs').waitFor({ timeout: 15000 });
  await page.locator('input[type=file]').setInputFiles(logPath);
  await page.getByText('Automatic checks').waitFor({ timeout: 60000 });
  console.log(`log parsed and overview rendered in ${Date.now() - t0} ms`);
  await page.screenshot({ path: join(outDir, `${mode}-s${SCALE}-overview.png`) });
  const nav = async (label, waitText) => {
    await page.getByRole('button', { name: label, exact: true }).click();
    await page.getByText(waitText).first().waitFor({ timeout: 60000 });
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(outDir, `${mode}-s${SCALE}-${label.replace(/\W+/g, '_')}.png`) });
    console.log(`page ${label}: ok`);
  };
  await nav('Tracking', 'Attitude & rate tracking');
  await nav('Vibration', 'Quiet-hover spectra');
  await nav('Gyro filters', 'What-if replay on raw gyro');
  await page.getByText(/Noise above 30 Hz/).waitFor({ timeout: 60000 });
  await nav('Rate loop', 'Plant identification');
  await nav('GPS & estimator', 'GPS readiness at arming');
  await nav('Messages & events', 'Logged messages & events');
  const msgs = await page.locator('table').first().innerText();
  console.log('events decoded:', /Navigation error|Arming|GPS|offboard/i.test(msgs) ? 'yes' : 'NO', '| metadata source:', (await page.getByText(/metadata: \w+/).first().innerText()).match(/metadata: \w+/)?.[0]);
  await nav('Explorer', 'Add panel');
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), page.getByRole('button', { name: 'Report' }).click()]);
  const rp = join(outDir, `${mode}-report.html`);
  await dl.saveAs(rp);
  const html = readFileSync(rp, 'utf8');
  console.log(`report: ${(html.length / 1e6).toFixed(1)} MB, ${(html.match(/<img /g) ?? []).length} charts, ${(html.match(/<table/g) ?? []).length} tables`);
} catch (e) {
  errors.push(`test: ${e.message}`);
  await page.screenshot({ path: join(outDir, `${mode}-failure.png`) }).catch(() => {});
} finally {
  srv?.close();
  await browser.close();
}
const real = errors.filter((e) => !/tile\.openstreetmap|favicon/.test(e));
console.log(real.length ? `ERRORS:\n${real.join('\n')}` : 'no browser errors');
process.exit(real.length ? 1 : 0);

# Development

## Architecture

```
src/core/       analysis engine in TypeScript, DOM-free, runs in a Web Worker (and in Node for tests)
  ulog.ts         columnar ULog parser (appended data, resync on corruption, multi-info, default & changed parameters)
  events.ts       PX4 event decoder (libevents rules); metadata from the log itself (xz) or bundled
  dsp.ts          FFT, Welch, CSD/coherence, spectrograms, biquads (PX4 NotchFilter, LowPassFilter2p, AlphaFilter), filtfilt
  engine.ts       open logs, page cache, summaries and alerts (exposed to the UI through Comlink)
  pages/          page builders: fr.ts (Flight Review plots), index.ts (flight pages), tuning.ts (gyro filters,
                  rate loop), interactive.ts (compare, parameter diff)
  analysis/       filters & what-if, plant identification & margins, step response, hover, GPS, timing, parameters
src/charts/     uPlot charts with min/max decimation, spectrograms, Leaflet map, shared zoom, cursor and replay state
src/app, src/pages, src/components    React 19 + Fluent UI 2 (Windows 11 look, light and dark)
src-tauri/      Tauri 2 desktop shell (Rust): file access, dialogs, file association, signed updater
docs/           this documentation (published to the wiki by .github/workflows/wiki.yml)
```

Pages are data: the worker returns a `PageSpec` (sections of charts, tables, checks, diagrams) and the UI renders it. The same specs feed the HTML report.

The analysis is written once and shipped three ways: Tauri desktop app (`dist`), PWA (`dist-web`, vite-plugin-pwa) and single HTML file (`dist-single`, vite-plugin-singlefile).

## Running

```bash
npm install
npm run dev          # web app on http://localhost:5173
npm run tauri dev    # desktop app (needs Rust and the Tauri prerequisites)
npm test             # unit tests (no logs needed)
npm run typecheck
```

While developing, `ULOG_DEV_DIR=<folder>` plus `?devlogs=<part of a file name>` in the URL loads logs straight from that folder (dev server only).

## Tests

- `tests/unit.test.ts`: synthetic ULog, DSP, the PX4 filter chain (time domain vs frequency response), loop margins against a closed form, events, parameters. Runs in CI.
- `tests/reallogs.test.ts`: every page on every log in `ULOG_DIR` (local only).
- `tests/reference.test.ts`: plant identification and margins against an independent reference (`ULOG_REFERENCE`, local untracked JSON).
- `tests/e2e.mjs`: the single-file build from `file://` and the PWA reloaded offline, in Chrome/Edge.

Logs are never committed (`*.ulg` and `*.params` are git-ignored); tests that need them read paths from environment variables and are skipped in CI.

## Conventions

- Models follow PX4's source; cite the file in a comment and cross-check against an independent implementation (Python/scipy, Flight Review) before relying on a number.
- Target PX4 v1.17 and newer: current topic and field names.
- UI: Fluent UI components and tokens, light and dark themes; check 100 / 125 / 150 % scaling.

## Releasing

Desktop updates are signed with a minisign key that is **not** in the repository.

```bash
npm version patch --no-git-tag-version   # and the version in src-tauri/Cargo.toml
git commit -am "x.y.z: …" && git push
node scripts/release.mjs --repo MrScothh/ulog-studio --notes "What changed"
```

The script builds the installer, the single-file app and the PWA zip, creates the GitHub release and uploads `latest.json` (the updater manifest). Alternatively the *Release* workflow does the same on a `v*` tag once the signing key is stored as the `TAURI_SIGNING_PRIVATE_KEY` secret. The web app is redeployed to GitHub Pages on every push to `main`, and this documentation to the wiki on every change under `docs/`.

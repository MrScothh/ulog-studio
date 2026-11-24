# ULog Studio

[![CI](https://github.com/MrScothh/ulog-studio/actions/workflows/ci.yml/badge.svg)](https://github.com/MrScothh/ulog-studio/actions/workflows/ci.yml)
[![Web app](https://github.com/MrScothh/ulog-studio/actions/workflows/pages.yml/badge.svg)](https://mrscothh.github.io/ulog-studio/)
[![License: BSD-3-Clause](https://img.shields.io/badge/license-BSD--3--Clause-blue.svg)](LICENSE)

**Offline analysis of PX4 flight logs (`.ulg`, PX4 v1.17+).** Everything [Flight Review](https://github.com/PX4/flight_review) shows, plus the analyses you actually need when tuning a multicopter — as a Windows app and as a web app that works without a network connection. Your logs never leave your computer: no upload, no server.

*Leggi in italiano: [README.it.md](README.it.md)*

## Get it

| | |
|---|---|
| **Windows app** | Installer from the [latest release](https://github.com/MrScothh/ulog-studio/releases/latest) (`ULog-Studio_<version>_x64-setup.exe`). Per-user install (no admin rights), opens `.ulg` files by double-click, updates itself (signed updates from this repository's releases). |
| **Web app** | **<https://mrscothh.github.io/ulog-studio/>** — install it as an app from the browser; after the first visit it works fully offline. Files you open are analysed locally in the browser. |
| **Single file** | `ULog-Studio-<version>.html` from the releases: one self-contained file, open it in Chrome or Edge from disk or a USB stick, no network needed. |

## Features

**Flight Review, ported** — info table (airframe, hardware, software version, duration, distance, speeds, tilt, current), map and top-down trajectory, altitude estimate, roll/pitch/yaw angle and rate tracking (with rate integral), local position and velocity, RC inputs, actuator controls and their FFT, motor and servo outputs, ESC RPM, raw accel/gyro, vibration metrics, FFTs and spectrograms (accel, angular rate and acceleration, high-rate FIFO), sampling regularity, magnetometer, distance sensor, GPS uncertainty, noise and jamming, thrust vs. magnetic field, power and temperatures, estimator flags, failsafe flags, CPU & RAM, PID step response, non-default parameters, logged messages and **PX4 events decoded offline**, flight-mode background, parameter-change markers.

**On top of that**
- **Flight timeline** — modes, armed/in-air, time-located alerts (events, failsafes, dropouts, parameter changes, takeoff/landing); drag to zoom, click a mode to zoom on it. The cursor is shared between every chart, the map and the top-down view.
- **Flight replay** — play the flight back at 1–20× with the drone (heading and trail) on the satellite map and the top view, live height, ground speed, climb rate and heading.
- **Battery** — pack and per-cell voltage at the start and end of the log, minimum under load.
- **Multi-flight comparison** with identical metrics (vibration and oscillation measured on quiet hover only, hover thrust, motor imbalance, attitude error, dropouts, CPU) and overlaid spectra.
- **Parameter diff** between logs and QGroundControl `.params` files (just drop them in).
- **Quiet-hover PSD** — airborne, sticks centred, speed < 2.5 m/s, adaptive threshold.
- **Gyro filters (`IMU_GYRO_*`)** — the chain PX4 actually runs (dynamic and static notches, gyro low-pass, derivative, first-order D low-pass, at the raw rate of the gyro in use) drawn with the delay each filter adds; checks that every notch sits on a real vibration peak; **what-if replay** on the raw FIFO gyro with the noise each setting sends to the motors. The replay is checked against the log itself: PX4's own filtered rate and D-term input, and the logged torque command.
- **Rate loop** — airframe identified from stick doublets (`α = K · e^(−s·d) / (τs + 1) · torque`, with the gyro filters modelled exactly) and **stability margins** in plain words (how much extra gain or delay before it oscillates, the `MC_*RATE_K` that would meet 45° / 6 dB), checked by comparing the predicted closed-loop response with the one measured in flight; Bode plots and editable gains.
- **Aliasing warning** when a topic is logged below twice the vibration frequency (44 Hz logged at 50 Hz shows up as a fake 6 Hz oscillation).
- **Motor imbalance** turned into a centre-of-gravity offset and a residual yaw torque using the `CA_ROTORn_*` geometry.
- **Hover thrust normalised on battery voltage** and its drift over the flight.
- **GPS readiness at arming** — fix, satellites, EPH/EPV, EKF2 GPS checks, when GNSS fusion started relative to arming, jamming/spoofing.
- **Loop timing & logging rates** — gyro→torque latency, interval percentiles, logger cycle histogram, every topic's rate, dropouts.
- **Explorer** (PlotJuggler-style): any field of any topic, drag & drop onto synchronised panels.
- **Exports** — self-contained HTML report (every page, charts as images, printable to PDF), CSV/PNG of any chart, proposed filter/gain values as a `.params` file to load manually in QGroundControl. ULog Studio never writes parameters to a vehicle.

## Documentation

The **[wiki](https://github.com/MrScothh/ulog-studio/wiki)** explains every page: [logging setup](docs/Logging-setup.md), [Gyro filters](docs/Gyro-filters.md), [Rate loop](docs/Rate-loop.md), [FAQ](docs/FAQ.md) and more. Its source is in [`docs/`](docs/Home.md). Questions are welcome in [Discussions](https://github.com/MrScothh/ulog-studio/discussions).

## Privacy

- Parsing and analysis run entirely on your machine (a Web Worker in the browser or the desktop app).
- The map is offline by default (track only); satellite imagery (Esri World Imagery) is opt-in because downloading it tells the imagery provider where you flew.
- The desktop app only contacts `api.github.com` to check this repository's releases.
- When reporting an issue, please **do not attach flight logs publicly** unless you are fine with sharing them: they can contain GPS positions, dates and vehicle identifiers.

## Architecture

```
src/core/       analysis engine in TypeScript, DOM-free, runs in a Web Worker
  ulog.ts         columnar ULog parser (appended data, resync on corruption, multi-info, default & changed parameters)
  events.ts       PX4 event decoder (libevents rules); metadata from the log itself (xz) or bundled
  dsp.ts          FFT, Welch, CSD/coherence, spectrograms, biquads (PX4 LowPassFilter2p & NotchFilter), filtfilt
  pages/fr.ts     Flight Review plots
  analysis/       step response, filters & what-if, plant ID & margins, hover, GPS, timing, parameters
src/charts/     uPlot charts with min/max decimation, spectrograms, Leaflet map, shared zoom & cursor
src/app, src/pages, src/components    React + Fluent UI 2 (Windows 11 look, light/dark)
src-tauri/      Tauri 2 desktop shell (Rust): file access, dialogs, signed updater
```

The analysis is written once in TypeScript and shipped three ways (Tauri desktop app, PWA, single HTML file). A 27 MB high-rate log parses in about 40 ms.

## Development

```bash
npm install
npm run dev          # web app on http://localhost:5173
npm run tauri dev    # desktop app
npm test             # unit tests (no logs needed)
npm run typecheck
```

Tests against your own logs stay local:

```bash
ULOG_DIR=<folder with .ulg files> npx vitest run tests/reallogs.test.ts
ULOG_REFERENCE=tests/reference.local.json npx vitest run tests/reference.test.ts   # see the file header
node tests/e2e.mjs single <log.ulg>    # single-file build opened from file:// in Chrome/Edge
node tests/e2e.mjs pwa <log.ulg>       # PWA reloaded offline from its service worker
```

While developing, `ULOG_DEV_DIR=<folder>` plus `?devlogs=<part of a file name>` in the URL loads logs straight from that folder (dev server only).

## Releasing

Desktop updates are signed with a minisign key that is **not** in the repository (`%USERPROFILE%\.tauri\ulog-studio.key` on the maintainer's machine).

```bash
npm version patch --no-git-tag-version
git commit -am "Release x.y.z" && git push
node scripts/release.mjs --repo MrScothh/ulog-studio --notes "What changed"
```

The script builds the installer, the single-file app and the PWA zip, creates the GitHub release and uploads `latest.json` (the updater manifest). Installed copies pick the update up on their next check. Alternatively the *Release* workflow does the same on a `v*` tag once the signing key is stored as the `TAURI_SIGNING_PRIVATE_KEY` repository secret.

The web app is redeployed to GitHub Pages on every push to `main`.

## Bundled PX4 metadata

`src/assets/px4/` holds PX4's public parameter, airframe and event metadata, used when a log does not carry them (logs from PX4 v1.15 on embed the event metadata, which is preferred). Regenerate with `python tools/gen_px4_meta.py <dir>` from `parameters.xml`, `airframes.xml` and `all_events.json.xz` (PX4 build artifacts).

## License

[BSD-3-Clause](LICENSE). Parts are ported from Flight Review, PID-Analyzer and libevents — see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

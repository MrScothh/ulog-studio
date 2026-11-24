# Changelog

## 0.1.4 — 2026-11-24

- Flight replay (Overview › Trajectory & replay): play/pause, 1–20× speed, position slider; the drone (heading arrow, 15 s trail) moves on the map and on the top view, the map can follow it, the timeline cursor follows; live mode, height, ground speed, climb rate and heading.
- Battery: start and end pack voltage (median of 2 s) with the minimum under load, and the per-cell voltage (measured cells when the battery reports them, otherwise pack / cell count).
- Map: satellite or offline only (street map removed); the scale label is crisp (Leaflet's text shadow was overriding the app style); satellite tiles overzoom from level 18 to avoid grey "not available" tiles.
- Web app: new versions are picked up on the next reload without closing every tab.

## 0.1.3 — 2026-11-24

- Map: satellite basemap (Esri World Imagery) next to offline and OpenStreetMap; the choice is remembered. Online basemaps stay opt-in.
- Map: the track follows the timeline zoom (selected stretch highlighted, fit button), the flight cursor shows time, mode and height, taller-map toggle, legend.
- Map fixes: tiles no longer spill outside the map when a basemap is switched on, the map stays below the sticky header while scrolling, the plain mouse wheel scrolls the page (Ctrl+wheel zooms), crisp scale bar, no flag in the attribution.
- Timeline: the cursor label sits on the time axis and no longer covers the zoom button.

## 0.1.2 — 2026-11-24

- Parameters: rows are marked as "not the airframe default" only when the log carries airframe defaults (as Flight Review does); calmer row markers in tables.
- Messages: PROTOCOL-level events (health/arming summaries) are hidden, as in QGroundControl.

## 0.1.1 — 2026-11-24

- Narrow windows (e.g. 150 % display scaling on a laptop): the navigation turns into an overlay so charts keep their width.

## 0.1.0 — 2026-11-24

First release.

- Offline ULog parser and PX4 event decoding (metadata from the log or bundled), analysis in a Web Worker.
- Flight Review plots ported: tracking, actuators, vibration, FFT/spectrograms, power, GPS & estimator, system, parameters, messages, PID step response.
- Flight timeline with modes, in-air state, alerts and a shared cursor across charts, map and top-down view.
- Tuning: quiet-hover PSD, aliasing check, gyro filter response and what-if replay on raw FIFO gyro, plant identification from stick doublets and rate-loop margins.
- Motor imbalance → CoG offset, voltage-normalised hover thrust, GPS readiness at arming, loop timing and logging rates.
- Multi-flight comparison, parameter diff with QGroundControl `.params` files, Explorer, HTML report, CSV/PNG/`.params` exports.
- Windows app (Tauri 2) with signed auto-update; offline PWA on GitHub Pages; single-file web app.

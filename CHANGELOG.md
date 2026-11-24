# Changelog

## 0.1.8 — 2026-11-25

- The navigation pane keeps a fixed width: it no longer widened while a page was still computing (visible on the Gyro filters and Rate loop pages).
- Documentation: user guide and wiki (`docs/`), issue forms, security policy, code of conduct, support page.

## 0.1.7 — 2026-11-25

Gyro filters and Rate loop checked line by line against the PX4 source (v1.17 to main) and corrected.

- **D-term filter model fixed.** PX4 takes the derivative *after* the gyro low-pass and filters it with a first-order AlphaFilter (`IMU_DGYRO_CUTOFF`). The model differentiated the notched signal before the low-pass and used a second-order filter, so it understated the D-path delay (≈ 9 ms instead of ≈ 15 ms at 10 Hz on a 40/25 Hz setup) and overstated the margins (roll 47° → 38°, gain margin 5.5 → 4.0 dB on the reference flight).
- **Filter rate from the gyro in use.** The rate now comes from the `vehicle_imu_status` instance of the gyro selected by `sensor_selection` (as `VehicleAngularVelocity` does), not from the first IMU; the raw FIFO replay uses that gyro's FIFO.
- **Rate loop model.** The gyro filters are part of the identification (no more division by the notch response, which blew up near the notches when they were edited); yaw includes the `MC_YAW_TQ_CUTOFF` torque low-pass; `MC_*RATE_FF` is in the closed-loop prediction; fractional delays in the fit.
- **Dynamic notches**: ESC-RPM notches modelled at hover RPM with PX4's harmonic and minimum-frequency rules; FFT notches at the median logged peaks; a note when `IMU_GYRO_DNF_EN` asks for the FFT notch but the firmware has no `gyro_fft` module.
- **Checks against the log itself**: the replayed chain is compared sample by sample with PX4's own filtered rate and D-term input (`vehicle_angular_velocity.xyz_derivative`) and with the logged torque command; the rate-loop model is compared with the closed-loop response measured in flight.
- **Both pages rewritten for clarity**: the filter chain drawn with the delay each filter adds, a check per notch (is it on a vibration peak, how many dB it removes), noise sent to the motors in % of full torque; rate-loop verdict in plain words (gain and delay that would make it oscillate, `MC_*RATE_K` for 45° / 6 dB); advanced plots collapsed.
- "Jump to" chips are plain navigation buttons (they no longer stay selected) and open a collapsed section.
- Default `IMU_DGYRO_CUTOFF` when missing from the log is 20 Hz (PX4 default).

## 0.1.6 — 2026-11-24

- Altitude estimate: downward-facing rangefinder (lidar) added as distance + home altitude, only valid readings, line broken where readings are missing.
- Altitude estimate: only valid altitude setpoints are shown (an unset setpoint triplet logs 0 m and squashed the scale).
- Time plots open on the log time span (samples stamped before the log start no longer push the axis to negative times).

## 0.1.5 — 2026-11-24

- Narrow windows: the sections stay visible as a compact icon rail (labels on hover) instead of being hidden behind the menu button; the menu button still opens the full list.

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

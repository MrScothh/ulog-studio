# Third-party notices

| Component | Use | License |
|---|---|---|
| [PX4/flight_review](https://github.com/PX4/flight_review) | Plot set, info table, flight-mode colours, FFT/spectrogram conventions ported to TypeScript (`src/core/pages/fr.ts`, `src/core/pages/index.ts`) | BSD-3-Clause, © PX4 Development Team |
| PID-Analyzer (Florian Melsheimer), via Flight Review `pid_analysis.py` | Step response by Wiener deconvolution (`src/core/analysis/stepresp.ts`) | "Beer-ware" (Revision 42) |
| [mavlink/libevents](https://github.com/mavlink/libevents) | Event template/argument formatting rules (`src/core/events.ts`) | BSD-3-Clause |
| PX4-Autopilot metadata (`parameters.xml`, `airframes.xml`, `all_events.json`) | Bundled offline metadata (`src/assets/px4/`) | BSD-3-Clause, © PX4 Development Team |
| PX4 `math::NotchFilter` / `LowPassFilter2p` | Filter coefficient formulas (`src/core/dsp.ts`) | BSD-3-Clause |
| React, Fluent UI React v9, Fluent UI System Icons | UI | MIT |
| uPlot | Charts | MIT |
| Leaflet | Map | BSD-2-Clause |
| fft.js | FFT | MIT |
| xz-decompress (xzwasm, xz-embedded, walloc) | xz decoding of embedded event metadata | MIT / public domain |
| Comlink | Worker RPC | Apache-2.0 |
| Tauri 2 and plugins | Desktop shell, updater, dialogs | MIT / Apache-2.0 |
| keyring, reqwest, serde | Token storage, HTTP, JSON (Rust) | MIT / Apache-2.0 |

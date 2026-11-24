# ULog Studio

**Offline analysis of PX4 flight logs (`.ulg`, PX4 v1.17 and newer).** Everything [Flight Review](https://github.com/PX4/flight_review) shows, plus the analyses you need when tuning a multicopter, as a Windows app and as a web app that works without a network connection. Your logs never leave your computer.

## Start here

| | |
|---|---|
| [Installation](Installation.md) | Windows app, web app, single HTML file; updates |
| [Opening logs](Opening-logs.md) | Drag & drop, several logs at once, double-click on `.ulg` |
| [Logging setup](Logging-setup.md) | Which `SDLOG_PROFILE` bits to enable before a tuning flight |
| [Timeline and replay](Timeline-and-replay.md) | Flight modes, alerts, zoom, shared cursor, flight replay |

## The pages

| | |
|---|---|
| [Flight pages](Flight-pages.md) | Overview, Tracking, Actuators, Vibration, Power, GPS & estimator, System |
| [Gyro filters](Gyro-filters.md) | What PX4 does to the gyro signal, what each filter costs, what-if replay |
| [Rate loop](Rate-loop.md) | Airframe identification from stick doublets and stability margins |
| [Data pages](Data-pages.md) | Parameters, Messages & events, Explorer |
| [Compare and parameter diff](Compare-and-parameter-diff.md) | Several flights side by side, `.params` files |
| [Reports and exports](Reports-and-exports.md) | HTML report, CSV/PNG, proposed values as `.params` |

## Background

- [Privacy](Privacy.md): what stays on your machine and the two optional network accesses.
- [FAQ](FAQ.md): common questions and troubleshooting.
- [Development](Development.md): architecture, tests, releases.

The source of these pages is the [`docs/`](https://github.com/MrScothh/ulog-studio/tree/main/docs) folder of the repository; corrections are welcome as pull requests.

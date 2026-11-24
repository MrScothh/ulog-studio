# FAQ

**Is this an official PX4 tool?**
No. It is an independent project that reads PX4 logs and follows PX4's source code for its models. Parts are ported from Flight Review, PID-Analyzer and libevents (see `THIRD_PARTY_NOTICES.md`).

**Does it work with logs older than PX4 v1.17?**
They usually open, but the analyses look for v1.17+ topic and field names, so some pages may be empty.

**Fixed-wing, VTOL, rovers?**
The general pages (map, tracking, power, GPS, system, parameters, messages, explorer) work for any vehicle type. The tuning pages (Gyro filters, Rate loop) model the multicopter rate controller.

**The Rate loop page says "not enough clean stick input".**
The fit needs sharp stick doublets on that axis, logged at high rate. See [Logging setup](Logging-setup.md). You can also zoom on any manoeuvre and press *Use zoom range*.

**The Rate loop margins look worse than in an older version.**
Version 0.1.7 corrected the D-term filter model (PX4 differentiates after the gyro low-pass and uses a first-order D filter). The earlier model underestimated the D-path delay, so its margins were optimistic.

**Why does the Gyro filters page say "approx., no raw FIFO"?**
Without the raw FIFO the only gyro in the log is `sensor_combined`, sampled at a few hundred Hz, while PX4 filters at the gyro's raw rate (often 2 kHz or more). Vibration above half the logged rate is invisible or folded. Enable the raw FIFO bit for one short flight.

**A notch is reported as "no vibration peak there", but I set it for a reason.**
The check uses this flight's quiet hover. A peak can appear only at higher throttle or with another payload; zoom on that part of the flight and enable *Use the zoomed time range*.

**The web app does not update.**
Reload the page; a new version is installed on the next load. In the installed PWA, close and reopen the window.

**Where are my settings stored?**
In the browser's local storage (web app) or the app's WebView profile (desktop app): theme, collapsed sections, replay speed, map choice.

**How do I report a bug?**
[Open an issue](https://github.com/MrScothh/ulog-studio/issues/new/choose). Please read [Privacy](Privacy.md) before attaching a log.

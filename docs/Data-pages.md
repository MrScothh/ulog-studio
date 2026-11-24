# Data pages

## Parameters

- **Non-default parameters**: every parameter that differs from the PX4 default, with the default, range and description. When the log carries the airframe defaults (PX4 v1.15+), rows that also differ from the *airframe* default are marked, as Flight Review does. Calibration (`CAL_*`) and RC parameters are left out.
- **Changed during the log**: parameter changes while the log was running, with their times (also on the timeline).
- **All parameters**: searchable table.

## Messages & events

Logged text messages and **PX4 events decoded offline** (with the metadata embedded in the log, or the bundled one as a fallback), with time, severity and the decoded arguments. Protocol-level events (health and arming summaries) are hidden, as in QGroundControl.

## Explorer

A PlotJuggler-style view of any field of any topic:

- search the topic tree on the left;
- drag a field onto a panel, or click it to add it to the selected panel; **Add panel** creates another one;
- panels share the timeline zoom and cursor;
- each panel exports CSV and PNG.

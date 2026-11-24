# Opening logs

## Ways to open

- **Drag & drop** one or more `.ulg` files anywhere on the window.
- **Open** button (top left): pick one or more files.
- **Double-click** a `.ulg` in Explorer (Windows app).
- **Command line** (Windows app): `"ULog Studio.exe" flight1.ulg flight2.ulg`.

Each log opens in its own tab. Close a tab with its ×. The [Compare flights](Compare-and-parameter-diff.md) page uses every open log.

QGroundControl parameter files (`.params`) can be dropped too: they are used by the parameter diff and the comparison.

## Supported logs

- PX4 ULog (`.ulg`) from **PX4 v1.17 and newer**. Older logs usually open, but field names that changed before v1.17 are not looked for.
- Logs with appended data, multiple instances of a topic, logger dropouts and corrupt blocks: the parser resynchronises and reports what it skipped in the Overview checks.
- PX4 events are decoded offline with the metadata embedded in the log (PX4 v1.15+) or, as a fallback, with the bundled metadata.

## Speed

Parsing runs in a background worker, so the window stays responsive. A 27 MB high-rate log parses in about 40 ms; pages are computed when you open them.

## What to log

Most pages work with the default logging profile. The tuning pages need more: see [Logging setup](Logging-setup.md).

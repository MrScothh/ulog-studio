# Timeline and replay

## Flight timeline

The strip at the top of every page is a navigator for the whole log.

- **Mode** lane: flight modes in their colours. Click a mode to zoom on it.
- **In air** lane: armed and airborne time.
- **Alerts** lane: time-located events: PX4 events and logged messages (warnings and errors), failsafes, logger dropouts, parameter changes, takeoff and landing. Hover a marker for its text.
- **Alerts** button (top right): expands the list of alerts; click one (or a marker) to zoom on it.
- **Zoom:** drag across the timeline (or across any time chart) to zoom; the zoom is shared by every time chart. Double-click the timeline, or press *Show whole flight* (it appears while zoomed), to see the whole log again.
- **Cursor:** moving over any chart, the map or the top view shows the same instant everywhere, including a marker and a time bubble on the timeline.

## Flight replay

*Overview › Trajectory & replay.*

- **Play / pause** (or the space bar), **back to takeoff**, position slider.
- **Speed** 1×, 2×, 5×, 10×, 20× (remembered).
- The drone (an arrow pointing along its heading, with a 15 s trail) moves on the map and on the top view; the timeline cursor follows. *Follow* keeps the map centred on it.
- Live readouts: flight mode, height, ground speed, climb rate, heading. When not playing, they show the point under the mouse.

## Map

- Basemap **Offline** (track only, no network) or **Satellite** (Esri World Imagery, opt-in: downloading tiles tells the provider where you flew).
- The track is coloured by flight mode. The part inside the current timeline zoom is highlighted; the fit button zooms the map on it.
- `Ctrl` + mouse wheel zooms the map; the plain wheel scrolls the page.

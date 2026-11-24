# Privacy

Flight logs can contain GPS positions, dates, vehicle and hardware identifiers. ULog Studio is built so that they stay on your machine.

- **No upload, no server.** Logs are parsed and analysed locally: in a Web Worker in the browser, or inside the desktop app.
- **The map is offline by default** (track only). Satellite imagery is opt-in, because downloading tiles tells the imagery provider (Esri) which area you are looking at.
- **The desktop app** contacts only `api.github.com` and GitHub's download servers, to check this repository's releases and download signed updates.
- **The web app** is served by GitHub Pages; after the first visit it runs from the browser cache. Opening a log does not send it anywhere.
- **No analytics, no telemetry, no accounts.**

When you report an issue, do not attach a log publicly unless you are fine with sharing it: describe the problem, attach screenshots (check what they show), or offer to share the log privately.

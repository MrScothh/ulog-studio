# ULog Studio

Analisi offline dei log di volo **PX4 (v1.17 e successive)**: i grafici di Flight Review più le analisi che servono davvero per il tuning, in un'app desktop per Windows e in una webapp che funziona senza rete. I log restano sul tuo computer: nessun upload, nessun server.

*English: [README.md](README.md)*

| | |
|---|---|
| **App Windows** | installer dall'[ultima release](https://github.com/MrScothh/ulog-studio/releases/latest): installazione per utente (non serve l'amministratore), apre i `.ulg` con doppio clic, si aggiorna da sola con aggiornamenti firmati |
| **Webapp** | **<https://mrscothh.github.io/ulog-studio/>**: installabile come app dal browser; dopo la prima visita funziona del tutto offline, i file aperti vengono analizzati nel browser |
| **File singolo** | `ULog-Studio-<versione>.html` dalle release: un unico file da aprire con Chrome o Edge, anche da chiavetta e senza rete |

## Cosa fa

**Tutto quello che fa Flight Review** (porting fedele di `PX4/flight_review`):
tabella info (airframe, hardware, versione, durata, distanza, velocità, inclinazione, corrente), mappa/traiettoria e vista dall'alto, quota stimata, inseguimento di angoli e rate (con integrale), posizione e velocità locali, ingressi del radiocomando, comandi agli attuatori e relativa FFT, uscite di motori e servo, RPM degli ESC, accelerazioni e gyro grezzi, metriche di vibrazione, FFT e spettrogrammi (accelerazione, velocità e accelerazione angolare, FIFO ad alta frequenza), regolarità del campionamento, magnetometro, sensore di distanza, incertezza GPS, rumore e jamming, spinta rispetto al campo magnetico, alimentazione e temperature, flag dell'estimatore, flag di failsafe, CPU e RAM, risposta al gradino (PID analysis), parametri non di default, messaggi ed **eventi PX4 decodificati offline**, sfondo colorato per i modi di volo, marker dei cambi di parametro.

**In più:**
- **Replay del volo** da 1× a 20×: drone orientato con la scia sulla mappa satellitare e sulla vista dall'alto, quota, velocità al suolo, velocità verticale e rotta in tempo reale.
- **Batteria**: tensione del pacco e per cella a inizio e fine log, minima sotto carico.
- **Confronto tra più voli** con metriche identiche: vibrazioni e oscillazioni misurate solo in hover tranquillo, hover thrust, squilibrio dei motori, errore di assetto, dropout, CPU; sovrapposizione delle PSD.
- **Diff dei parametri** tra log e file `.params` di QGroundControl (trascinali nella finestra).
- **PSD solo sui tratti di hover tranquillo**: in aria, stick centrati, velocità sotto 2,5 m/s, con soglia adattiva.
- **Filtri `IMU_GYRO_*`**: modulo, fase e ritardo dei percorsi P/I e D; simulazione **what-if** sul gyro FIFO grezzo (catena PX4 riprodotta campione per campione), con il rumore iniettato nella coppia via P e via D.
- **Identificazione dell'impianto** dai doublet di stick (`α = K · lag(τ) · ritardo · coppia`, R²), **margini del rate loop** (PM, GM, crossover, picco di sensibilità), diagrammi di Bode, risposta in anello chiuso misurata, guadagni modificabili al volo.
- **Avviso di aliasing** quando un topic è loggato sotto il doppio della frequenza di vibrazione (ad esempio 44 Hz loggati a 50 Hz diventano finte oscillazioni a 6 Hz).
- **Squilibrio dei motori** convertito, tramite la geometria `CA_ROTORn_*`, in spostamento del baricentro e coppia di imbardata residua.
- **Hover thrust normalizzata sulla tensione** (`thrust × V / V_ref`) e sua deriva nel volo.
- **Prontezza del GPS all'armamento**: fix, satelliti, EPH/EPV, check GPS di EKF2, inizio della fusione GNSS rispetto all'armamento, jamming e spoofing.
- **Timing dei loop e frequenze di logging**: latenza gyro→coppia, percentili degli intervalli, istogramma del ciclo del logger, tabella di tutti i topic, dropout.
- **Explorer** in stile PlotJuggler: qualsiasi campo di qualsiasi topic, trascinabile su più pannelli sincronizzati.
- **Export di un report HTML** con tutte le pagine (grafici come immagini e tabelle), stampabile in PDF; export CSV e PNG di ogni grafico; export in `.params` dei filtri o guadagni proposti, da caricare a mano in QGC (l'app **non scrive mai parametri sul drone**).

Zoom e cursore sono sincronizzati su tutti i grafici: trascina per zoomare, Ctrl+rotella per lo zoom attorno al cursore, doppio clic per tornare all'intero volo; un clic su un modo nella timeline zooma su quel tratto.

## Architettura

```
src/core/      motore di analisi in TypeScript, senza dipendenze dal DOM (gira in un Web Worker)
  ulog.ts        parser ULog colonnare (dati appended, resync sui dati corrotti, info multiple, parametri di default e cambiati)
  events.ts      decoder degli eventi PX4 (porting del parser libevents); metadata dal log stesso (xz) o inclusi nell'app
  dsp.ts         FFT, Welch, CSD/coerenza, spettrogrammi, biquad (LPF2p e notch esattamente come in PX4), filtfilt
  pages/fr.ts    porting dei grafici di Flight Review
  analysis/      step response (PID-Analyzer), filtri e what-if, identificazione dell'impianto e margini, hover, GPS, timing, parametri
src/charts/    grafici uPlot (milioni di punti con decimazione min/max), spettrogrammi, mappa Leaflet
src/app, src/pages, src/components   interfaccia React + Fluent UI 2 (stile Windows 11, tema chiaro/scuro)
src-tauri/     shell desktop Tauri 2 (Rust): lettura e scrittura file, dialoghi, updater firmato
```

**Perché uno stack web e non un toolkit desktop (Qt/PySide6).** Servono un `.exe` **e** una webapp offline dallo **stesso codice**, e un toolkit desktop non gira nel browser. La scelta è quindi TypeScript (parser e DSP nel worker), React con Fluent UI 2 (lo stesso design system di Windows 11, tema chiaro/scuro), e Tauri 2 per l'eseguibile: installer da circa 2,5 MB invece dei 100 MB di Electron, WebView2 di sistema, updater con firma minisign.

Alternative valutate:
- **Flight Review** è un server Python/Bokeh con upload: ne ho portato la logica, non l'infrastruttura.
- **Pyodide** (il Python originale nel browser) avrebbe significato 40–60 MB da scaricare, parsing lento e aspetto Bokeh.
- **PlotJuggler** e **Foxglove** sono ottimi per esplorare i dati, ma non fanno le analisi PX4: l'Explorer ne riprende l'idea.
- **pyulog** e le librerie ULog in Rust/WASM: il parser in TypeScript basta (log da 27 MB analizzato in circa 40 ms) ed evita il passaggio da WASM.

## Privacy

- Il parsing avviene interamente nel browser o nell'app: nessun dato di volo esce dal computer.
- La mappa è offline (traccia senza sfondo); le immagini satellitari (Esri World Imagery) sono un'opzione disattivata di default, perché scaricarle rivela al fornitore la zona del volo.
- L'.exe contatta solo `api.github.com` per verificare le release di questo repository.
- Quando apri una issue **non allegare log di volo in pubblico**, a meno che tu non voglia condividerli: possono contenere posizioni GPS, date e identificativi del veicolo.
- `.gitignore` esclude `*.ulg`, `*.params` e le chiavi.

## Aggiornamenti dell'app desktop

L'app controlla le release di questo repository tramite l'API di GitHub e scarica `latest.json` e poi l'installer. Verifica la **firma** con la chiave pubblica inclusa nell'eseguibile e installa in modalità passiva, poi si riavvia. Non serve alcun token. Se la GitHub CLI è autenticata, o se salvi un token nella finestra Aggiornamenti, l'app lo usa per avere un limite di richieste più alto o per un eventuale fork privato.

La chiave privata di firma **non è nel repository**: senza quella chiave non si possono pubblicare aggiornamenti accettati dalle copie installate.

## Webapp offline

- **GitHub Pages**: <https://mrscothh.github.io/ulog-studio/> viene ripubblicata a ogni push su `main`. Alla prima visita il service worker mette in cache tutto; poi l'app si apre e funziona offline, si installa come app e si aggiorna da sola.
- **File singolo** (`.html`): funziona da `file://` con Chrome o Edge; parser, worker, decoder WASM degli eventi e metadata PX4 sono tutti dentro il file.
- **Zip PWA**: gli stessi file di Pages, da pubblicare su un altro hosting statico se serve.

## Sviluppo

```powershell
npm install
npm run dev               # webapp su http://localhost:5173
npm run tauri dev         # app desktop in sviluppo
npm test                  # test unitari (senza log)
```

Test sui log reali, che restano locali:

```powershell
$env:ULOG_DIR="<cartella con .ulg>"; npx vitest run tests/reallogs.test.ts
$env:ULOG_REFERENCE="tests/reference.local.json"; npx vitest run tests/reference.test.ts   # confronto con un'analisi di riferimento (vedi intestazione del file)
node tests/e2e.mjs single <log.ulg>   # file singolo aperto da file:// in Chrome
node tests/e2e.mjs pwa <log.ulg>      # PWA ricaricata offline dal service worker
```

Durante lo sviluppo, `ULOG_DEV_DIR=<cartella>` più `?devlogs=<parte del nome>` nell'URL carica direttamente i log dalla cartella. Funziona solo sul dev server locale.

## Release

```powershell
npm version patch --no-git-tag-version   # aggiorna la versione in package.json
git commit -am "Release x.y.z"; git push
node scripts/release.mjs --repo MrScothh/ulog-studio --notes "Novità…"
```

Lo script compila le tre varianti, firma l'installer, crea la release con `gh` e carica `latest.json` (il manifest dell'updater, che punta all'asset tramite API). Le copie installate si aggiornano al controllo successivo.

## Metadata PX4 inclusi

`src/assets/px4/` contiene i metadata pubblici di PX4 (parametri, airframe, eventi), usati quando il log non li contiene. Si rigenerano con `python tools/gen_px4_meta.py <cartella>` partendo da `parameters.xml`, `airframes.xml` e `all_events.json.xz` (artefatti di build di PX4). I log PX4 dalla 1.15 in poi includono già i metadata degli eventi: l'app usa quelli del log.

## Licenza

[BSD-3-Clause](LICENSE). Alcune parti sono portate da Flight Review, PID-Analyzer e libevents: vedi [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

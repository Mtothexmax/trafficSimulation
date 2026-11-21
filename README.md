# trafficSimulation

Öffnet Vissim-Netzdateien (`.inpx`) und simuliert sie: mikroskopische Verkehrssimulation mit
2D- und 3D-Ansicht (three.js). Eine reine Website: alles läuft im Browser.

## Was es kann

- Liest Netze im `.inpx`-Format: Strecken, Verbinder, Zuflüsse, statische Routen, Signalgeber,
  Detektoren, Langsamfahrbereiche, Konfliktflächen, Fahrverhalten.
- Simuliert mit Wiedemann 74 / 99 nach den veröffentlichten Beschreibungen. Die Ergebnisse sind
  denen von Vissim ähnlich, nicht identisch.
- Signalsteuerung:
  - Festzeit aus `.sig`-Dateien;
  - verkehrsabhängig durch ein externes Steuerungsprogramm (eine Windows-exe), das der Nutzer
    hochlädt. Es wird im Browser in einem x86-Emulator ausgeführt (`src/lib/vissim/exe`); die
    Dateien verlassen den Rechner nicht.

Steuerungsprogramme, Versorgungsdateien und Beispielnetze sind nicht Teil dieses Repositorys.

Die 3D-Modelle (Autos, Lkw, Bus, Tram, Radfahrer, Motorradfahrer, Fußgänger) sind eigene Formen
dieses Projekts und liegen nicht als Dateien vor: `src/lib/vissim/models.ts` setzt sie beim Start
aus Grundkörpern zusammen.

## Entwickeln

```
npm install
npm run dev          # Entwicklungsserver
npm run check        # Typprüfung
npx vitest run       # Tests
```

## Veröffentlichen (GitHub Pages)

```
powershell -ExecutionPolicy Bypass -File .\export.ps1
```

baut die Seite nach `docs/` (für `https://mtothexmax.github.io/trafficSimulation/`). In den
Repository-Einstellungen unter Pages als Quelle den Ordner `/docs` des Hauptzweigs wählen.

Die meisten Tests brauchen ein Beispielnetz: `static/samples/beispiel.inpx` und
`static/samples/beispiel.sig`. Ohne die Dateien werden sie übersprungen. Der Vergleich des
Emulators mit einem echten Steuerungsprogramm läuft nur mit `VA_TEST_DIR`, `VA_TEST_EXE`,
`VA_TEST_VSG` und `VA_TEST_VAG` (siehe `src/lib/vissim/exe/program.test.ts`).

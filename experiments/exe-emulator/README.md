# Machbarkeitstest: Steuerungs-exe ohne Windows ausführen

Frage: Kann ein Steuerungsprogramm (eine Windows-exe) in einem Emulator laufen, sodass die
Simulation als reine Website funktioniert und der Nutzer die exe nur hochlädt?

Ergebnis (21.11.2026): **Ja.** Der Prototyp hier führt die exe in einem x86-Emulator aus, ohne
Windows und ohne DDE, und liefert über 400 Steuerungsschritte in jedem Schritt exakt dieselbe
Antwort wie die echte exe (rund 958 000 Werte verglichen).

## Aufbau

- `emu.py` – der Prototyp (Python, Emulator-Kern: Unicorn).
  - lädt die PE-Datei in den Emulator;
  - ersetzt jede importierte Windows- und C-Funktion durch einen kleinen Nachbau;
  - hält Dateien im Speicher (Versorgung, ini-Dateien, was die exe selbst schreibt);
  - emuliert DDE nicht als Transport: Die Daten gehen direkt an die Funktion der exe, die sonst
    die DDE-Nachrichten annimmt.
- `scenario.py` – die Eingaben, die echte und emulierte Steuerung gleichermaßen bekommen.
- `record_real.py` – lässt die echte exe (Windows, DDE) laufen und zeichnet ihre Antworten auf.
- `measure.py` – lässt die emulierte laufen, vergleicht mit der Aufzeichnung, zeigt Zeiten.
- `count_instructions.py` – wie viel Code die exe je Phase ausführt.

```
pip install unicorn pefile
python record_real.py <Kopie des Ordners> <Programm.exe> <Versorgung.vsg> <Versorgung.vag> 400 recording.json
python measure.py <Ordner>/<Programm.exe> <Ordner>/<Versorgung.vsg> <Ordner>/<Versorgung.vag> 400 recording.json
```

## Messwerte

| | |
|---|---|
| importierte Funktionen der exe | 149 |
| davon wirklich aufgerufen | 75 (alle nachgebaut, keine fehlt) |
| Code beim Einlesen der Versorgung | ca. 630 Mio. Befehle, einmalig |
| Code je Steuerungsschritt | ca. 0,5–1 Mio. Befehle |
| Aufrufe nachgebauter Funktionen je Schritt | ca. 7 500–8 500 |

Der Python-Prototyp selbst ist langsam (71 s Einlesen, 180 ms je Schritt). Das liegt fast ganz
an den knapp 9 Mio. Funktionsaufrufen, die jeweils durch Python laufen, nicht am Emulator.

## Was der Test nicht zeigt

- Kein Lauf im Browser. Die Abschätzung dafür stützt sich auf die Befehlszahlen oben.
- Nur diese eine exe mit dieser Versorgung. Eine andere Steuerung kann weitere der 149 (oder
  andere) Funktionen brauchen.
- Die Steuerung liest die PC-Uhr; der Emulator bekommt für den Vergleich die Startzeit des
  echten Laufs. Zeitabhängiges Verhalten über längere Zeiträume ist nicht geprüft.
- Die exe lädt zwei optionale Bibliotheken nach (`libgcc_s_dw2-1.dll`, `InfoDLL`); beide gibt es
  im Emulator nicht, sie fehlten im Test nicht.

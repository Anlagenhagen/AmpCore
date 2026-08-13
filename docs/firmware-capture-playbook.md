# Firmware-Capture-Playbook (1.1.8 & 1.1.9)

Ziel: **abgleichbare** Wireshark-Mitschnitte von echten CVR-Amps mit Firmware **1.1.8** und **1.1.9** erzeugen, um die exakten Byte-Offsets pro Firmware für **Heartbeat (Monitoring)**, **Steuerbefehle** und **Presets** festzunageln. "Abgleichbar" heißt: zu jedem Paket wissen wir, **welche Aktion** es ausgelöst hat und **welche Werte** die Original-CVR-App dabei anzeigte.

> Warum so genau? Das Protokoll ist rein empirisch reverse-engineert. Ein Byte-Offset ist nur dann ein Fakt, wenn ein bekannter Anzeigewert eindeutig einem Byte im Paket zugeordnet werden kann. Ohne Aktions-/Wert-Protokoll sind Captures fast wertlos.

## Netz-/Protokoll-Fakten (aus dem Code)

- **Amp → App (Monitoring/Heartbeat):** UDP, App lauscht auf `0.0.0.0:**45454**`. Heartbeat = FuncCode **6**.
- **App → Amp (Steuerung/Discovery):** UDP, Ziel-Port `**45455**`. Discovery = Broadcast FuncCode **0** an `255.255.255.255:45455`.
- **NetworkData-Kennung:** erste 2 Bytes `0xd903` (LE). Danach `machineMode` (Bytes 2–3), dann Struct: `0x55`, FuncCode (Byte 11).
- **Firmware-Version:** FuncCode **28** (`CHECK_VERSION`). Presets: FuncCode **59** (`SAVE_RECALL`).

## Setup

1. **Ein PC** mit der **Original-CVR-Windows-Software** *und* **Wireshark**, direkt (wired) im selben L2-Netz wie der Amp. Idealerweise ein isoliertes Netz/VLAN (weniger Störtraffic).
2. **Gleiches Amp-Modell** für beide Firmware-Stände verwenden — die Struct-Länge hängt auch vom Modell ab. Modell notieren (z. B. DSP-1004D).
3. Wireshark-**Capture-Filter**: `udp port 45454 or udp port 45455`
   Anzeige-Filter zum Prüfen: `udp.port==45454 || udp.port==45455`
4. Alles Unnötige auf dem PC schließen (kein sonstiger UDP-Broadcast-Lärm).

## Dateibenennung

`captures/<firmware>/cvr_<modell>_fw<version>_<szenario>.pcapng`
Beispiel: `captures/1.1.8/cvr_dsp1004d_fw1.1.8_presets.pcapng`

Zu **jedem** `.pcapng` ein gleichnamiges `...__log.md` mit dem Aktions-/Wert-Protokoll (siehe Vorlage unten). **Die `.pcapng` bleiben lokal (gitignored), die `__log.md` kommen in Git.**

## Szenarien (für JEDE Firmware identisch durchführen)

Immer **eine Aktion nach der anderen**, dazwischen ~3–5 s Ruhe, damit Pakete eindeutig zuordenbar sind. Uhrzeit + Aktion + angezeigten Wert ins Log schreiben.

1. **`discovery`** – App starten / Scan auslösen. Enthält Broadcast FC=0 und die Antwort inkl. Firmware-String (FC=28). → bestätigt Versions-Encoding.
2. **`heartbeat_idle`** – Amp verbunden, ~30 s nichts tun. Baseline-Heartbeat. Angezeigte Temperaturen notieren.
3. **`heartbeat_known_values`** – Nacheinander definierte Zustände herstellen und **jeden angezeigten Wert** notieren:
   - Ausgangspegel Ch1 auf einen klaren Wert (z. B. so, dass Spannung/Meter eindeutig ist),
   - eine Last anschließen, damit Strom ≠ 0 (Impedanz-Check),
   - je Kanal Output-State ändern (an/aus/protect), Input-State ändern.
   → damit lassen sich Spannungen/Ströme/States eindeutig auf Offsets mappen.
4. **`control_single`** – Steuerbefehle **einzeln** senden, je mit notiertem Vorher/Nachher:
   Mute Ch1, Gain +3 dB Ch2, Delay Ch3, Source-Select, Standby ein/aus. → FuncCode + Payload je Befehl isolieren.
5. **`presets`** – **Der Inkompatibilitäts-Fall.** Preset in Slot N mit Namen **speichern**, dann **abrufen** (FC=59). Auf beiden Firmwares mit *gleichem* Slot/Namen. → Store/Recall-Frames der zwei Firmwares direkt vergleichbar.

## Log-Vorlage (`..._log.md`)

```
# Capture-Log
Modell:      DSP-1004D
Firmware:    1.1.8
Szenario:    heartbeat_known_values
Datum/Zeit:  2026-08-13 14:05
CVR-App-Version: <…>

## Aktionen
14:05:10  Baseline, nichts gesetzt. Temp-Anzeige: 31 °C / 32 °C
14:05:25  Ch1 Ausgang auf <x>; App zeigt Spannung <y> V, Meter <z> dBu
14:05:40  Last an Ch1; App zeigt Strom <a> A, Impedanz <b> Ω
14:05:55  Ch2 Output-State → Protect; App zeigt <state>
...
```

## Übergabe an die Entwicklung

Alles unter `captures/<firmware>/` ablegen (`.pcapng` + `__log.md`). Dann übernehme ich:
- Heartbeat-/Control-/Preset-Frames extrahieren, Offsets pro Firmware dokumentieren,
- reale Bytes als **Test-Fixtures** ablegen und **Unit-Tests** für Parser/Builder aufsetzen (Framework wird dabei eingeführt),
- `heartbeat-parser.ts` von Heuristik auf **firmware-getriebenes** Layout umstellen (Version via FC=28 → Layout-Registry, Heuristik nur als Fallback),
- Preset- und Control-Pfad auf Firmware-Kompatibilität prüfen.

## Qualitäts-Checkliste

- [ ] Beide Firmwares mit **demselben Modell** und **denselben Aktionen** aufgenommen.
- [ ] Zu jeder `.pcapng` ein `__log.md` mit Zeit/Aktion/angezeigtem Wert.
- [ ] Je Szenario nur **eine Aktion zur Zeit**, Ruhephasen dazwischen.
- [ ] CVR-App und Firmware-Versionen im Log vermerkt.

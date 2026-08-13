# Transport-Zuverlässigkeit & Write-Verifikation — Spezifikation (Work Item)

Status: **spezifiziert, Umsetzung offen** (2026-08-13).

## Problem (aus der Praxis)

Beim Arbeiten mit den Amps über AmpCore passiert regelmäßig:
- Befehle „werden nicht genommen" (kommen scheinbar nicht an / keine Wirkung),
- alles **dauert sehr lange**,
- am Ende ist die Config **unvollständig oder falsch** übertragen.

Das ist im Live-/Event-Betrieb heikel. Als Notbehelf gibt es inzwischen die Checksummen-/QoS-Geschichte beim Preset-Laden — die aber (siehe unten) nur schwach absichert.

## Ist-Zustand der Zuverlässigkeits-Mechanismen (Code-belegt)

Alles über **einen** persistenten UDP-Socket (`lib/amp-controller.ts`), Ziel-Port 45455, Empfang 45454.

**Schreiben — `sendFC` / `_sendPacketAwaitAck`:**
- Fragmentgröße 450 B (`FRAGMENT_SIZE`).
- Je Fragment: senden → auf ACK warten (**1000 ms** Timeout), bis zu **3 Versuche**.
- Ganzer Frame bis zu **3 Versuche** (`maxFrameAttempts`), 120 ms Cool-down dazwischen.
- ACK = header-only Paket mit `data_state=1`. (Firmware-Varianten 1.1.8 `1/0` vs 1.1.9 `0/450` — inzwischen robust per „header-only = ACK" gefixt.)
- Optionaler **QoS-Read-Back**: nach dem Schreiben Rücklesen und vergleichen — **aber nur `readBack.length === body.length`** (nur Länge, nicht Inhalt). QoS ist **opt-in** und beim Speaker-Apply per Default **aus**.

**Lesen — `requestFC` / `requestFC27`:**
- **2000 ms** Timeout + 1 Retry (2200 ms). Pro Amp serialisiert (`_runIpSerial`).

**Integrität:**
- `calcCheckCode` (summenbasierte 3-Byte-Prüfsumme) je Frame; eingehende Frames werden per `validateAssembledFrame` geprüft, ungültige verworfen.
- **Kein** End-to-End-Abgleich, dass der Amp den geschriebenen Wert/Block **korrekt gespeichert** hat.

## Identifizierte Schwachstellen / Hypothesen

1. **Verifikation zu schwach.** QoS prüft nur Länge, nicht Inhalt → „falsch übertragen" (richtige Länge, falsche Bytes) wird **nicht erkannt**. Und QoS ist beim Apply meist aus → viele Writes laufen **ohne jede Bestätigung**, dass sie wirklich ankamen. → deckt „kommt falsch/unvollständig an" direkt ab.
2. **Socket-Contention.** Heartbeat- + Channel-Data-Polling (FC27 = 5×460 B Reassembly, dazu Lock/Standby-Polls, ~1/s je Amp) laufen auf **demselben** Socket wie die ACK-getakteten Writes. Bei großem Apply verzögern sich ACKs → Timeouts/Retries → Langsamkeit. (Belegt: `/api/amp-presets/current` lief während eines Applys in 4,2 s Timeout, allein aufgerufen sofort ok.) → deckt „dauert lange / nimmt Befehle nicht" ab.
3. **Feste, knappe Timeouts.** 1000 ms ACK / 2000 ms Read ohne adaptiven Backoff. Auf langsamer/beschäftigter DSP oder WLAN spurious Timeouts → Retries → noch langsamer.
4. **WLAN.** Mac auf `en0` (WiFi). UDP über WLAN = mehr Loss/Jitter; die ACK-getaktete Fragmentierung ist losssensitiv. Wired/eigenes VLAN als Referenz nötig.
5. **ACK-Korrelation historisch fragil.** Zähler-Felder im ACK sind je Firmware inkonsistent (jetzt umgangen). Weitere firmware-/modellspezifische Sonderfälle möglich.
6. **Keine Idempotenz-/Reihenfolge-Garantie sichtbar.** Bei Teilfehlern (einige Fragmente/Kanäle ok, andere nicht) bleibt der Amp evtl. in **inkonsistentem Zwischenzustand** — „unvollständig übertragen".

## Plan: spezifizieren & fixen

**Phase A — Messen & reproduzieren (zuerst, ohne Rätselschluss).**
- Instrumentierung: pro Write/Read Timing, Attempts, Fragment-Retries, ACK-Latenz loggen (Transport-Metadaten gibt es schon: `frameAttempts`, `fragmentRetries`).
- Realistische Last reproduzieren: großer Apply (mehrere Kanäle/Ways) auf 1.1.8 **und** 1.1.9, mit/ohne paralleles Polling, Wired vs WLAN. Wireshark parallel.
- Zielmetriken definieren: Apply-Erfolgsquote, Dauer, Retry-Rate; „gut" = z. B. 100 % Erfolg, < X s, 0 stille Fehler.

**Phase B — Zielverhalten spezifizieren.**
- **Definierte End-to-End-Verifikation** für jeden kritischen Write (Preset/Speaker/EQ): Rücklesen und **Inhalt** (Byte/Checksumme), nicht nur Länge, vergleichen; bei Abweichung gezielt neu schreiben. QoS beim Apply **standardmäßig an**.
- **Transaktions-/Konsistenz-Modell:** klarer Erfolg/Teilerfolg-Status; bei Teilfehler definierter Rollback/Retry statt inkonsistentem Zwischenzustand.
- **Adaptive Timeouts/Backoff** statt fester Werte; ACK-Fenster an gemessene Latenz koppeln.

**Phase C — Contention entschärfen.**
- Während eines Applys Polling **drosseln/pausieren** (Priorität für den Write) oder Writes und Reads sauber serialisieren/priorisieren.
- Prüfen, ob getrennte Sockets für Poll vs Control sinnvoll sind (wie die Original-CVR-App evtl. mit ephemerem Port arbeitet).

**Phase D — Umsetzen & unter realen Bedingungen verifizieren.**
- Fixes iterativ, jeder gegen echte Hardware (beide Firmwares) + WLAN und Wired gemessen, gegen die Zielmetriken aus Phase A.

## Phase-A-Messergebnisse (2026-08-13, WLAN, installierte App mit normalem Polling)

Werkzeug: `scripts/measure-transport.py` (+ Wireshark-Analyse). 20× FC=57-Write (2,4 kB / 6 Fragmente) je Amp.

**1. Zwei Sende-Pfade mit gegensätzlichen Schwächen — zentrale Erkenntnis:**
- **ACK-getakteter Pfad** (`ampController.sendFC`, für FC=57 Speaker-Data, FIR): zuverlässig (100 % Erfolg nach ACK-Fix), aber **langsam**.
- **Fire-and-Forget-Pfad** (`CvrAmpDevice.sendControl`, für die meisten kleinen Befehle: Mute/Gain/Delay/EQ-Bänder): ephemerer Socket, **kein ACK, kein Retry, keine Prüfung** — sendet und schließt nach ~20 ms. Schnell, aber **verliert Pakete still** (unentdeckbar). Ein EQ-Apply = ~30 solcher Befehle in Folge.

**2. Der ACK-Pfad ist langsam — nicht wegen Loss, sondern wegen Contention:**
| | Erfolg | Wall median | Wall p90 | ACK-Latenz/Fragment median | ACK max |
|---|---|---|---|---|---|
| 1.1.8 | 20/20 | 762 ms | 2578 ms | 22 ms | 3149 ms |
| 1.1.9 | 20/20 | **2700 ms** | 2869 ms | **7 ms** | 3139 ms |
- Die Amps **ACKen schnell** (7–22 ms median). Ein reiner Send wäre ~150 ms + fixes 500-ms-`sleep` nach jedem Write (`app/api/amp-speaker-data`).
- Aber Wall = 2,7 s (1.1.9) → **~2 s Warten**: `sendFC` läuft über `_runIpSerial(ip)` — **denselben** Serial-Queue wie das Polling (`requestFC`/`requestFC27`). Writes warten hinter dem laufenden Poll. Der 1.1.9-FC27-Read ist größer (6 vs 5 Fragmente) → hält den Queue länger → 1.1.9 systematisch langsamer.
- **Tail-Stalls ~3,1 s** (ACK max) vereinzelt → WLAN-Loss / Amp mit FC27-Reassembly beschäftigt.
- **Hochrechnung:** ein realer Apply mit vielen Ways/Kanälen × ~2,7 s pro ACK-Write + 30 unverifizierte Fire-and-Forget-Befehle = zig Sekunden, mit stillen Teilfehlern → genau „dauert lange / nimmt nicht / falsch".

**3. Fire-and-Forget-Loss (1.1.9, benignes WLAN, 400 ms Abstand):** 20/20 korrekt. Kein Loss im guten Moment — aber ohne jedes Sicherheitsnetz; Risiko bei Bursts/schlechtem WLAN bleibt.

**Geschärfte Prioritäten aus Phase A:**
1. **Contention entschärfen (größter Hebel für „langsam"):** Polling während Writes drosseln/pausieren; Write-Priorität im `_runIpSerial`; fixes 500-ms-`sleep` überdenken (durch echte Verifikation ersetzen).
2. **Fire-and-Forget absichern (größter Hebel für „nimmt nicht / falsch"):** kritische kleine Writes über einen verifizierten Pfad (ACK oder Read-back+Vergleich) statt blind senden.
3. **Inhalts-Verifikation** (Byte/Checksumme, nicht Länge) für Batch-Applies, standardmäßig an.
4. **Wired vs WLAN** gegenmessen (Hagen: Mac per Kabel ins Amp-Netz), um WLAN-Anteil an Tail-Stalls zu quantifizieren.

## Erster umgesetzter Fix: selbst-heilender EQ-Apply (2026-08-13) ✅

Konkreter Schmerzpunkt (Hagen): Input-EQ Copy&Paste übernimmt oft nur teilweise, erst beim 2./3. Mal komplett. Gemessen (`scripts/measure-eq-loss.mjs`, EQ anwenden → FC=27 zurücklesen → gelandete Bänder zählen, 15×):

| | vorher (fire-and-forget) | nach Fix (self-healing) |
|---|---|---|
| 1.1.8 | 6/15 voll (Ø 7,1/8) | **15/15 (Ø 8,0/8)** |
| 1.1.9 | **0/15 voll (Ø 5,3/8)** | **15/15 (Ø 8,0/8)** |

**Fix** (`app/api/amp-actions/route.ts`, `eqBlock`): nach dem Apply wird der Kanal via FC=27 **zurückgelesen**, pro Band Typ/Freq/Gain/Q gegen die Vorgabe verglichen, und **nur die nicht angekommenen Bänder** gezielt nachgesendet — bis zu 4 Runden. Die Retries passieren automatisch im Handler statt durch erneutes Pasten. eqIn/eqOut liegen im Kanal-Body → korrekt lesbar unabhängig vom Trailer-Kanalzahl-Thema.

Das ist die Muster-Lösung für Phase B (Inhalts-Verifikation + gezielter Retry).

**Ausgeweitet (2026-08-13):** RMS- und Peak-Limiter-**Apply** (`rmsLimiterOut`/`peakLimiterOut`, Voll-Payload-Pfad) nutzen jetzt denselben selbst-heilenden Helper `applyVerifiedControl` (senden → FC=27-Threshold zurücklesen → bei Abweichung nachsenden, bis 3 Runden). Font-unabhängig testbar wie EQ.

**Alle Tuning-Regler bestätigt gesendet** (`applyVerifiedControl`): setzen → FC=27 zurücklesen → nachsenden, bis der Amp den Wert wirklich hat (bis 3 Runden). Grund (Hagen, klar priorisiert): **Sicherheit vor Tempo** — „ich stelle etwas ein und weiß nicht ob's passiert ist" macht die Software beim Messen wertlos. Der kleine Bestätigungs-Moment ist gewollt (Frontend kann dazu einen kurzen Lade-/Pending-Zustand zeigen und `verified:false` als Warnung).

Abgedeckt & an echter Hardware verifiziert (`verified=true` + unabhängiges Rücklesen): `muteIn/muteOut`, `volumeOut/volumeIn`, `outputTrim`, `delayIn/delayOut`, `invertPolarityOut`, `noiseGateOut`, `powerModeOut`, `sourceType`, `eqBandType/Freq/Gain/Q`, `crossoverEnabled/crossoverFreq`, `firBypass`, `eqBlock`, `rmsLimiterOut/peakLimiterOut`. Alle Response enthält jetzt `verified`.

Noch offen (seltener/kein FC=27-Feld direkt): `setAmpLock` (Lock-Readback separat), `bridgePair`, `matrixGain/matrixActive`, `sourceDelay/sourceTrim`, `analogType`, `backupConfig`, `renameAmp/Input/Output`, `firData`. `setAmpStandby` hat bereits korrekte absolute Logik. Bei Bedarf mit demselben Muster nachrüstbar.

## Bezug zu bereits Gefundenem

Der FC=57-ACK-Fix (siehe `findings.md`) war ein Einzelfall dieses Themas (falsch verworfenes ACK → Timeout). Diese Spezifikation adressiert die **systemische** Zuverlässigkeit, nicht nur den Einzelfall.

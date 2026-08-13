# CLAUDE.md – AmpCore

Leitfaden für KI-Assistenten (Claude, Codex) in diesem Repo. `AGENTS.md` verweist hierher.

## Was AmpCore ist

Desktop-App (Electron + Next.js) zur **Steuerung und Überwachung vernetzter CVR-DSP-Endstufen** über ein reverse-engineertes **UDP-Protokoll**. Fork von `scalli007YT/AmpCore` (Upstream, MIT) unter `Anlagenhagen/AmpCore`.

- **Tech:** Next.js 16, React 19, TypeScript, Tailwind 4, shadcn/ui, Electron (electron-forge), Zustand-Stores.
- **Paketmanager:** `pnpm` (Node 20+). Kein npm/yarn.
- **Demo-Modus:** "Demo Amps" (DSP-1002/1004/1002D/1004D) → Entwicklung ohne Hardware.

## Aktueller Arbeitsschwerpunkt

**Firmware 1.1.8 und 1.1.9 in gemischter Flotte zuverlässig betreiben.** Symptome bei gemischter Firmware: falsche Monitoring-Werte, wirkungslose Steuerbefehle, inkompatible Presets.

Kernstelle: **`lib/network/heartbeat-parser.ts`** — Heartbeat-Struct-Offsets (FuncCode 6) verschieben sich je Firmware. Der Parser rät das Layout aktuell heuristisch (`looksLikeStateBlock`), statt die per `FuncCode.CHECK_VERSION = 28` verfügbare Firmware-Version zu nutzen. Ziel: versionsgetriebenes Parsen, Heuristik nur als Fallback.

Arbeits-Branch: `feat/firmware-1.1.x-harmonization`.

## Protokoll-Architektur (Einstiegspunkte)

- `lib/network/protocol.ts` — NetworkData-Header (`0xd903`), StructHeader, Checksumme, UDP-Fragment-Reassembly.
- `lib/network/heartbeat-parser.ts` / `heartbeat-structs.ts` — Heartbeat-Decoding je Modell/Firmware.
- `lib/amp-device.ts` — `CvrAmpDevice`, `FuncCode`-Tabelle (Control-Befehle), Sende-Port `45455`.
- `lib/amp-controller.ts` — persistenter Monitor-Socket, Polling.
- `stores/AmpStore.ts` — Zustand-State inkl. Firmware-Version-Feld.
- Protokoll ist empirisch (Wireshark + Original-CVR-Windows-App C#-Quelle + Python-Helper). Änderungen immer gegen echte Captures/Hardware verifizieren.

## Entwicklung

```bash
pnpm install
pnpm dev            # nur Web-UI
pnpm electron:dev   # Desktop (Electron)
pnpm lint
pnpm format:check
```

Noch **kein Test-Framework** vorhanden — beim Parser-Umbau eins einführen (Vorschlag: vitest) und reale Heartbeat-Bytes als Fixtures/Test-Vektoren ablegen.

## Regeln für KI-Assistenten

- **Sprache:** Deutsch (außer explizit anders).
- **Protokoll-Änderungen nie raten** — nur mit Beleg aus Capture, Original-C#-Quelle oder Hardware-Test. Reverse-engineerte Offsets/FuncCodes sind Fakten, keine Vermutungen.
- **Vor größeren Änderungen** relevante Obsidian-Notizen prüfen; Vault: `/Users/hagensablotny/Documents/Obsidian/Hagen - Allgemein/`, Projektnotiz `AmpCore – CVR Amp Management.md`, Cowork-Ordner `AI-Cowork/`.
- **Nach relevanter Arbeit** Obsidian aktualisieren: Entscheidungen, offene Punkte, Projektstand, Status-Log.
- **Upstream-Respekt:** Wir sind ein Fork. Änderungen so halten, dass ein sauberer PR an Upstream möglich bleibt.

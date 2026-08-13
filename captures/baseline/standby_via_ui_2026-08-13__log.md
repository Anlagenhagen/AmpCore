# Capture-Log — Standby via AmpCore-UI (Ground Truth)

- **Datei:** `standby_via_ui_2026-08-13.pcapng` (gitignored), 20 s, en0.
- **Aktion:** In der laufenden AmpCore (localhost:3000, von Claude via Browser gesteuert) „Standby amp" für beide Amps geklickt.
- **Ergebnis:** Befehl `FC15 statusCode=0 body=01` (Mac→Amp). Beide `[8,8,8,8]Run → [1,1,1,1]Standby`.
- **Befund:** FC15 body01 = **Toggle** (nicht absolut); body00 = No-Op. Details in `docs/findings.md`.
- **Amps danach:** Standby (wie ursprünglich vorgefunden). ✅

# Capture-Log — Standby/Wake-Test

- **Datei:** `standby_test_2026-08-13.pcapng` (gitignored), Dauer 36 s, en0.
- **Aktionen (UTC):** via `scripts/send-control.mjs seq-standby`
  - `.73` (1.1.8): STANDBY_DATA `01` @01:30:16, `00` @01:30:22
  - `.203` (1.1.9): STANDBY_DATA `01` @01:30:28, `00` @01:30:34
- **Beobachtung:** Output-States @52 wechselten `[1,1,1,1]`(Standby) → `[2,2,2,2]`(Fault-Transient) → `[8,8,8,8]`(Run). Body `00` setzte nicht zurück nach Standby.
- **Nachlauf:** Amps stehen danach auf `[8,8,8,8]` = **Run** (sicher, normal). Wiederhol-`00` (01:32:39) brachte sie nicht in Standby — Standby-Rückkehr noch offen.
- Auswertung/Details: siehe `docs/findings.md`.

Reproduktion:
```bash
scripts/capture-amps.sh captures/baseline/standby_test.pcapng 36 en0   # im Hintergrund
node scripts/send-control.mjs seq-standby --a 192.168.20.73 --b 192.168.20.203
python3 scripts/decode-heartbeat.py captures/baseline/standby_test.pcapng --timeline
```

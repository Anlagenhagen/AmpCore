# CVR DSP protocol notes

Reverse-engineered against real hardware (DSP-2004D and DSP-3302D on FW `…006118`,
DSP-3004D on FW `…106119`). Everything below was confirmed by reading bytes back
from a device, not inferred from the C# reference alone. Offsets are decimal.

Ports: amp → app `45454`, app → amp `45455`.

---

## FC=27 — channel data

The payload is a sequence of **515-byte channel bodies** followed by a **trailer**.
Two separate quantities matter, and conflating them causes real bugs:

| | meaning |
|---|---|
| **body count** | how many 515-byte bodies the device actually sent — determines where the trailer starts |
| **channel count** | how many channels are usable — comes from `Output_chx` in the FC=0 discovery reply |

They are **not** the same:

- A **2-channel DSP-3302D sends four bodies**, same 2232-byte payload as a
  4-channel DSP-2004D. Bodies 3 and 4 are placeholders, named `OutC` / `OutD`.
  Deriving the trailer position from the usable channel count lands 1030 bytes
  early, in the middle of body 3.
- **FW `…106119` sends a larger trailer**: 2687 bytes total for a 4-channel amp,
  where `…006118` sends 2232. Plain `floor(length / 515)` yields 5 and pushes the
  trailer 515 bytes late.

One rule covers both — take the largest body count whose remainder is still large
enough to be a trailer:

```
bodies = max n ≤ floor(length / 515)  such that  length − n·515 ≥ 136 + n
```

| payload | bodies | trailer | note |
|---|---|---|---|
| 2232 B (4-channel, `…006118`) | 4 | 172 B | |
| 2232 B (**2**-channel, `…006118`) | 4 | 172 B | two placeholder bodies |
| 2687 B (4-channel, `…106119`) | 4 | 627 B | 5 would leave only 112 B |

### Trailer fields (relative to `bodies × 515`)

| offset | field |
|---:|---|
| 33 | rotary lock |
| 132 + ch | `muteIn` for channel `ch` |
| 136 + ch | analog matrix source |
| 140 | flow priority |
| 176 | DD priority |

**`muteIn` polarity is inverted on the wire: `0` = muted, `1` = unmuted.**

### EQ blocks (inside a channel body)

`eqIn` starts at 121, `eqOut` at 262. Ten bands each (HP, EQ1–8, LP),
**stride 14 bytes**:

| offset | field |
|---:|---|
| +0 | filter type (`uint8`) |
| +1 | gain dB (`float32` LE) |
| +5 | frequency Hz (`float32` LE) |
| +9 | Q (`float32` LE) |
| +13 | bypass flag (`uint8`) |

Bypass is encoded **twice**: either the flag at +13 is non-zero, or the type byte
is ≥ 128, in which case the real type is `255 − rawType`.

---

## FC=57 — speaker data

Variant is detected by body length: 157 (YCST), 2216 (115), 2252 (116),
2294 (Phonic), 2310 (117), 2415 (Tecnare).

### `deviceName` at 0..31 does not round-trip

The first 32 bytes hold a device identity string (e.g. `…-DSP-3302D`). **The amp
stamps its own identity there on store, regardless of what was written.**

This matters for read-back verification. Applying a preset captured on one model
to a different model and reading it back: of 2415 bytes, **exactly those 32
differed** — the entire preset payload (EQ, crossover, limiter, delay) was
byte-identical. A verification that compares the full blob therefore reports a
correctly applied preset as failed whenever the preset came from a different amp.
Compare from byte 32 onwards.

A length-only check is not sufficient either — it passes even when the stored
content is wrong.

### `speakerName` offsets

| body length | offset |
|---:|---:|
| 157 | 141 |
| 2310 | 2294 |
| 2415 | 2294 |

### ACK shape differs by firmware

FW `…106119` answers a fragmented FC=57 write with a **header-only ACK**
(no body). Requiring a body-carrying ACK makes speaker preset apply hang on that
firmware.

---

## FC=15 — standby

`statusCode = 0`, body is **absolute, not a toggle**:

- `body = 0x01` → set standby
- `body = 0x00` → set run

Verified with isolated single commands while watching the heartbeat output-state
bytes. (An earlier assumption that this was a toggle was wrong: state code `8`
is `Run`, and had been misread as a stuck standby.)

---

## FC=6 — heartbeat

Body is 92 bytes on both firmwares for the 4-channel D series.

| offset | field |
|---:|---|
| 0..19 | 5 × `float32` temperatures |
| 20, 36, 56, 72 | outV / outI / inV / limiter (zero while idle) |
| 52..55 | output state, one byte per channel |
| 88..91 | input state, one byte per channel |

Output state codes: `0 Normal, 1 Standby, 2 Fault, 3 Open, 4 Overload, 5 Clip,
6 Dcp, 7 PowerEr, 8 Run, 9 Temp, 10 Limit, 11 Sleep`. Code `2` also appears
transiently while powering up and is not a real fault there.

---

## FC=59 — presets

Body is 34 bytes: `[0] mode, [1] slot, [2..33] 32-byte ASCII name`.
Modes observed: `1` store, `2` recall, `4` read names.
An empty slot answers with the name `Null`.

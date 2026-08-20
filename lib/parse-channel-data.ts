import type { SourceCapabilities } from "@/lib/source-capabilities";

/**
 * Parser for FC=27 (Synchronous_data) packets from amplifier channel data
 *
 * Response Structure:
 *   N channels × 515 bytes per channel + trailer/padding
 *
 * Each Channel Body (515 bytes) — Absolute offsets in full response:
 *   Channel 0: starts at byte 0
 *   Channel 1: starts at byte 515
 *   Channel 2: starts at byte 1030
 *   Channel 3: starts at byte 1545
 */

export interface MatrixSource {
  /** Source index (0–3 → AIn1–AIn4) */
  source: number;
  /** Crosspoint gain in dB (float32) */
  gain: number;
  /** false = this source is muted/disabled at this crosspoint */
  active: boolean;
}

export interface ChannelInputSource {
  /** Source family key from the original software model. */
  key: "analog" | "dante" | "aes3" | "backup";
  /** UI label (e.g. Analog-1, Dante-3, AES3-2, Backup). */
  type: string;
  /** Per-source matching delay in ms. */
  delay: number;
  /** Per-source matching trim in dB. */
  trim: number;
  /** True when this source is currently selected for the channel. */
  selected: boolean;
  /** Backup/auto-source settings reported by the original controller. */
  backup?: {
    enabled: boolean;
    thresholdDb: number;
    priorityOrder: Array<"analog" | "dante" | "aes3">;
    activeSourceKey: "analog" | "dante" | "aes3";
  };
}

/**
 * One parametric EQ band.
 * Wire layout per band (14 bytes, stride 14):
 *   byte(type) | float32(gain dB) | float32(freq Hz) | float32(Q) | byte(bypass)
 *
 * Parametric type codes from the original CVR controller UI:
 *   0  = Peaking
 *   1  = Low_Shelf
 *   2  = High_Shelf
 *   3  = All_Pass-1st
 *   4  = All_Pass-2nd
 *   5  = General_Low
 *   6  = General_High
 *   7  = Butterworth_Low
 *   8  = Butterworth_High
 *   9  = Bessel_Low
 *   10 = Bessel_High
 *   255 = Bypassed (band is inactive regardless of other fields)
 *
 * HP/LP positions (band 0 and band 9) use their own crossover type codes.
 * type=255 means the entire band slot is bypassed.
 */
export const EQ_FILTER_TYPE_NAMES: Record<number, string> = {
  0: "Peaking",
  1: "Low_Shelf",
  2: "High_Shelf",
  3: "All_Pass-1st",
  4: "All_Pass-2nd",
  5: "General_Low",
  6: "General_High",
  7: "Butterworth_Low",
  8: "Butterworth_High",
  9: "Bessel_Low",
  10: "Bessel_High"
};

export interface EqFilterTypeCapabilities {
  supportsGain: boolean;
  supportsQ: boolean;
}

export function getEqFilterTypeCapabilities(type: number): EqFilterTypeCapabilities {
  switch (type) {
    case 0:
    case 1:
    case 2:
      return { supportsGain: true, supportsQ: true };
    case 3:
      return { supportsGain: false, supportsQ: false };
    case 4:
    case 5:
    case 6:
      return { supportsGain: false, supportsQ: true };
    case 7:
    case 8:
    case 9:
    case 10:
      return { supportsGain: false, supportsQ: false };
    default:
      return { supportsGain: true, supportsQ: true };
  }
}

export const POWER_MODE_NAMES: Record<number, string> = {
  0: "Low-Ω",
  1: "70V",
  2: "100V"
};

export function getPowerModeName(mode: number): string {
  return POWER_MODE_NAMES[mode] ?? `Mode ${mode}`;
}

/**
 * HP/LP rolloff filter types — indices match the C# HPorLP_InttoString array.
 * Used by band 0 (HP) and band 9 (LP).
 */
export const HPLP_FILTER_TYPE_NAMES: Record<number, string> = {
  0: "BW-12",
  1: "BE-12",
  2: "LR-12",
  3: "BW-18",
  4: "BW-24",
  5: "BE-24",
  6: "LR-24",
  7: "BW-36",
  8: "BW-48",
  9: "BE-48",
  10: "LR-48"
};

/** Resolve a filter type code to its display name, considering band position. */
export function getFilterTypeName(type: number, bandIndex: number): string {
  // Band 0 (HP) and band 9 (LP) use the HP/LP rolloff lookup
  if (bandIndex === 0 || bandIndex === 9) {
    return HPLP_FILTER_TYPE_NAMES[type] ?? EQ_FILTER_TYPE_NAMES[type] ?? String(type);
  }
  return EQ_FILTER_TYPE_NAMES[type] ?? String(type);
}

export interface EqBand {
  /** Filter type code. 255 = band bypassed. See EQ_FILTER_TYPE_NAMES. */
  type: number;
  /** Gain in dB (float32) */
  gain: number;
  /** Centre/corner frequency in Hz (float32) */
  freq: number;
  /** Q factor (float32) */
  q: number;
  /** true = band is bypassed (type===255 or bypass byte set) */
  bypass: boolean;
}

export interface ChannelData {
  channel: number;
  inputName: string; // e.g., "AIn1" – "AIn4"
  outputName: string; // e.g., "OutA" – "OutD"
  gainIn: number; // dB  (int8)
  volumeOut: number; // dB  (float32 @ 405)
  muteIn: boolean; // true = muted  (wire: 0=muted, 1=unmuted — inverted)
  delayIn: number; // ms  (float32 @ 86)
  trimOut: number; // dB  (float32 @ 80) — original 118/IAG path calls this vol_out / VolumeOut
  muteOut: boolean; // true = muted  (wire: 0=muted, 1=unmuted @ 84)
  noiseGateOut: boolean; // true = noise gate enabled  (wire: 0=on, 1=off @ 409)
  delayOut: number; // ms  (float32 @ 90)
  invertedOut: boolean; // true = polarity flipped  (uint8 @ 94)
  /** Raw dzdy/CPCR mode byte from FC=27. Observed: 0=Low-Ω 1=70V 2=100V. */
  powerMode: number;
  /** Raw source selector byte (0=Analog, 1=Dante, 2=AES3, 3=Backup on compatible models). */
  sourceTypeCode: number;
  /** Selected source label, e.g. Analog-1 / Dante-2 / AES3-1 / Backup. */
  sourceType: string;
  /** Delay value of the currently selected source. */
  sourceDelay: number;
  /** Trim value of the currently selected source. */
  sourceTrim: number;
  /** Per-source values shown in the original Source dialog (Delay/Trim blocks). */
  sourceInputs: ChannelInputSource[];
  /** RMS limiter settings */
  rmsLimiter: {
    /** false = bypassed (wire: byte @102, 1=bypassed, 0=active) */
    enabled: boolean;
    /** Vrms threshold — float32 LE @ 98 */
    thresholdVrms: number;
    /** ms (uint16LE @ 95) */
    attackMs: number;
    /** n × Attack (uint8 @ 97) */
    releaseMultiplier: number;
    /** Power at threshold into the configured load (W). Computed after parse. */
    prmsW: number;
  };
  /** Peak limiter settings */
  peakLimiter: {
    /** false = bypassed (wire: byte @116, 1=bypassed, 0=active) */
    enabled: boolean;
    /** Vp threshold (float32 @ 112) */
    thresholdVp: number;
    /** ms (uint16LE @ 108) */
    holdMs: number;
    /** ms (uint16LE @ 110) */
    releaseMs: number;
    /** Peak power at threshold into the configured load (W). Computed after parse. */
    ppeakW: number;
  };
  /** 4 matrix crosspoint entries — one per input source (offsets 60, 65, 70, 75) */
  matrix: MatrixSource[];
  /** 10-band input EQ (HP + EQ1–8 + LP), starting at offset 121 */
  eqIn: EqBand[];
  /** 10-band output EQ (HP + EQ1–8 + LP), starting at offset 262 */
  eqOut: EqBand[];
  /** FIR filter bypass state. true = FIR bypassed (off). Wire: byte @404, 0=enabled 1=bypassed. */
  firBypassed: boolean;
}

// ---------------------------------------------------------------------------
// Field layout — edit offsets/lengths here, nothing else needs to change
// ---------------------------------------------------------------------------

const BYTES_PER_CHANNEL = 515;

/**
 * Each entry describes one field within a single 515-byte channel body.
 *
 * type  "int8"    → buffer.readInt8(offset)
 *       "float32" → buffer.readFloatLE(offset)
 *       "ascii"   → buffer.slice(offset, offset + length).toString("ascii"), null-stripped
 */
const CHANNEL_FIELDS = [
  { field: "gainIn", type: "int8", offset: 117 },
  { field: "delayIn", type: "float32", offset: 86 },
  { field: "trimOut", type: "float32", offset: 80 }, // IAG/118 vol_out float field used by the original output trim UI
  { field: "muteOut", type: "uint8", offset: 84 }, // 0 = muted, 1 = unmuted
  { field: "noiseGateOut", type: "uint8", offset: 409 }, // 0 = enabled, 1 = disabled
  { field: "delayOut", type: "float32", offset: 90 },
  { field: "invertedOut", type: "uint8", offset: 94 },
  { field: "volumeOut", type: "float32", offset: 405 },
  { field: "inputName", type: "ascii", offset: 414, length: 16 },
  { field: "outputName", type: "ascii", offset: 430, length: 16 }
] as const;

/**
 * muteIn lives in the trailer that follows the channel bodies.
 * Empirically confirmed by diffing live snapshots with known mute states.
 *
 * Trailer byte layout (relative to trailer start = channelCount × 515):
 *   rel 132 + ch = muteIn for channel index ch
 *
 * Wire encoding: 0 = muted, 1 = unmuted (active-low / inverted).
 */
const TRAILER_MUTE_IN_REL_OFFSET = 132;
const TRAILER_ANALOG_MATRIX_REL_OFFSET = 136;
const TRAILER_FLOW_PRIORITY_REL_OFFSET = 140;
const TRAILER_DD_PRIORITY_REL_OFFSET = 176;
// Reverse-engineered from original C# sync structs:
// trailer[32]=standby, trailer[33]=encoder_to_lock.Rotary_lock (0/1).
const TRAILER_ROTARY_LOCK_REL_OFFSET = 33;
// DP_1 variant maps lock via `DisplayLock`, located just before a 485-byte tail padding block.
const DP1_DISPLAY_LOCK_FROM_END = 486;

type PrimarySourceKey = "analog" | "dante" | "aes3";

function clampSourceCode(code: number): number {
  if (code >= 3) return 3;
  if (code <= 0) return 0;
  if (code === 1) return 1;
  return 2;
}

function resolvePrimarySourceKey(code: number, capabilities?: SourceCapabilities): PrimarySourceKey {
  if (code <= 0) return "analog";
  if (code === 1 && capabilities && !capabilities.hasDante && capabilities.hasAes3) {
    return "aes3";
  }
  if (code === 2) return "aes3";
  return "dante";
}

function sourceNameFromCode(code: number, capabilities?: SourceCapabilities): "analog" | "dante" | "aes3" | "backup" {
  if (code >= 3) return "backup";
  switch (code) {
    case 1:
      return resolvePrimarySourceKey(code, capabilities);
    case 2:
      return "aes3";
    default:
      return "analog";
  }
}

function buildSourceTypeLabel(key: "analog" | "dante" | "aes3" | "backup", index: number): string {
  if (key === "backup") return "Backup";
  const safeIndex = Number.isFinite(index) ? Math.max(1, Math.floor(index)) : 1;
  if (key === "analog") return `Analog-${safeIndex}`;
  if (key === "dante") return `Dante-${safeIndex}`;
  return `AES3-${safeIndex}`;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Resolve the FC=27 channel count.
 *
 * The per-channel body is a fixed 515 bytes, but the trailer that follows them
 * varies in size between firmware versions (e.g. FW 1.1.9 sends a larger trailer
 * than 1.1.8). Deriving the count from the total buffer length therefore
 * over-counts on larger-trailer firmware — a 4-channel 1.1.9 amp yields
 * floor(2687/515)=5, a phantom extra channel that shifts `trailerBase` and every
 * trailer-relative field (muteIn, analog matrix, priorities, rotary lock).
 *
 * When the authoritative channel count from FC=0 discovery (Output_chx) is
 * available we trust it, clamped to what the buffer can physically hold so the
 * channel-body reads stay in bounds. Otherwise we fall back to the length-derived
 * count (unchanged legacy behaviour).
 */
function resolveFC27ChannelCount(bufferLength: number, authoritativeChannelCount?: number): number {
  const bodies = resolveFC27BodyCount(bufferLength);
  if (authoritativeChannelCount && authoritativeChannelCount > 0) {
    return bodies > 0 ? Math.min(authoritativeChannelCount, bodies) : authoritativeChannelCount;
  }
  return bodies;
}

/**
 * How many 515-byte channel bodies precede the trailer.
 *
 * This is NOT the number of usable channels: a 2-channel DSP-3302D still sends
 * four bodies (the last two are placeholders named "OutC"/"OutD"), so its buffer
 * is the same 2232 bytes as a 4-channel DSP-2004D. The trailer therefore starts
 * after four bodies on both — deriving its position from the usable channel
 * count would land 1030 bytes early, in the middle of a channel body, making
 * every trailer field (muteIn, analog matrix, priorities, rotary lock) garbage.
 *
 * Plain floor(length / 515) is wrong the other way: FW 1.1.9 sends a larger
 * trailer, so a 4-channel amp's 2687-byte buffer yields 5 and shifts the trailer
 * 515 bytes late.
 *
 * Both cases fall out of one rule — take the largest body count the buffer could
 * hold whose remainder is still big enough to be a trailer:
 *   1.1.8, 4 or 2 channels (2232 B): 4 bodies, 172 B trailer  ✓
 *   1.1.9, 4 channels     (2687 B): 5 would leave 112 B (too small) → 4, 627 B ✓
 */
function resolveFC27BodyCount(bufferLength: number): number {
  const maxBodies = Math.max(0, Math.floor(bufferLength / BYTES_PER_CHANNEL));
  for (let bodies = maxBodies; bodies > 0; bodies--) {
    const trailerBytes = bufferLength - bodies * BYTES_PER_CHANNEL;
    // The trailer must at least cover the per-channel fields we read from it.
    if (trailerBytes >= TRAILER_ANALOG_MATRIX_REL_OFFSET + bodies) return bodies;
  }
  return maxBodies;
}

/**
 * Parse FC=27 response (N consecutive channel bodies, each 515 bytes)
 *
 * @param hexData - Raw hex string from FC=27 response
 * @param capabilities - source capabilities for label resolution
 * @param authoritativeChannelCount - Output_chx from FC=0 discovery (preferred
 *   over the length-derived count; see resolveFC27ChannelCount)
 * @returns Array of ChannelData objects (one per parsed channel)
 */
export function parseFC27Channels(
  hexData: string,
  capabilities?: SourceCapabilities,
  authoritativeChannelCount?: number
): ChannelData[] {
  if (!hexData || hexData.length < 200) {
    return [];
  }

  try {
    const buffer = Buffer.from(hexData, "hex");
    const channels: ChannelData[] = [];
    const channelCount = resolveFC27ChannelCount(buffer.length, authoritativeChannelCount);
    // The trailer sits after ALL channel bodies the device sent — on an amp with
    // fewer usable channels than body slots (2-channel DSP-3302D) that is more
    // than channelCount, so this must not be derived from the channel count.
    const trailerBase = resolveFC27BodyCount(buffer.length) * BYTES_PER_CHANNEL;

    const analogMatrix = Array.from({ length: channelCount }, (_, ch) => {
      const abs = trailerBase + TRAILER_ANALOG_MATRIX_REL_OFFSET + ch;
      const raw = abs < buffer.length ? buffer.readUInt8(abs) : ch;
      return raw + 1;
    });

    for (let ch = 0; ch < channelCount; ch++) {
      // Read muteIn from the trailer (not from the per-channel body)
      const muteInAbs = trailerBase + TRAILER_MUTE_IN_REL_OFFSET + ch;
      const muteIn = muteInAbs < buffer.length ? buffer.readUInt8(muteInAbs) === 0 : true;

      const channelData = parseChannelFromBuffer(
        ch,
        buffer,
        ch * BYTES_PER_CHANNEL,
        muteIn,
        analogMatrix[ch] ?? ch + 1,
        channelCount,
        trailerBase,
        capabilities
      );
      if (channelData) channels.push(channelData);
    }

    return channels;
  } catch {
    return [];
  }
}

/**
 * Parse the amplifier rotary lock flag from an FC=27 payload trailer.
 *
 * Returns:
 * - true/false when the byte is available
 * - undefined when payload is too short or malformed
 */
export function parseFC27RotaryLock(hexData: string, authoritativeChannelCount?: number): boolean | undefined {
  if (!hexData || hexData.length < 200) {
    return undefined;
  }

  try {
    const buffer = Buffer.from(hexData, "hex");
    const channelCount = resolveFC27ChannelCount(buffer.length, authoritativeChannelCount);
    // Same as in parseFC27Channels: the trailer follows every channel body the
    // device sent, which is not the same as the number of usable channels.
    const trailerBase = resolveFC27BodyCount(buffer.length) * BYTES_PER_CHANNEL;
    const lockAbs = trailerBase + TRAILER_ROTARY_LOCK_REL_OFFSET;
    const dp1DisplayLockAbs = buffer.length - DP1_DISPLAY_LOCK_FROM_END;

    const trailerLock = lockAbs >= 0 && lockAbs < buffer.length ? buffer.readUInt8(lockAbs) : undefined;
    const dp1DisplayLock =
      dp1DisplayLockAbs >= 0 && dp1DisplayLockAbs < buffer.length ? buffer.readUInt8(dp1DisplayLockAbs) : undefined;

    // Original parser semantics are strict: lock is true only when byte == 1.
    // Non-binary values are treated as invalid/unknown instead of truthy.
    const decodeLockByte = (value: number | undefined): boolean | undefined => {
      if (value === 1) return true;
      if (value === 0) return false;
      return undefined;
    };
    const trailerLockDecoded = decodeLockByte(trailerLock);
    const dp1DisplayLockDecoded = decodeLockByte(dp1DisplayLock);

    // DP_1-style payloads expose lock through DisplayLock instead of encoder_to_lock.Rotary_lock.
    if (channelCount <= 2 && dp1DisplayLockDecoded !== undefined) {
      return dp1DisplayLockDecoded;
    }

    if (trailerLockDecoded !== undefined) {
      return trailerLockDecoded;
    }

    if (channelCount <= 2 && dp1DisplayLockDecoded !== undefined) {
      return dp1DisplayLockDecoded;
    }

    return undefined;
  } catch {
    return undefined;
  }
}

function parseChannelFromBuffer(
  channelNum: number,
  buffer: Buffer,
  base: number,
  muteIn: boolean,
  analogInputIndex: number,
  matrixSourceCount: number,
  trailerBase: number,
  capabilities?: SourceCapabilities
): ChannelData | null {
  try {
    // Accumulate raw values by reading each field definition
    const raw: Record<string, number | string> = {};

    for (const def of CHANNEL_FIELDS) {
      const abs = base + def.offset;
      switch (def.type) {
        case "int8":
          raw[def.field] = buffer.readInt8(abs);
          break;
        case "uint8":
          raw[def.field] = buffer.readUInt8(abs);
          break;
        case "float32":
          raw[def.field] = buffer.readFloatLE(abs);
          break;
        case "ascii":
          raw[def.field] =
            buffer
              .slice(abs, abs + def.length)
              .toString("ascii")
              .split("\0")[0] || `Ch${channelNum}${def.field}`;
          break;
      }
    }

    const round2 = (n: number) => Math.round(n * 100) / 100;

    // Matrix: 4 sources × 5-byte struct [float32 gain][uint8 active] starting at offset 60
    const MATRIX_BASE = 60;
    const MATRIX_STRIDE = 5;
    const matrix: MatrixSource[] = Array.from({ length: matrixSourceCount }, (_, src) => {
      const off = base + MATRIX_BASE + src * MATRIX_STRIDE;
      return {
        source: src,
        gain: round2(buffer.readFloatLE(off)),
        active: buffer.readUInt8(off + 4) !== 0
      };
    });

    // EQ bands: 10 bands × 14-byte struct per band
    //   sbyte(type) | float32(gain dB) | float32(freq Hz) | float32(Q) | byte(bypass)
    //
    // Bypass is encoded in the sign of the type byte (C# sbyte convention):
    //   rawType >= 128  → band is bypassed; actual filter type = 255 - rawType
    //   e.g. 253 (0xFD = sbyte -3) = bypassed HighShelf (type 2)
    //        254 (0xFE = sbyte -2) = bypassed LowShelf  (type 1)
    //        255 (0xFF = sbyte -1) = bypassed Peak       (type 0)
    // The 14th byte is a secondary bypass flag; either condition means bypass.
    const EQ_BAND_STRIDE = 14;
    const EQ_BANDS = 10;

    const parseEqBlock = (blockOffset: number): EqBand[] =>
      Array.from({ length: EQ_BANDS }, (_, i) => {
        const off = base + blockOffset + i * EQ_BAND_STRIDE;
        const rawType = buffer.readUInt8(off);
        const isBypassEncoded = rawType >= 128; // negative sbyte = band bypassed
        const type = isBypassEncoded ? 255 - rawType : rawType;
        const bypass = isBypassEncoded || buffer.readUInt8(off + 13) !== 0;
        return {
          type,
          gain: round2(buffer.readFloatLE(off + 1)),
          freq: round2(buffer.readFloatLE(off + 5)),
          q: round2(buffer.readFloatLE(off + 9)),
          bypass
        };
      });

    const eqIn = parseEqBlock(121);
    const eqOut = parseEqBlock(262);

    // Raw output power/distribution mode (C# dzdy / CPCR byte).
    // Layout matches the original sync structs: output EQ block including its
    // trailing bypass byte ends at offset 402, followed by dzdy at 403.
    const powerMode = buffer.readUInt8(base + 403);

    // FIR bypass: 1 byte at offset 404 (right after dzdy).
    // Wire encoding: 0 = FIR enabled, 1 = FIR bypassed.
    const firBypassed = buffer.readUInt8(base + 404) !== 0;

    const rawSourceTypeCode = buffer.readUInt8(base + 85);
    const backupSelected = rawSourceTypeCode >= 3;
    const sourceTypeCode = clampSourceCode(rawSourceTypeCode);
    const activeSourceKey = resolvePrimarySourceKey(rawSourceTypeCode % 3, capabilities);
    const analogTrim = round2(buffer.readFloatLE(base + 36));
    const analogDelay = round2(buffer.readFloatLE(base + 40));
    const danteTrim = round2(buffer.readFloatLE(base + 44));
    const danteDelay = round2(buffer.readFloatLE(base + 48));
    const aesTrim = round2(buffer.readFloatLE(base + 52));
    const aesDelay = round2(buffer.readFloatLE(base + 56));

    const availablePriorityKeys: PrimarySourceKey[] = ["analog"];
    if (capabilities?.hasDante) availablePriorityKeys.push("dante");
    if (capabilities?.hasAes3) availablePriorityKeys.push("aes3");
    if (availablePriorityKeys.length === 1 && matrixSourceCount > 1) {
      availablePriorityKeys.push("dante");
    }

    let backupSourceConfig: ChannelInputSource["backup"];
    if (capabilities?.hasBackup) {
      if (capabilities.hasDante && capabilities.hasAes3) {
        const priorityBase = trailerBase + TRAILER_FLOW_PRIORITY_REL_OFFSET + channelNum * 4;
        if (priorityBase + 3 < buffer.length) {
          const first = resolvePrimarySourceKey(buffer.readUInt8(priorityBase), capabilities);
          const second = resolvePrimarySourceKey(buffer.readUInt8(priorityBase + 1), capabilities);
          const enabled = buffer.readUInt8(priorityBase + 2) === 1;
          const thresholdDb = buffer.readInt8(priorityBase + 3);
          const priorityOrder = Array.from(
            new Set([first, second, ...availablePriorityKeys.filter((key) => key !== first && key !== second)])
          );

          backupSourceConfig = {
            enabled,
            thresholdDb,
            priorityOrder,
            activeSourceKey
          };
        }
      } else {
        const priorityBase = trailerBase + TRAILER_DD_PRIORITY_REL_OFFSET + channelNum * 3;
        if (priorityBase + 2 < buffer.length) {
          const enabled = buffer.readUInt8(priorityBase) === 1;
          const first = resolvePrimarySourceKey(buffer.readUInt8(priorityBase + 1), capabilities);
          const thresholdDb = buffer.readInt8(priorityBase + 2);
          const priorityOrder = Array.from(new Set([first, ...availablePriorityKeys.filter((key) => key !== first)]));

          backupSourceConfig = {
            enabled,
            thresholdDb,
            priorityOrder,
            activeSourceKey
          };
        }
      }
    }

    const danteIndex = channelNum + 1;
    const aesIndex = channelNum + 1;

    const sourceInputs: ChannelInputSource[] = [
      {
        key: "analog",
        type: buildSourceTypeLabel("analog", analogInputIndex),
        delay: analogDelay,
        trim: analogTrim,
        selected: !backupSelected && activeSourceKey === "analog"
      },
      {
        key: "dante",
        type: buildSourceTypeLabel("dante", danteIndex),
        delay: danteDelay,
        trim: danteTrim,
        selected: !backupSelected && activeSourceKey === "dante"
      },
      {
        key: "aes3",
        type: buildSourceTypeLabel("aes3", aesIndex),
        delay: aesDelay,
        trim: aesTrim,
        selected: !backupSelected && activeSourceKey === "aes3"
      },
      {
        key: "backup",
        type: "Backup",
        delay: 0,
        trim: 0,
        selected: backupSelected,
        backup: backupSourceConfig
      }
    ];

    const selectedKey = sourceNameFromCode(rawSourceTypeCode, capabilities);
    const selectedSource = sourceInputs.find((s) => s.key === selectedKey) ?? sourceInputs[0];
    const sourceType = selectedSource.type;
    const sourceDelay = selectedSource.delay;
    const sourceTrim = selectedSource.trim;

    // Limiter fields (mixed types — parsed directly, not via CHANNEL_FIELDS)
    //
    // RMS threshold: standard float32 LE at offset 98.
    // RMS bypass flag: uint8 at offset 102 (1=bypassed, 0=active) — separate byte,
    //   not part of the float. During bypass the device happens to set byte 102=1
    //   which corrupted earlier reads when offset 100 was (wrongly) assumed as the start.
    const rmsLimiter = {
      enabled: buffer.readUInt8(base + 102) === 0,
      thresholdVrms: round2(buffer.readFloatLE(base + 98)),
      attackMs: buffer.readUInt16LE(base + 95),
      releaseMultiplier: buffer.readUInt8(base + 97),
      prmsW: 0 // computed by the store after parse (depends on configured load impedance)
    };

    // Peak bypass flag: byte @ offset 116 (1=bypassed, 0=active).
    //   Standalone byte — 4 bytes past the peak threshold float @ 112–115.
    //   The peak threshold float IS stored as normal float32 LE.
    const peakLimiter = {
      enabled: buffer.readUInt8(base + 116) === 0,
      thresholdVp: round2(buffer.readFloatLE(base + 112)),
      holdMs: buffer.readUInt16LE(base + 108),
      releaseMs: buffer.readUInt16LE(base + 110),
      ppeakW: 0 // computed by the store after parse (depends on configured load impedance)
    };

    return {
      channel: channelNum,
      inputName: raw.inputName as string,
      outputName: raw.outputName as string,
      gainIn: raw.gainIn as number,
      volumeOut: raw.volumeOut as number,
      muteIn,
      delayIn: round2(raw.delayIn as number),
      trimOut: raw.trimOut as number,
      muteOut: (raw.muteOut as number) === 0,
      noiseGateOut: (raw.noiseGateOut as number) === 0, // 0=enabled, 1=disabled
      delayOut: round2(raw.delayOut as number),
      invertedOut: (raw.invertedOut as number) !== 0,
      powerMode,
      sourceTypeCode,
      sourceType,
      sourceDelay,
      sourceTrim,
      sourceInputs,
      rmsLimiter,
      peakLimiter,
      matrix,
      eqIn,
      eqOut,
      firBypassed
    };
  } catch {
    return null;
  }
}

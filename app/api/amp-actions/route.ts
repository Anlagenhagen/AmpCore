/**
 * POST /api/amp-actions
 *
 * Sends a control command to a specific amp via CvrAmpDevice.sendControl,
 * which uses an ephemeral UDP socket with the correct write-command wire format
 * confirmed by real packet captures AND the original C# source code.
 *
 * Wire format for ALL write commands:
 *   NetworkData flag: 0x0000d903
 *   statusCode:       1
 *
 * StructHeader layout (from C# Struct_test.structHeader, Pack=1, Sequential):
 *   [0]   Head         = 0x55
 *   [1]   Function_code
 *   [2]   Status_code  = 1 (write)
 *   [3]   chx          = channel index (0-3)
 *   [4]   Segment      = 0
 *   [5-8] Link         = 0 (int32 LE)
 *   [9]   in_out_flag  = 0 (input) | 1 (Output)  ← C# enum in_out_flag
 *
 * Request body (JSON):
 * {
 *   mac:    string,           // target amp MAC e.g. "6A:20:67:18:B5:8A"
 *   action: AmpAction,        // see type below
 *   channel: number,         // channel index (0-based)
 *   value:  boolean | number  // action-specific payload
 * }
 *
 * Supported actions:
 *
 *   "muteIn"  — FC=10 MUTE, in_out_flag=0 (input)
 *   "setAmpLock" — FC=17 ROTARY_LOCK, in_out_flag=0 (global)
 *   "volumeOut" — FC=9 VOL, observed output-volume control/readback on current amps
 *   "bridgePair" — FC=50 BRIDGE, pair channel=0 (A/B) or 1 (C/D)
 *   "muteOut" — FC=10 MUTE, in_out_flag=1 (Output)
 *   "invertPolarityOut" — FC=18 INVERTED, in_out_flag=1 (Output)
 *   "noiseGateOut" — FC=69 NOISE_GATE, in_out_flag=1 (Output)
 *     value: true=mute, false=unmute
 *     Wire body: 0x00=muted, 0x01=unmuted  (confirmed from C# source)
 *     C# source: Channels.cs    → SendStruct(MUTE, ch, in_out_flag.input,  link, mute_data)
 *                Channels_out.cs → SendStruct(MUTE, ch, in_out_flag.Output, link, mute_data)
 *
 *   "crossoverEnabled" — FC=30 FILTER_TYPE, link=0 (HP) or 9 (LP), in_out_flag=0/1
 *   "crossoverFreq"    — FC=32 FILTER_FREQ, link=0 (HP) or 9 (LP), in_out_flag=0/1
 *     Both are followed by the fixed crossover commit packet observed in CVR's app.
 */

import { ampController } from "@/lib/amp-controller";
import { CvrAmpDevice, FuncCode } from "@/lib/amp-device";
import { applySimulatedAction, isSimulatedMac } from "@/lib/simulated-amps";
import { ampActionRequestSchema, type AmpActionRequest } from "@/lib/validation/amp-actions";
import { parseFC27Channels, type ChannelData } from "@/lib/parse-channel-data";
import { AMP_NAME_MAX_LENGTH, CHANNEL_NAME_MAX_LENGTH } from "@/lib/constants";
import { FIR_MAX_TAPS, FIR_NAME_MAX_BYTES } from "@/lib/fir";

export const dynamic = "force-dynamic";

const POWER_MODE_FUNC_CODE = FuncCode.DZ_DY;

const DEFAULT_CROSSOVER_TYPE = {
  hp: 0,
  lp: 4
} as const;

function getCrossoverLink(): number {
  // Link is not the HP/LP selector in the C# reference path.
  // Keep link at 0 when writing a single channel directly.
  return 0;
}

function getCrossoverSegment(kind: "hp" | "lp"): number {
  // HP = band 0, LP = band 9 in the 10-band EQ layout.
  return kind === "hp" ? 0 : 9;
}

function getCrossoverInOutFlag(target: "input" | "output"): number {
  return target === "input" ? 0 : 1;
}

function getCrossoverTypeByte(kind: "hp" | "lp", enabled: boolean, filterType: number): number {
  const normalizedType = Number.isInteger(filterType) ? filterType : DEFAULT_CROSSOVER_TYPE[kind];
  return enabled ? normalizedType : 255 - normalizedType;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function POST(request: Request): Promise<Response> {
  let rawBody: unknown;

  try {
    rawBody = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = ampActionRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return Response.json(
      {
        error: parsed.error.issues[0]?.message ?? "Invalid request payload",
        issues: parsed.error.issues
      },
      { status: 400 }
    );
  }

  const body: AmpActionRequest = parsed.data;
  const { mac, action, channel, value } = body;

  if (isSimulatedMac(mac)) {
    applySimulatedAction(mac, body);
    return Response.json({ ok: true, mac, action, channel, value, simulated: true });
  }

  // Ensure controller is started
  ampController.start();

  const ip = ampController.getIpForMac(mac);
  if (!ip) {
    return Response.json({ error: `Amp ${mac} not yet discovered — is it online?` }, { status: 404 });
  }

  const device = new CvrAmpDevice(ip);

  // Confirmed send: fire the (fire-and-forget) control, then read the channel back
  // (FC=27) and re-send until the expected value is actually present. Returns true
  // only when the amp confirmed the change. If it can NEVER be confirmed (value
  // didn't land, or read-back keeps failing) it returns false — the caller then
  // reports a real error, so an action that didn't actually push is never silently
  // treated as "ok". Certainty over speed (per requirement).
  // Authoritative output channel count (FC=0). Required so trailer-relative fields
  // like muteIn parse correctly — otherwise on FW 1.1.9 (larger FC=27 trailer) the
  // count is over-derived from length, muteIn reads out of bounds and unmute keeps
  // "failing" verification even though it worked.
  const channelCount = ampController.getChannelCountForMac(mac);

  const applyVerifiedControl = async (
    send: () => Promise<void>,
    check: (chan: ChannelData) => boolean,
    rounds = 3
  ): Promise<boolean> => {
    await send();
    for (let r = 0; r < rounds; r++) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      let confirmed = false;
      try {
        const hex = (await ampController.requestFC27(mac, 0)).toString("hex");
        const chan = parseFC27Channels(hex, undefined, channelCount)[channel];
        confirmed = !!chan && check(chan);
      } catch {
        confirmed = false; // couldn't read back -> not confirmed, retry
      }
      if (confirmed) return true;
      await send();
    }
    return false;
  };

  // Turn a verification result into a response. When the amp did NOT confirm the
  // change, return a real HTTP error so the UI surfaces a failure instead of a
  // silent "ok" — an action that didn't actually push must report an error.
  const respondVerified = (verified: boolean): Response =>
    verified
      ? Response.json({ ok: true, mac, action, channel, value, verified: true })
      : Response.json(
          {
            error: `"${action}" (Kanal ${channel}) konnte nicht bestätigt werden — der Amp hat die Änderung nicht übernommen. Bitte erneut versuchen.`,
            mac,
            action,
            channel,
            value,
            verified: false
          },
          { status: 502 }
        );

  try {
    switch (action) {
      // -----------------------------------------------------------------------
      // Amp front-panel lock/unlock — FC=17 ROTARY_LOCK
      // Wire body: 0x01 = locked, 0x00 = unlocked
      // -----------------------------------------------------------------------
      case "setAmpLock": {
        const payload = Buffer.from([value ? 0x01 : 0x00]);
        await device.sendControl(FuncCode.ROTARY_LOCK, 0, payload, 0 /* input/default */);
        break;
      }

      // -----------------------------------------------------------------------
      // Set amp standby — FC=15 STANDBY_DATA, in_out_flag=0
      // Wire body: 0x01 = standby, 0x00 = normal
      // Captured original-app frame uses statusCode=0x00 for this command.
      // -----------------------------------------------------------------------
      case "setAmpStandby": {
        const payload = Buffer.from([value ? 0x01 : 0x00]);
        await device.sendControl(FuncCode.STANDBY_DATA, 0, payload, 0 /* input/default */, 0, 0, 0 /* statusCode */);
        break;
      }

      // -----------------------------------------------------------------------
      // Mute input — FC=10, in_out_flag=0 (input)
      // C# source: SendStruct(MUTE, ch, in_out_flag.input, linkNum, mute_data)
      // Wire body: 0x00=muted, 0x01=unmuted
      // -----------------------------------------------------------------------
      case "muteIn": {
        // Safety-critical: a mute that silently drops (packet lost on WiFi) would
        // leave the input live while the UI briefly shows muted, then "jump back"
        // to unmuted on the next poll. Confirm the amp actually took it.
        const payload = Buffer.from([value ? 0x00 : 0x01]);
        const want = Boolean(value);
        const verified = await applyVerifiedControl(
          () => device.sendControl(FuncCode.MUTE, channel, payload, 0 /* input */),
          (c) => c.muteIn === want
        );
        return respondVerified(verified);
      }

      // -----------------------------------------------------------------------
      // Output volume — FC=9 VOL, read back from FC=27 body[405]
      // Observed devices apply this control to the output path even though the
      // working packet shape still uses in_out_flag=0.
      // Legacy clients may still send "volumeIn".
      // -----------------------------------------------------------------------
      case "volumeOut":
      case "volumeIn": {
        const payload = Buffer.alloc(4);
        payload.writeFloatLE(value, 0);
        const want = value;
        const verified = await applyVerifiedControl(
          () => device.sendControl(FuncCode.VOL, channel, payload, 0 /* input */),
          (c) => Math.abs(c.volumeOut - want) <= 0.15
        );
        return respondVerified(verified);
      }

      // -----------------------------------------------------------------------
      // Mute output — FC=10, in_out_flag=1 (Output)
      // C# source: SendStruct(MUTE, ch, in_out_flag.Output, linkNum, mute_data)
      // Wire body: 0x00=muted, 0x01=unmuted
      // -----------------------------------------------------------------------
      case "muteOut": {
        // Safety-critical (see muteIn): confirm the output mute actually landed
        // instead of fire-and-forget, so it can't silently revert to unmuted.
        const payload = Buffer.from([value ? 0x00 : 0x01]);
        const want = Boolean(value);
        const verified = await applyVerifiedControl(
          () => device.sendControl(FuncCode.MUTE, channel, payload, 1 /* Output */),
          (c) => c.muteOut === want
        );
        return respondVerified(verified);
      }

      // -----------------------------------------------------------------------
      // Output polarity invert — FC=18, in_out_flag=1 (Output)
      // Wire body: 0x00 = normal polarity, 0x01 = inverted polarity
      // Readback parser confirms non-zero means polarity flipped.
      // -----------------------------------------------------------------------
      case "invertPolarityOut": {
        const payload = Buffer.from([value ? 0x01 : 0x00]);
        const want = Boolean(value);
        const verified = await applyVerifiedControl(
          () => device.sendControl(FuncCode.PHASE, channel, payload, 1 /* Output */),
          (c) => c.invertedOut === want
        );
        return respondVerified(verified);
      }

      // -----------------------------------------------------------------------
      // Noise gate output — FC=69, in_out_flag=1 (Output)
      // Wire body follows the same convention observed in sync data:
      //   0x00 = enabled/on
      //   0x01 = disabled/off
      // -----------------------------------------------------------------------
      case "noiseGateOut": {
        const payload = Buffer.from([value ? 0x00 : 0x01]);
        const want = Boolean(value);
        const verified = await applyVerifiedControl(
          () => device.sendControl(FuncCode.NOISE_GATE, channel, payload, 1 /* Output */),
          (c) => c.noiseGateOut === want
        );
        return respondVerified(verified);
      }

      // -----------------------------------------------------------------------
      // RMS limiter bypass toggle — FC=48, in_out_flag=1 (Output)
      // Preferred path: FC=55 RMS_LIMITER full payload write when params are provided.
      // Fallback path: FC=48 RMS_BYPASS one-byte toggle.
      // -----------------------------------------------------------------------
      case "rmsLimiterOut": {
        if (
          typeof body.attackMs === "number" &&
          typeof body.releaseMultiplier === "number" &&
          typeof body.thresholdVrms === "number"
        ) {
          const payload = Buffer.alloc(8);
          payload.writeUInt16LE(body.attackMs, 0);
          payload.writeUInt8(body.releaseMultiplier, 2);
          payload.writeFloatLE(body.thresholdVrms, 3);
          payload.writeUInt8(value ? 0x00 : 0x01, 7); // 0=enabled, 1=bypassed

          const thr = body.thresholdVrms;
          const verified = await applyVerifiedControl(
            () => device.sendControl(FuncCode.RMS_LIMITER, channel, payload, 1 /* Output */),
            (c) =>
              typeof c.rmsLimiter?.thresholdVrms === "number" &&
              Math.abs(c.rmsLimiter.thresholdVrms - thr) <= Math.max(0.05, Math.abs(thr) * 0.02)
          );
          return respondVerified(verified);
        } else {
          const payload = Buffer.from([value ? 0x00 : 0x01]);
          await device.sendControl(FuncCode.RMS_BYPASS, channel, payload, 1 /* Output */);
        }
        break;
      }

      // -----------------------------------------------------------------------
      // Peak limiter bypass toggle — FC=47, in_out_flag=1 (Output)
      // Preferred path: FC=54 PEAK_LIMITER full payload write when params are provided.
      // Fallback path: FC=47 PEAK_BYPASS one-byte toggle.
      // -----------------------------------------------------------------------
      case "peakLimiterOut": {
        if (
          typeof body.holdMs === "number" &&
          typeof body.releaseMs === "number" &&
          typeof body.thresholdVp === "number"
        ) {
          const payload = Buffer.alloc(9);
          payload.writeUInt16LE(body.holdMs, 0);
          payload.writeUInt16LE(body.releaseMs, 2);
          payload.writeFloatLE(body.thresholdVp, 4);
          payload.writeUInt8(value ? 0x00 : 0x01, 8); // 0=enabled, 1=bypassed

          const thr = body.thresholdVp;
          const verified = await applyVerifiedControl(
            () => device.sendControl(FuncCode.PEAK_LIMITER, channel, payload, 1 /* Output */),
            (c) =>
              typeof c.peakLimiter?.thresholdVp === "number" &&
              Math.abs(c.peakLimiter.thresholdVp - thr) <= Math.max(0.05, Math.abs(thr) * 0.02)
          );
          return respondVerified(verified);
        } else {
          const payload = Buffer.from([value ? 0x00 : 0x01]);
          await device.sendControl(FuncCode.PEAK_BYPASS, channel, payload, 1 /* Output */);
        }
        break;
      }

      // -----------------------------------------------------------------------
      // Matrix crosspoint gain — FC=12 ROUTING
      // Body: [float32 gain_dB LE][uint8 active_flag]
      // chx = output channel (0-3), segment = source input index (0-3)
      // -----------------------------------------------------------------------
      case "matrixGain": {
        const payload = Buffer.alloc(5);
        payload.writeFloatLE(value, 0);
        payload.writeUInt8(1, 4); // keep active when changing gain
        await device.sendControl(FuncCode.ROUTING, channel, payload, 1 /* Output */, 0, body.source);
        break;
      }

      // -----------------------------------------------------------------------
      // Matrix crosspoint active toggle — FC=12 ROUTING
      // Body: [float32 gain_dB LE][uint8 active_flag]
      // When deactivating, send current gain with active=0.
      // When activating, send 0 dB gain with active=1.
      // -----------------------------------------------------------------------
      case "matrixActive": {
        const payload = Buffer.alloc(5);
        payload.writeFloatLE(0, 0); // gain=0 dB (caller can set gain separately)
        payload.writeUInt8(value ? 1 : 0, 4);
        await device.sendControl(FuncCode.ROUTING, channel, payload, 1 /* Output */, 0, body.source);
        break;
      }

      // -----------------------------------------------------------------------
      // Source selection mode — FC=11 SOURCE
      // Body: Source_data { byte Source }
      //   0 = Analog
      //   1 = Digital (Dante on Dante-capable models, AES3 on AES-only models)
      //   2 = AES3
      // Backup is managed by priority/auto-source controls in the original app,
      // not by writing SOURCE as a dedicated mode.
      // -----------------------------------------------------------------------
      case "sourceType": {
        const payload = Buffer.from([value]);
        const want = value;
        const verified = await applyVerifiedControl(
          () => device.sendControl(FuncCode.SOURCE_SELECT, channel, payload, 0 /* input */),
          (c) => c.sourceTypeCode === want
        );
        return respondVerified(verified);
      }

      // -----------------------------------------------------------------------
      // Source delay update — FC=63 Source_data_code (gain_matching_data)
      // Header segment selects source family: 0=Analog, 1=Dante, 2=AES3.
      // Body layout (8 bytes): [float32 trim][float32 delay]
      // -----------------------------------------------------------------------
      case "sourceDelay": {
        const payload = Buffer.alloc(8);
        payload.writeFloatLE(body.trim, 0);
        payload.writeFloatLE(value, 4);
        await device.sendControl(FuncCode.SOURCE_DATA, channel, payload, 0 /* input */, 0, body.source);
        break;
      }

      // -----------------------------------------------------------------------
      // Source trim update — FC=63 Source_data_code (gain_matching_data)
      // Header segment selects source family: 0=Analog, 1=Dante, 2=AES3.
      // Body layout (8 bytes): [float32 trim][float32 delay]
      // -----------------------------------------------------------------------
      case "sourceTrim": {
        const payload = Buffer.alloc(8);
        payload.writeFloatLE(value, 0);
        payload.writeFloatLE(body.delay, 4);
        await device.sendControl(FuncCode.SOURCE_DATA, channel, payload, 0 /* input */, 0, body.source);
        break;
      }

      // -----------------------------------------------------------------------
      // Backup/auto-source configuration — FC=80 Priority_inputs_code
      // Dual-source devices use PriorityDD: [enabled][preferredSource][threshold].
      // Three-source devices use StruPriority: [first][second][enabled][threshold].
      // -----------------------------------------------------------------------
      case "backupConfig": {
        const payload =
          body.variant === "triple"
            ? Buffer.from([
                body.priority1 & 0xff,
                (body.priority2 ?? body.priority1) & 0xff,
                value ? 0x01 : 0x00,
                body.threshold & 0xff
              ])
            : Buffer.from([value ? 0x01 : 0x00, body.priority1 & 0xff, body.threshold & 0xff]);
        await device.sendControl(FuncCode.PRIORITY_INPUTS, channel, payload, 0 /* input */);
        break;
      }

      // -----------------------------------------------------------------------
      // Analog input type selection — FC=79 Analog_Matrix_input
      // Body: byte analog type/index (model-specific mapping)
      // Packet shape matches original capture: FC=0x4F, 1-byte payload.
      // -----------------------------------------------------------------------
      case "analogType": {
        const payload = Buffer.from([value & 0xff]);
        await device.sendControl(FuncCode.ANALOG_TYPE, channel, payload, 0 /* input */);
        break;
      }

      // -----------------------------------------------------------------------
      // Input delay — FC=14, in_out_flag=0 (input)
      // Wire body: float32 LE (milliseconds)
      // -----------------------------------------------------------------------
      case "delayIn": {
        const payload = Buffer.alloc(4);
        payload.writeFloatLE(value, 0);
        const want = value;
        const verified = await applyVerifiedControl(
          () => device.sendControl(FuncCode.DELAY, channel, payload, 0 /* input */),
          (c) => Math.abs(c.delayIn - want) <= 0.05
        );
        return respondVerified(verified);
      }

      // -----------------------------------------------------------------------
      // Output delay — FC=14, in_out_flag=1 (Output)
      // Wire body: float32 LE (milliseconds)
      // -----------------------------------------------------------------------
      case "delayOut": {
        const payload = Buffer.alloc(4);
        payload.writeFloatLE(value, 0);
        const want = value;
        const verified = await applyVerifiedControl(
          () => device.sendControl(FuncCode.DELAY, channel, payload, 1 /* Output */),
          (c) => Math.abs(c.delayOut - want) <= 0.05
        );
        return respondVerified(verified);
      }

      // -----------------------------------------------------------------------
      // Output trim/volume — FC=9, in_out_flag=1 (Output)
      // On the original 118/IAG controller path this output control is bound to
      // VolumeOut / vol_out, encoded as float32 dB and read back from FC=27.
      // -----------------------------------------------------------------------
      case "outputTrim": {
        const payload = Buffer.alloc(4);
        payload.writeFloatLE(value, 0);
        const want = value;
        const verified = await applyVerifiedControl(
          () => device.sendControl(FuncCode.VOL, channel, payload, 1 /* Output */),
          (c) => Math.abs(c.trimOut - want) <= 0.15
        );
        return respondVerified(verified);
      }

      // -----------------------------------------------------------------------
      // Output power mode (Low-Ω / 70V / 100V) — FC=49 DZ_DY_data_code
      // Body: DZ_DY { CPCR: byte }
      //   0 = Low-Ω
      //   1 = 70V
      //   2 = 100V
      // Uses the per-channel write path from the original controller rather than
      // the larger FC=81 Power_Allot block.
      // -----------------------------------------------------------------------
      case "powerModeOut": {
        const payload = Buffer.from([value]);
        const want = value;
        const verified = await applyVerifiedControl(
          () => device.sendControl(POWER_MODE_FUNC_CODE, channel, payload, 1 /* Output */),
          (c) => c.powerMode === want
        );
        return respondVerified(verified);
      }

      // -----------------------------------------------------------------------
      // Bridge mode toggle — FC=50 BRIDGE
      // chx = pair index (0 => A/B, 1 => C/D)
      // body: 0x00 = bridged, 0x01 = unbridged
      // -----------------------------------------------------------------------
      case "bridgePair": {
        const payload = Buffer.from([value ? 0x00 : 0x01]);
        await device.sendControl(FuncCode.BRIDGE, channel, payload, 0);
        break;
      }

      // -----------------------------------------------------------------------
      // Input/output crossover enable/disable — FC=30 FILTER_TYPE
      // segment=0 selects HP, segment=9 selects LP.
      // Enabled body = filter type, disabled body = 255 - filter type.
      // Device requires a follow-up commit packet after crossover changes.
      // -----------------------------------------------------------------------
      case "crossoverEnabled": {
        const payload = Buffer.from([getCrossoverTypeByte(body.kind, value, body.filterType)]);
        const inOut = getCrossoverInOutFlag(body.target);
        const seg = getCrossoverSegment(body.kind); // 0 = HP band, 9 = LP band
        const want = Boolean(value);
        const verified = await applyVerifiedControl(
          async () => {
            await device.sendControl(FuncCode.FILTER_TYPE, channel, payload, inOut, getCrossoverLink(), seg);
            await device.commitCrossover();
          },
          (c) => {
            const b = (inOut === 0 ? c.eqIn : c.eqOut)?.[seg];
            return !!b && b.bypass === !want; // enabled => not bypassed
          }
        );
        return respondVerified(verified);
      }

      // -----------------------------------------------------------------------
      // Input/output crossover frequency — FC=32 FILTER_FREQ
      // segment=0 selects HP, segment=9 selects LP.
      // Device requires a follow-up commit packet after crossover changes.
      // -----------------------------------------------------------------------
      case "crossoverFreq": {
        const payload = Buffer.alloc(4);
        payload.writeFloatLE(value, 0);
        const inOut = getCrossoverInOutFlag(body.target);
        const seg = getCrossoverSegment(body.kind);
        const want = value;
        const verified = await applyVerifiedControl(
          async () => {
            await device.sendControl(FuncCode.FILTER_FREQ, channel, payload, inOut, getCrossoverLink(), seg);
            await device.commitCrossover();
          },
          (c) => {
            const b = (inOut === 0 ? c.eqIn : c.eqOut)?.[seg];
            return !!b && Math.abs(b.freq - want) <= Math.max(1, want * 0.02);
          }
        );
        return respondVerified(verified);
      }

      // -----------------------------------------------------------------------
      // Full 10-band EQ apply job — writes HP, EQ1-8, LP.
      // The per-band writes are fire-and-forget (no ACK), so on WiFi/contention a
      // burst of ~30 packets drops some silently → EQ only partially applied (the
      // classic "copy-paste EQ takes 2-3 tries" symptom). This path now self-heals:
      // after applying it reads the channel back (FC=27) and re-sends only the
      // bands that did not land, up to a few rounds — the retries happen here
      // automatically instead of the user re-pasting.
      // -----------------------------------------------------------------------
      case "eqBlock": {
        const inOutFlag = body.target === "input" ? 0 : 1;
        const bands = body.bands;

        const sendBand = async (idx: number): Promise<void> => {
          const band = bands[idx];
          if (idx === 0 || idx === 9) {
            const kind = idx === 0 ? "hp" : "lp";
            const typePayload = Buffer.from([getCrossoverTypeByte(kind, !band.bypass, band.type)]);
            await device.sendControl(FuncCode.FILTER_TYPE, channel, typePayload, inOutFlag, getCrossoverLink(), idx);
            const freqPayload = Buffer.alloc(4);
            freqPayload.writeFloatLE(band.freq, 0);
            await device.sendControl(FuncCode.FILTER_FREQ, channel, freqPayload, inOutFlag, getCrossoverLink(), idx);
            return;
          }
          const typeByte = band.bypass ? 255 - band.type : band.type;
          await device.sendControl(FuncCode.FILTER_TYPE, channel, Buffer.from([typeByte]), inOutFlag, 0, idx);
          const freqPayload = Buffer.alloc(4);
          freqPayload.writeFloatLE(band.freq, 0);
          await device.sendControl(FuncCode.FILTER_FREQ, channel, freqPayload, inOutFlag, 0, idx);
          const gainPayload = Buffer.alloc(4);
          gainPayload.writeFloatLE(band.gain, 0);
          await device.sendControl(FuncCode.FILTER_GAIN, channel, gainPayload, inOutFlag, 0, idx);
          const qPayload = Buffer.alloc(4);
          qPayload.writeFloatLE(band.q, 0);
          await device.sendControl(FuncCode.FILTER_Q, channel, qPayload, inOutFlag, 0, idx);
        };

        // Read the channel back and return the band indices that don't match yet.
        // eqIn/eqOut live in the per-channel body, so they parse correctly even if
        // the trailer-derived channel count would be off.
        const findMismatchedBands = async (): Promise<number[]> => {
          let hex: string;
          try {
            hex = (await ampController.requestFC27(mac, 0)).toString("hex");
          } catch {
            return []; // verification unavailable — don't spin
          }
          const chan = parseFC27Channels(hex, undefined, channelCount)[channel];
          const readback = inOutFlag === 0 ? chan?.eqIn : chan?.eqOut;
          if (!chan || !Array.isArray(readback) || readback.length < bands.length) return [];
          const mism: number[] = [];
          for (let idx = 0; idx < bands.length; idx++) {
            const want = bands[idx];
            const got = readback[idx];
            const isXover = idx === 0 || idx === 9;
            let ok: boolean;
            if (want.bypass) {
              ok = got?.bypass === true;
            } else {
              ok =
                !!got &&
                got.bypass === false &&
                got.type === want.type &&
                Math.abs(got.freq - want.freq) <= Math.max(1, want.freq * 0.02) &&
                (isXover || Math.abs(got.gain - want.gain) <= 0.25) &&
                (isXover || Math.abs(got.q - want.q) <= 0.1);
            }
            if (!ok) mism.push(idx);
          }
          return mism;
        };

        // Round 1: apply everything.
        for (let idx = 0; idx < bands.length; idx++) await sendBand(idx);
        await device.commitCrossover();

        // Self-healing rounds: re-send only what didn't land.
        const maxRounds = 4;
        let remaining: number[] = [];
        for (let round = 0; round < maxRounds; round++) {
          await new Promise((resolve) => setTimeout(resolve, 200)); // let writes settle before read
          remaining = await findMismatchedBands();
          if (remaining.length === 0) break;
          for (const idx of remaining) await sendBand(idx);
          await device.commitCrossover();
        }

        if (remaining.length > 0) {
          return Response.json(
            {
              error: `EQ nicht vollständig übernommen — ${remaining.length} Band/Bänder fehlen (Kanal ${channel}). Bitte erneut versuchen.`,
              mac,
              action,
              channel,
              verified: false,
              remainingBands: remaining
            },
            { status: 502 }
          );
        }
        return Response.json({ ok: true, mac, action, channel, verified: true });
      }

      // -----------------------------------------------------------------------
      // Parametric EQ band type / bypass — FC=30 FILTER_TYPE
      // segment = band index (1-8).
      // Bypass encoding mirrors parse: enabled → type as-is; bypassed → 255 - type.
      // -----------------------------------------------------------------------
      case "eqBandType": {
        const typeByte = body.bypass ? 255 - body.value : body.value;
        const payload = Buffer.from([typeByte]);
        const wantType = body.value;
        const wantBypass = Boolean(body.bypass);
        const inOut = body.target === "input" ? 0 : 1;
        const band = body.band;
        const verified = await applyVerifiedControl(
          () => device.sendControl(FuncCode.FILTER_TYPE, channel, payload, inOut, 0, band),
          (c) => {
            const b = (inOut === 0 ? c.eqIn : c.eqOut)?.[band];
            return !!b && (wantBypass ? b.bypass === true : b.bypass === false && b.type === wantType);
          }
        );
        return respondVerified(verified);
      }

      // -----------------------------------------------------------------------
      // Parametric EQ band frequency — FC=32 FILTER_FREQ
      // segment = band index (1-8). Body: float32 LE (Hz).
      // -----------------------------------------------------------------------
      case "eqBandFreq": {
        const payload = Buffer.alloc(4);
        payload.writeFloatLE(value, 0);
        const want = value;
        const inOut = body.target === "input" ? 0 : 1;
        const band = body.band;
        const verified = await applyVerifiedControl(
          () => device.sendControl(FuncCode.FILTER_FREQ, channel, payload, inOut, 0, band),
          (c) => {
            const b = (inOut === 0 ? c.eqIn : c.eqOut)?.[band];
            return !!b && Math.abs(b.freq - want) <= Math.max(1, want * 0.02);
          }
        );
        return respondVerified(verified);
      }

      // -----------------------------------------------------------------------
      // Parametric EQ band gain (boost) — FC=31 FILTER_GAIN
      // segment = band index (1-8). Body: float32 LE (dB).
      // FC=31 maps to the gain field (offset 1) of the EQ band struct.
      // FC=33 (FILTER_FREQ_BOOST) is a different command and must NOT be used here.
      // -----------------------------------------------------------------------
      case "eqBandGain": {
        const payload = Buffer.alloc(4);
        payload.writeFloatLE(value, 0);
        const want = value;
        const inOut = body.target === "input" ? 0 : 1;
        const band = body.band;
        const verified = await applyVerifiedControl(
          () => device.sendControl(FuncCode.FILTER_GAIN, channel, payload, inOut, 0, band),
          (c) => {
            const b = (inOut === 0 ? c.eqIn : c.eqOut)?.[band];
            return !!b && Math.abs(b.gain - want) <= 0.25;
          }
        );
        return respondVerified(verified);
      }

      // -----------------------------------------------------------------------
      // Parametric EQ band Q factor — FC=34 FILTER_Q
      // segment = band index (1-8). Body: float32 LE (Q value).
      // -----------------------------------------------------------------------
      case "eqBandQ": {
        const payload = Buffer.alloc(4);
        payload.writeFloatLE(value, 0);
        const want = value;
        const inOut = body.target === "input" ? 0 : 1;
        const band = body.band;
        const verified = await applyVerifiedControl(
          () => device.sendControl(FuncCode.FILTER_Q, channel, payload, inOut, 0, band),
          (c) => {
            const b = (inOut === 0 ? c.eqIn : c.eqOut)?.[band];
            return !!b && Math.abs(b.q - want) <= 0.1;
          }
        );
        return respondVerified(verified);
      }

      // -----------------------------------------------------------------------
      // Device name rename — FC=60 CUSTOMER_NAME_MODIFY
      // Body: fixed 32-byte null-padded ASCII name field.
      // -----------------------------------------------------------------------
      case "renameAmp": {
        const payload = Buffer.alloc(32, 0);
        const nameBytes = Buffer.from(value, "ascii").subarray(0, AMP_NAME_MAX_LENGTH);
        nameBytes.copy(payload, 0);

        const packet = ampController.network.buildProtocolPacket({
          functionCode: FuncCode.CUSTOMER_NAME_MODIFY,
          statusCode: 1,
          chx: 0,
          segment: 0,
          link: 0,
          inOutFlag: 0,
          body: payload
        });

        if (ampController.network.isStarted) {
          await ampController.network.sendRaw_shouldBeReplacedWithSendPacket(packet, 0, packet.length, ip, false);
        } else {
          // Fallback if the shared socket is not ready for any reason.
          await device.sendControl(FuncCode.CUSTOMER_NAME_MODIFY, 0, payload, 0 /* input/default */);
        }
        break;
      }

      // -----------------------------------------------------------------------
      // Rename output channel (speaker name) — FC=77 SPEAKER_NAME
      // Body: 16-byte null-padded ASCII string.
      // chx = channel index, in_out_flag=1 (Output).
      // Confirmed by Wireshark: FC=0x4D, in_out_flag=1.
      // -----------------------------------------------------------------------
      case "renameOutput": {
        const payload = Buffer.alloc(16, 0);
        const nameBytes = Buffer.from(String(value), "ascii").subarray(0, CHANNEL_NAME_MAX_LENGTH);
        nameBytes.copy(payload, 0);
        // The device parses the name as null-terminated ASCII, so the read-back
        // equals the bytes we wrote (truncated to CHANNEL_NAME_MAX_LENGTH).
        const expectedName = nameBytes.toString("ascii");
        // Verify the rename actually landed. The sync-hash embedded in output
        // names (Speaker Config "Apply all") depends on this taking effect, and
        // the fire-and-forget path silently dropped renames on 1.1.9 → "No Checksum".
        const verified = await applyVerifiedControl(
          () => device.sendControl(FuncCode.SPEAKER_NAME, channel, payload, 1 /* Output */),
          (c) => c.outputName === expectedName
        );
        return respondVerified(verified);
      }

      // -----------------------------------------------------------------------
      // Rename input channel — FC=77 SPEAKER_NAME
      // Same as output rename but with in_out_flag=0 (Input).
      // Confirmed by Wireshark: FC=0x4D, in_out_flag=0.
      // -----------------------------------------------------------------------
      case "renameInput": {
        const payload = Buffer.alloc(16, 0);
        const nameBytes = Buffer.from(value, "ascii").subarray(0, CHANNEL_NAME_MAX_LENGTH);
        nameBytes.copy(payload, 0);
        await device.sendControl(FuncCode.SPEAKER_NAME, channel, payload, 0 /* Input */);
        break;
      }

      // -----------------------------------------------------------------------
      // FIR bypass toggle — FC=44 FIR_BYPASS, in_out_flag=1 (Output)
      // Body: 1 byte — 0x00 = enabled (filter active), non-zero = bypassed (off).
      // C# reference: fir_bypass.fir_bypass, UDP.SendStruct(FIR_bypass, ch, Output)
      // -----------------------------------------------------------------------
      case "firBypass": {
        const payload = Buffer.from([value ? 0x00 : 0x01]); // value=true => FIR enabled (wire 0x00)
        const want = Boolean(value);
        const verified = await applyVerifiedControl(
          () => device.sendControl(FuncCode.FIR_BYPASS, channel, payload, 1 /* Output */),
          (c) => c.firBypassed === !want // enabled => not bypassed
        );
        return respondVerified(verified);
      }

      // -----------------------------------------------------------------------
      // FIR coefficient data — FC=43 FIR_DATA, in_out_flag=1 (Output)
      // Body: 32-byte name + 512 × float32 LE coefficients = 2080 bytes.
      // The protocol layer handles multi-fragment reassembly automatically.
      // C# reference: FIR_DATA { fir_name[32], fir_data[512] }
      // -----------------------------------------------------------------------
      case "firData": {
        const coeffs: number[] = body.coefficients;
        const firName: string = body.name ?? "";

        // Build body: 32-byte name + 512 × float32 LE
        const nameField = Buffer.alloc(FIR_NAME_MAX_BYTES, 0);
        const encodedName = Buffer.from(firName, "ascii").subarray(0, FIR_NAME_MAX_BYTES);
        encodedName.copy(nameField, 0);

        const dataField = Buffer.alloc(FIR_MAX_TAPS * 4);
        for (let i = 0; i < FIR_MAX_TAPS; i++) {
          dataField.writeFloatLE(i < coeffs.length ? coeffs[i] : 0, i * 4);
        }

        const payload = Buffer.concat([nameField, dataField]);
        await device.sendControl(FuncCode.FIR_DATA, channel, payload, 1 /* Output */);
        break;
      }

      default:
        return Response.json({ error: `Unknown action: ${action as string}` }, { status: 400 });
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return Response.json(
      {
        error: `Command failed: ${errMsg}`
      },
      { status: 502 }
    );
  }

  return Response.json({ ok: true, mac, action, channel, value });
}

/**
 * GET /api/amp-speaker-data?mac=XX:XX:XX:XX:XX:XX&channel=0
 *
 * Request speaker calibration data (FC=57, SPEAKER_DATA) for a specific output
 * channel and return both the raw blob and all parsed fields.
 *
 * This is the "Copy" side of the original WPF CopyData() workflow:
 *   UDP.SendStruct(chx_output_data_copy_code, Responsed.Request, ch, in_out_flag.Output, 0, null)
 *
 * Variant is auto-detected by body length:
 *   157 B = YCST, 2216 = 115, 2252 = 116, 2294 = Phonic, 2310 = 117, 2415 = Tecnare
 *
 * ---
 *
 * POST /api/amp-speaker-data
 *
 * Inject (paste) a raw FC=57 blob onto one or more output channels.
 *
 * This is the "Paste" side of the original WPF PastData() workflow:
 *   UDP.SendStruct(chx_output_data_copy_code, Responsed.Response, 0, in_out_flag.Output, channelMask, data)
 *
 * Request body (JSON):
 * {
 *   mac:      string,    // target amp MAC
 *   channels: number[],  // 0-based physical output channels to apply to
 *   hex:      string     // raw FC=57 body as hex string (from library deviceData)
 * }
 *
 * When qos is true (opt-in), the endpoint reads back from each channel after writing
 * and confirms the variant/byte-length matches the sent data.
 */

import { ampController } from "@/lib/amp-controller";
import { FuncCode } from "@/lib/amp-device";
import { isSimulatedMac } from "@/lib/simulated-amps";
import { parseSpeakerData, detectSpeakerVariant, writeSpeakerNameIntoBlob } from "@/lib/parse-speaker-data";

export const dynamic = "force-dynamic";

/**
 * Every FC=57 variant (YCST/115/116/Phonic/117/Tecnare) starts with a 32-byte
 * `deviceName` field. The amp stamps this with ITS OWN identity string on store —
 * confirmed by reading back a preset captured on one amp model and applied to a
 * different one: only these 32 bytes differed, the entire rest of the block
 * (the actual EQ/crossover/limiter/delay preset content) matched exactly. Comparing
 * this field would falsely flag a correctly-applied preset as failed whenever it's
 * pasted onto a different physical amp than the one it was captured on.
 */
const DEVICE_NAME_FIELD_LEN = 32;

function speakerDataContentEquals(readBack: Buffer, sent: Buffer): boolean {
  if (readBack.length !== sent.length) return false;
  const skip = Math.min(DEVICE_NAME_FIELD_LEN, sent.length);
  return readBack.subarray(skip).equals(sent.subarray(skip));
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const mac = url.searchParams.get("mac");
  const channelStr = url.searchParams.get("channel");

  if (!mac) {
    return Response.json({ error: "Missing mac parameter" }, { status: 400 });
  }
  if (channelStr === null) {
    return Response.json({ error: "Missing channel parameter" }, { status: 400 });
  }

  const channel = parseInt(channelStr, 10);
  if (isNaN(channel) || channel < 0 || channel > 7) {
    return Response.json({ error: "Invalid channel (0–7)" }, { status: 400 });
  }

  if (isSimulatedMac(mac)) {
    return Response.json({
      success: true,
      mac,
      channel,
      variant: "unknown",
      byteLength: 0,
      hex: "",
      parsed: null,
      simulated: true
    });
  }

  try {
    ampController.start();

    if (!ampController.getIpForMac(mac)) {
      return Response.json({ error: `Amp ${mac} not yet discovered` }, { status: 404 });
    }

    // FC=57 SPEAKER_DATA, inOutFlag=1 (Output), statusCode=2 (Request/read).
    // Timeout 3 s — response size is device-model-dependent (157 B – 2415 B).
    const body = await ampController.requestFC(mac, FuncCode.SPEAKER_DATA, channel, Buffer.alloc(0), 1, 3000);

    const variant = detectSpeakerVariant(body.length);
    const parsed = parseSpeakerData(body);

    return Response.json({
      success: true,
      mac,
      channel,
      variant,
      byteLength: body.length,
      hex: body.toString("hex"),
      parsed
    });
  } catch (err) {
    return Response.json(
      { error: `FC=57 query failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 }
    );
  }
}

// ---------------------------------------------------------------------------
// POST — Apply (paste/inject) speaker data to the amp
// ---------------------------------------------------------------------------

export async function POST(request: Request): Promise<Response> {
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!rawBody || typeof rawBody !== "object") {
    return Response.json({ error: "Request body must be a JSON object" }, { status: 400 });
  }

  const { mac, channels, hex, qos } = rawBody as Record<string, unknown>;

  // --- Input validation ---
  if (typeof mac !== "string" || !mac.trim()) {
    return Response.json({ error: "Missing or invalid `mac` string" }, { status: 400 });
  }
  if (!Array.isArray(channels) || channels.length === 0) {
    return Response.json({ error: "`channels` must be a non-empty array of numbers" }, { status: 400 });
  }
  for (const ch of channels) {
    if (typeof ch !== "number" || !Number.isInteger(ch) || ch < 0 || ch > 7) {
      return Response.json({ error: `Invalid channel value: ${String(ch)} (expected 0–7)` }, { status: 400 });
    }
  }
  if (typeof hex !== "string" || hex.length === 0 || hex.length % 2 !== 0) {
    return Response.json({ error: "`hex` must be a non-empty even-length hex string" }, { status: 400 });
  }
  if (!/^[0-9a-fA-F]+$/.test(hex)) {
    return Response.json({ error: "`hex` contains invalid characters" }, { status: 400 });
  }

  const enableQos = qos === true; // default false — read-back uses the persistent socket and blocks polling
  const speakerName =
    typeof (rawBody as Record<string, unknown>).speakerName === "string"
      ? ((rawBody as Record<string, unknown>).speakerName as string).trim()
      : "";
  const hexStr = speakerName ? writeSpeakerNameIntoBlob(hex as string, speakerName) : (hex as string);
  const body = Buffer.from(hexStr, "hex");
  const variant = detectSpeakerVariant(body.length);

  if (isSimulatedMac(mac)) {
    return Response.json({
      success: true,
      mac,
      channels,
      variant,
      byteLength: body.length,
      results: (channels as number[]).map((ch) => ({ channel: ch, sent: true, verified: false, simulated: true }))
    });
  }

  try {
    ampController.start();

    const ip = ampController.getIpForMac(mac);
    if (!ip) {
      return Response.json({ error: `Amp ${mac} not yet discovered` }, { status: 404 });
    }

    // Original software behavior confirms:
    //   - Persistent socket (port 45454→45455), NOT ephemeral
    //   - 450-byte application fragments
    //   - Each fragment advances on ACK, with retry on timeout
    //
    // Wire format: FC=57, statusCode=0 (Response/inject), inOutFlag=1 (Output),
    // link=channelBitmask, chx=0
    const results: {
      channel: number;
      sent: boolean;
      verified: boolean | null;
      error?: string;
      transport?: { frameAttempts: number; fragmentRetries: number };
    }[] = [];

    for (const ch of channels as number[]) {
      try {
        const channelMask = 1 << ch;

        const doSend = () =>
          ampController.sendFC(
            mac,
            FuncCode.SPEAKER_DATA,
            0, // chx=0 — channel encoded in link bitmask
            body,
            1, // inOutFlag = Output
            channelMask, // link = channel bitmask
            0, // statusCode = 0 (Response/inject)
            10 // retained for API compatibility; send pacing is ACK-driven
          );

        // Send via persistent socket with original ACK-paced fragmentation.
        let sendMeta = await doSend();

        // Give the amp ~500ms to process (original takes ~420ms based on Wireshark)
        await new Promise<void>((resolve) => setTimeout(resolve, 500));

        let verified: boolean | null = null; // null = not checked (QoS disabled)

        if (enableQos) {
          // Byte-for-byte read-back against the exact blob we intended to write —
          // a length-only check would pass even if the amp stored the wrong preset
          // content. If it doesn't match yet, resend and re-check a few times
          // before giving up (the amp occasionally drops the ephemeral-style write).
          const maxRounds = 3;
          verified = false;
          for (let round = 0; round < maxRounds && !verified; round++) {
            if (round > 0) {
              sendMeta = await doSend();
              await new Promise<void>((resolve) => setTimeout(resolve, 500));
            }
            try {
              const readBack = await ampController.requestFC(
                mac,
                FuncCode.SPEAKER_DATA,
                ch,
                Buffer.alloc(0),
                1,
                3000
              );
              verified = speakerDataContentEquals(readBack, body);
            } catch {
              // QoS verification is best-effort — treat a failed read-back as
              // "not yet confirmed" and let the retry loop try again.
              verified = false;
            }
          }
        }

        results.push({ channel: ch, sent: true, verified, transport: sendMeta });
      } catch (err) {
        results.push({
          channel: ch,
          sent: false,
          verified: false,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    }

    const allSent = results.every((r) => r.sent);
    // null = QoS disabled (not checked); true/false = checked pass/fail
    const allVerified: boolean | null = enableQos ? results.every((r) => r.verified === true) : null;

    return Response.json({
      success: allSent,
      mac,
      channels,
      variant,
      byteLength: body.length,
      qos: enableQos,
      allVerified,
      results
    });
  } catch (err) {
    return Response.json(
      { error: `FC=57 inject failed: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 }
    );
  }
}

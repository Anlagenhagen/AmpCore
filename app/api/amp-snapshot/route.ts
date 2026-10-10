/**
 * POST /api/amp-snapshot
 *
 * Capture a verified image of every requested amp: the raw FC=27 channel-config
 * region plus the raw FC=57 speaker block of each output channel.
 *
 * Every block is read TWICE and the two reads are compared byte for byte. A
 * single read cannot distinguish a good value from a truncated or
 * half-reassembled one, and this protocol produces exactly those failures under
 * load. Config data does not change by itself, so two differing reads mean the
 * read is untrustworthy — the block is then marked `readVerified: false` rather
 * than silently stored. The caller decides whether to keep such a snapshot.
 *
 * Request body: { macs: string[] }
 * Response:     { success, amps: SnapshotAmp[] }
 */

import { createHash } from "crypto";
import { ampController } from "@/lib/amp-controller";
import { FuncCode } from "@/lib/amp-device";
import { isSimulatedMac } from "@/lib/simulated-amps";
import { detectSpeakerVariant } from "@/lib/parse-speaker-data";
import { parseFC27Channels } from "@/lib/parse-channel-data";
import type { SnapshotAmp, SnapshotBlock, SnapshotSpeakerBlock } from "@/lib/types/amp-snapshot";

export const dynamic = "force-dynamic";

/** Settling time between the two reads of a block. */
const REREAD_DELAY_MS = 120;
/** Per-read timeout for FC=57; the payload can be 2.4 kB across six fragments. */
const SPEAKER_READ_TIMEOUT_MS = 3000;

const sha256 = (hex: string) => createHash("sha256").update(hex, "hex").digest("hex");
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Read a block twice and report whether both reads agree.
 *
 * Both reads must succeed AND match. A failed second read is treated as
 * unverified rather than falling back to the first — "we only managed to read
 * it once" is exactly the situation this guard exists for.
 */
async function readTwice(read: () => Promise<Buffer>): Promise<SnapshotBlock> {
  let first: Buffer;
  try {
    first = await read();
  } catch (err) {
    return {
      hex: "",
      sha256: "",
      byteLength: 0,
      readVerified: false,
      error: err instanceof Error ? err.message : String(err)
    };
  }

  const hex = first.toString("hex");
  const block: SnapshotBlock = {
    hex,
    sha256: sha256(hex),
    byteLength: first.length,
    readVerified: false
  };

  await sleep(REREAD_DELAY_MS);

  try {
    const second = await read();
    block.readVerified = second.equals(first);
    if (!block.readVerified) {
      block.error = `Two consecutive reads differ (${first.length} B vs ${second.length} B) — value not trustworthy`;
    }
  } catch (err) {
    block.error = `Confirmation read failed: ${err instanceof Error ? err.message : String(err)}`;
  }

  return block;
}

async function captureAmp(mac: string): Promise<SnapshotAmp> {
  const info = ampController.getDiscoveryInfoForMac(mac);
  const ip = info?.ip ?? ampController.getIpForMac(mac) ?? "";
  const outputChannels = info?.basicInfo?.Output_chx || ampController.getChannelCountForMac(mac) || 4;

  const base: SnapshotAmp = {
    mac,
    name: info?.name ?? "",
    ip,
    deviceVersion: info?.version,
    outputChannels,
    analogInputChannels: info?.basicInfo?.Analog_signal_Input_chx,
    channelData: { hex: "", sha256: "", byteLength: 0, readVerified: false },
    speakerData: [],
    fullyVerified: false
  };

  if (!ip) {
    base.channelData.error = `Amp ${mac} not discovered`;
    return base;
  }

  // FC=27 — the whole channel-config region. Captured raw because it also
  // carries fields the parser does not surface yet (bridges @34/35,
  // standby @32, rotary lock @33).
  base.channelData = await readTwice(() => ampController.requestFC27(mac, 0));

  if (base.channelData.hex) {
    try {
      const channels = parseFC27Channels(base.channelData.hex, undefined, outputChannels);
      base.parsed = {
        channels: channels.map((c) => ({
          channel: c.channel,
          outputName: c.outputName,
          inputName: c.inputName,
          muteIn: c.muteIn,
          muteOut: c.muteOut,
          volumeOut: c.volumeOut,
          trimOut: c.trimOut,
          gainIn: c.gainIn,
          delayIn: c.delayIn,
          delayOut: c.delayOut,
          invertedOut: c.invertedOut,
          noiseGateOut: c.noiseGateOut,
          sourceType: c.sourceType,
          powerMode: c.powerMode,
          firBypassed: c.firBypassed,
          matrix: c.matrix.map((m) => ({ source: m.source, gain: m.gain, active: m.active }))
        }))
      };
    } catch {
      // A parse failure must not lose the raw capture — the bytes are what
      // a restore uses, the parsed view is only for showing a diff.
    }
  }

  // FC=57 — one speaker block per output channel.
  for (let ch = 0; ch < outputChannels; ch++) {
    const block = await readTwice(() =>
      ampController.requestFC(mac, FuncCode.SPEAKER_DATA, ch, Buffer.alloc(0), 1, SPEAKER_READ_TIMEOUT_MS)
    );
    const speakerBlock: SnapshotSpeakerBlock = {
      ...block,
      channel: ch,
      variant: block.byteLength ? detectSpeakerVariant(block.byteLength) : "unknown"
    };
    base.speakerData.push(speakerBlock);
  }

  base.fullyVerified =
    base.channelData.readVerified && base.speakerData.every((block) => block.readVerified);

  return base;
}

export async function POST(request: Request): Promise<Response> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const macs = (raw as { macs?: unknown })?.macs;
  if (!Array.isArray(macs) || macs.length === 0 || macs.some((m) => typeof m !== "string")) {
    return Response.json({ error: "`macs` must be a non-empty array of strings" }, { status: 400 });
  }

  ampController.start();

  const amps: SnapshotAmp[] = [];
  // Sequential on purpose: reads to one amp are serialized by the controller
  // anyway, and capturing a whole rack at once would compete with the running
  // poller for the same socket. A snapshot may take a few seconds; it must not
  // disturb live monitoring to save them.
  for (const mac of macs as string[]) {
    if (isSimulatedMac(mac)) {
      amps.push({
        mac,
        name: "Simulated amp",
        ip: "",
        outputChannels: 4,
        channelData: { hex: "", sha256: "", byteLength: 0, readVerified: false, error: "Simulated amp" },
        speakerData: [],
        fullyVerified: false
      });
      continue;
    }
    amps.push(await captureAmp(mac));
  }

  return Response.json({
    success: true,
    amps,
    fullyVerified: amps.every((a) => a.fullyVerified)
  });
}

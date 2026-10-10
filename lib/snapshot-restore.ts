/**
 * Restoring a project snapshot onto live amps.
 *
 * Deliberately client-side: every write here goes through the existing verified
 * actions, which read the value back from the amp and re-send until it matches,
 * and through the queue, which serializes writes per amp. Re-implementing that
 * server-side would mean a second copy of the verification logic that could
 * drift from the first.
 *
 * Order per channel is fixed and matters:
 *   1. mute the output (optional, default on)
 *   2. write the FC=57 speaker block — one byte-verified write that carries
 *      EQ, crossover, limiter, delay, polarity and FIR at once
 *   3. write what FC=57 does not contain: levels, routing, names, mute states
 *
 * Step 2 before step 3 because the speaker block also carries volume, delay and
 * polarity; writing the individual values afterwards lets the snapshot's
 * channel-level values win where the two disagree.
 */

import type { ChannelParams } from "@/stores/AmpStore";
import type { ProjectSnapshot, RestoreOptions, SnapshotAmp } from "@/lib/types/amp-snapshot";

/** bytes 0..31 of an FC=57 block are the amp's own identity stamp */
const DEVICE_NAME_FIELD_LEN = 32;

export interface RestoreChange {
  kind: "speaker" | "level" | "mute" | "routing" | "name";
  label: string;
  /** Current value, formatted for display. Undefined when not readable. */
  from?: string;
  /** Value from the snapshot, formatted for display. */
  to: string;
}

export interface RestoreChannelPlan {
  sourceMac: string;
  sourceChannel: number;
  targetMac: string;
  targetChannel: number;
  /** e.g. "DSP-3004D2 · CH2" */
  targetLabel: string;
  changes: RestoreChange[];
  /** Reasons this channel cannot be restored at all. */
  blockers: string[];
}

export interface RestorePlan {
  channels: RestoreChannelPlan[];
  warnings: string[];
}

export interface RestoreStepResult {
  targetMac: string;
  targetChannel: number;
  step: string;
  ok: boolean;
  error?: string;
}

const fmtDb = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(1)} dB`;
const fmtMs = (v: number) => `${v.toFixed(3)} ms`;
const onOff = (v: boolean) => (v ? "on" : "off");

/**
 * Build the preview: what each mapped channel would change.
 *
 * Levels, mutes, routing and names are diffed against live polled data so the
 * user sees real before/after. The speaker block is not diffed byte by byte —
 * it is a 2.4 kB opaque blob — so it is listed as a single replacement, and its
 * compatibility with the target is checked at write time, where the target's
 * current block is read anyway.
 */
export function planRestore(
  snapshot: ProjectSnapshot,
  mapping: Record<string, { targetMac: string | null; channelMap: Record<number, number | null> }>,
  live: Record<string, { name: string; channelParams?: ChannelParams; outputChannels: number }>,
  options: RestoreOptions
): RestorePlan {
  const channels: RestoreChannelPlan[] = [];
  const warnings: string[] = [];

  for (const amp of snapshot.amps) {
    const map = mapping[amp.mac];
    if (!map?.targetMac) continue;

    const target = live[map.targetMac];
    if (!target) {
      warnings.push(`Target amp ${map.targetMac} is not reachable — skipped.`);
      continue;
    }

    if (!amp.fullyVerified) {
      warnings.push(
        `${amp.name || amp.mac}: snapshot was not fully confirmed on read — values may be incomplete.`
      );
    }

    for (const [srcStr, targetChannel] of Object.entries(map.channelMap)) {
      const sourceChannel = Number(srcStr);
      if (targetChannel === null || targetChannel === undefined) continue;

      const plan: RestoreChannelPlan = {
        sourceMac: amp.mac,
        sourceChannel,
        targetMac: map.targetMac,
        targetChannel,
        targetLabel: `${target.name || map.targetMac} · CH${targetChannel + 1}`,
        changes: [],
        blockers: []
      };

      if (targetChannel >= target.outputChannels) {
        plan.blockers.push(`Target has only ${target.outputChannels} channels`);
      }

      const src = amp.parsed?.channels?.[sourceChannel];
      const cur = target.channelParams?.channels?.[targetChannel];
      const speaker = amp.speakerData.find((b) => b.channel === sourceChannel);

      if (options.speakerProcessing) {
        if (!speaker?.hex) {
          plan.blockers.push("No speaker block in snapshot");
        } else {
          plan.changes.push({
            kind: "speaker",
            label: "EQ, crossover, limiter, delay, polarity, FIR",
            to: `${speaker.byteLength} Byte (${speaker.variant})${speaker.readVerified ? "" : " — read unverified!"}`
          });
        }
      }

      if (src) {
        if (options.levels) {
          if (!cur || cur.volumeOut !== src.volumeOut) {
            plan.changes.push({
              kind: "level",
              label: "Volume",
              from: cur ? fmtDb(cur.volumeOut) : undefined,
              to: fmtDb(src.volumeOut)
            });
          }
          if (!cur || cur.trimOut !== src.trimOut) {
            plan.changes.push({
              kind: "level",
              label: "Trim",
              from: cur ? fmtDb(cur.trimOut) : undefined,
              to: fmtDb(src.trimOut)
            });
          }
          if (!cur || cur.delayOut !== src.delayOut) {
            plan.changes.push({
              kind: "level",
              label: "Delay out",
              from: cur ? fmtMs(cur.delayOut) : undefined,
              to: fmtMs(src.delayOut)
            });
          }
          if (!cur || cur.delayIn !== src.delayIn) {
            plan.changes.push({
              kind: "level",
              label: "Delay in",
              from: cur ? fmtMs(cur.delayIn) : undefined,
              to: fmtMs(src.delayIn)
            });
          }
        }

        if (options.muteStates) {
          if (!cur || cur.muteOut !== src.muteOut) {
            plan.changes.push({
              kind: "mute",
              label: "Mute out",
              from: cur ? onOff(cur.muteOut) : undefined,
              to: onOff(src.muteOut)
            });
          }
          if (!cur || cur.muteIn !== src.muteIn) {
            plan.changes.push({
              kind: "mute",
              label: "Mute in",
              from: cur ? onOff(cur.muteIn) : undefined,
              to: onOff(src.muteIn)
            });
          }
        }

        if (options.routing) {
          for (const m of src.matrix) {
            const curCell = cur?.matrix?.[m.source];
            if (!curCell || curCell.active !== m.active || curCell.gain !== m.gain) {
              plan.changes.push({
                kind: "routing",
                label: `Matrix AIn${m.source + 1}`,
                from: curCell ? `${onOff(curCell.active)}, ${fmtDb(curCell.gain)}` : undefined,
                to: `${onOff(m.active)}, ${fmtDb(m.gain)}`
              });
            }
          }
          if (!cur || cur.noiseGateOut !== src.noiseGateOut) {
            plan.changes.push({
              kind: "routing",
              label: "Noise Gate",
              from: cur ? onOff(cur.noiseGateOut) : undefined,
              to: onOff(src.noiseGateOut)
            });
          }
        }

        if (options.names && src.outputName && (!cur || cur.outputName !== src.outputName)) {
          plan.changes.push({
            kind: "name",
            label: "Channel name",
            from: cur?.outputName,
            to: src.outputName
          });
        }
      }

      channels.push(plan);
    }
  }

  return { channels, warnings };
}

/** Default identity mapping: same MAC if present, otherwise unmapped. */
export function buildDefaultMapping(
  snapshot: ProjectSnapshot,
  liveMacs: string[]
): Record<string, { targetMac: string | null; channelMap: Record<number, number | null> }> {
  const result: Record<string, { targetMac: string | null; channelMap: Record<number, number | null> }> = {};
  const upper = new Map(liveMacs.map((m) => [m.toUpperCase(), m]));

  for (const amp of snapshot.amps) {
    const same = upper.get(amp.mac.toUpperCase()) ?? null;
    const channelMap: Record<number, number | null> = {};
    for (let ch = 0; ch < amp.outputChannels; ch++) channelMap[ch] = ch;
    result[amp.mac] = { targetMac: same, channelMap };
  }
  return result;
}

/**
 * Write the snapshot's FC=57 block to a channel and verify it landed.
 *
 * Reuses `/api/amp-speaker-data` with `qos: true`, which byte-compares the
 * read-back against what was sent, skipping the 32-byte device identity field
 * the amp overwrites with its own value.
 */
async function writeSpeakerBlock(mac: string, channel: number, hex: string): Promise<void> {
  const res = await fetch("/api/amp-speaker-data", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mac, channels: [channel], hex, qos: true })
  });
  const data = (await res.json()) as { success?: boolean; allVerified?: boolean | null; error?: string };
  if (!res.ok || !data.success) throw new Error(data.error ?? `HTTP ${res.status}`);
  if (data.allVerified === false) {
    throw new Error("Read-back speaker block does not match the snapshot");
  }
}

/** Read a channel's current FC=57 length, to refuse a write across variants. */
async function readSpeakerLength(mac: string, channel: number): Promise<number | null> {
  try {
    const res = await fetch(`/api/amp-speaker-data?mac=${encodeURIComponent(mac)}&channel=${channel}`);
    const data = (await res.json()) as { byteLength?: number };
    return typeof data.byteLength === "number" ? data.byteLength : null;
  } catch {
    return null;
  }
}

export interface RestoreActions {
  muteOut: (mac: string, channel: number, muted: boolean) => Promise<void>;
  muteIn: (mac: string, channel: number, muted: boolean) => Promise<void>;
  setVolumeOut: (mac: string, channel: number, db: number) => Promise<void>;
  setTrimOut: (mac: string, channel: number, db: number) => Promise<void>;
  setDelayOut: (mac: string, channel: number, ms: number) => Promise<void>;
  setDelayIn: (mac: string, channel: number, ms: number) => Promise<void>;
  noiseGateOut: (mac: string, channel: number, enabled: boolean) => Promise<void>;
  setMatrixGain: (mac: string, channel: number, source: number, db: number) => Promise<void>;
  setMatrixActive: (mac: string, channel: number, source: number, active: boolean) => Promise<void>;
  renameOutput: (mac: string, channel: number, name: string) => Promise<void>;
}

export interface RestoreProgress {
  done: number;
  total: number;
  label: string;
}

/**
 * Execute a plan. Returns one result per attempted step so the UI can show
 * exactly what succeeded — a partially applied restore must be visible, not
 * summarised as "done".
 */
export async function executeRestore(
  plan: RestorePlan,
  snapshot: ProjectSnapshot,
  options: RestoreOptions,
  actions: RestoreActions,
  onProgress?: (p: RestoreProgress) => void
): Promise<RestoreStepResult[]> {
  const results: RestoreStepResult[] = [];
  const runnable = plan.channels.filter((c) => c.blockers.length === 0 && c.changes.length > 0);
  const total = runnable.length;
  let done = 0;

  const byMac = new Map<string, SnapshotAmp>(snapshot.amps.map((a) => [a.mac, a]));

  for (const ch of runnable) {
    const amp = byMac.get(ch.sourceMac);
    const src = amp?.parsed?.channels?.[ch.sourceChannel];
    const speaker = amp?.speakerData.find((b) => b.channel === ch.sourceChannel);

    onProgress?.({ done, total, label: ch.targetLabel });

    const record = async (step: string, fn: () => Promise<void>) => {
      try {
        await fn();
        results.push({ targetMac: ch.targetMac, targetChannel: ch.targetChannel, step, ok: true });
      } catch (err) {
        results.push({
          targetMac: ch.targetMac,
          targetChannel: ch.targetChannel,
          step,
          ok: false,
          error: err instanceof Error ? err.message : String(err)
        });
      }
    };

    if (options.muteBeforeWrite) {
      await record("Mute output", () => actions.muteOut(ch.targetMac, ch.targetChannel, true));
    }

    if (options.speakerProcessing && speaker?.hex) {
      const currentLen = await readSpeakerLength(ch.targetMac, ch.targetChannel);
      if (currentLen !== null && currentLen !== speaker.byteLength) {
        results.push({
          targetMac: ch.targetMac,
          targetChannel: ch.targetChannel,
          step: "Speaker block",
          ok: false,
          error: `Format mismatch: snapshot ${speaker.byteLength} B, device ${currentLen} B — not written`
        });
      } else {
        await record("Speaker block", () => writeSpeakerBlock(ch.targetMac, ch.targetChannel, speaker.hex));
      }
    }

    if (src) {
      if (options.levels) {
        await record("Volume", () => actions.setVolumeOut(ch.targetMac, ch.targetChannel, src.volumeOut));
        await record("Trim", () => actions.setTrimOut(ch.targetMac, ch.targetChannel, src.trimOut));
        await record("Delay out", () => actions.setDelayOut(ch.targetMac, ch.targetChannel, src.delayOut));
        await record("Delay in", () => actions.setDelayIn(ch.targetMac, ch.targetChannel, src.delayIn));
      }
      if (options.routing) {
        await record("Noise Gate", () => actions.noiseGateOut(ch.targetMac, ch.targetChannel, src.noiseGateOut));
        for (const m of src.matrix) {
          await record(`Matrix AIn${m.source + 1}`, async () => {
            await actions.setMatrixGain(ch.targetMac, ch.targetChannel, m.source, m.gain);
            await actions.setMatrixActive(ch.targetMac, ch.targetChannel, m.source, m.active);
          });
        }
      }
      if (options.names && src.outputName) {
        await record("Channel name", () => actions.renameOutput(ch.targetMac, ch.targetChannel, src.outputName));
      }
      if (options.muteStates) {
        await record("Mute in", () => actions.muteIn(ch.targetMac, ch.targetChannel, src.muteIn));
        // Output mute last: if the snapshot had it open and the user asked for
        // mute states, this is the step that makes sound. Everything else is
        // already written and verified by now.
        await record("Mute out", () => actions.muteOut(ch.targetMac, ch.targetChannel, src.muteOut));
      }
    }

    done += 1;
    onProgress?.({ done, total, label: ch.targetLabel });
  }

  return results;
}

export { DEVICE_NAME_FIELD_LEN };

/**
 * Project snapshot — a verified image of every amp in a project.
 *
 * The point of this format is that it stores the amp's state in the amp's OWN
 * wire format (raw FC=27 and FC=57 payloads) rather than only a parsed view.
 * Two reasons:
 *
 *  - The raw FC=27 block carries fields the parser does not expose today
 *    (bridge pairs at absolute 34/35, standby at 32, rotary lock at 33). A
 *    snapshot taken now stays complete even as the parser learns more.
 *  - Restoring the FC=57 block is a single verifiable write per channel
 *    instead of ~40 individual parameter commands, which is the difference
 *    between "probably applied" and "byte-compared against what we sent".
 *
 * A parsed view is stored alongside it, but only so the UI can show a diff
 * without re-parsing. The raw bytes are the source of truth.
 */

/** A block read off the wire, with the evidence that it was read correctly. */
export interface SnapshotBlock {
  /** Raw payload as hex. */
  hex: string;
  /** SHA-256 over `hex`, so tampering or disk corruption is detectable. */
  sha256: string;
  byteLength: number;
  /**
   * True when two consecutive reads returned identical bytes.
   *
   * A single read cannot tell a correct value from a corrupted one. Reading
   * twice and requiring equality is the cheapest check that catches a
   * half-reassembled fragment set or a truncated response — exactly the
   * failure modes this protocol is prone to. Config data does not change on
   * its own, so a mismatch means the read is untrustworthy, not that the amp
   * changed.
   */
  readVerified: boolean;
  /** Set when the block could not be read at all. */
  error?: string;
}

export interface SnapshotSpeakerBlock extends SnapshotBlock {
  /** 0-based output channel this FC=57 block was read from. */
  channel: number;
  /** Variant detected from byte length (ycst/115/116/phonic/117/tecnare). */
  variant: string;
}

/** Everything captured for one amp. */
export interface SnapshotAmp {
  mac: string;
  /** Name as shown at capture time — used to label the mapping UI later. */
  name: string;
  ip: string;
  /** Raw FC=0 version string, e.g. "43424B06-106119-DSP-3004". */
  deviceVersion?: string;
  firmwareFamily?: string;
  /** Authoritative output channel count from FC=0 discovery. */
  outputChannels: number;
  analogInputChannels?: number;

  /** FC=27 SYNC_DATA — the whole channel-config region for this amp. */
  channelData: SnapshotBlock;
  /** FC=57 SPEAKER_DATA, one entry per output channel. */
  speakerData: SnapshotSpeakerBlock[];

  /**
   * Parsed view of `channelData`, used for the preview diff and for the
   * individual level/routing/name writes. Those writes are only allowed when
   * `channelData.readVerified` is true.
   */
  parsed?: {
    channels: Array<{
      channel: number;
      outputName: string;
      inputName: string;
      muteIn: boolean;
      muteOut: boolean;
      volumeOut: number;
      trimOut: number;
      gainIn: number;
      delayIn: number;
      delayOut: number;
      invertedOut: boolean;
      noiseGateOut: boolean;
      sourceType: string;
      powerMode: number;
      firBypassed: boolean;
      matrix: Array<{ source: number; gain: number; active: boolean }>;
    }>;
  };

  /** True only when every block of this amp was read verified. */
  fullyVerified: boolean;
}

/** Project-level settings that live in AmpCore, not on the amp. */
export interface SnapshotProjectData {
  /** Per amp: load ohms per channel and the channel-linking configuration. */
  ampConstants: Record<string, unknown>;
  /** Amp order in the rack. */
  ampOrder: string[];
}

export interface ProjectSnapshot {
  schemaVersion: 1;
  id: string;
  /** ISO timestamp of capture. */
  createdAt: string;
  /** Free-text note the user gave, e.g. "vor Umbau Bühne B". */
  note: string;
  projectId: string;
  projectName: string;
  /** App version that wrote this file. */
  appVersion?: string;
  amps: SnapshotAmp[];
  project: SnapshotProjectData;
  /** False when any amp had an unverified or failed block. */
  fullyVerified: boolean;
}

/** One amp of a snapshot mapped onto one amp that is online now. */
export interface SnapshotAmpMapping {
  /** MAC as stored in the snapshot. */
  sourceMac: string;
  /** MAC of the amp to write to, or null to skip this amp entirely. */
  targetMac: string | null;
  /**
   * Channel mapping, source channel index → target channel index.
   * Missing entry or null means "do not restore that channel".
   * Defaults to identity when the channel counts match.
   */
  channelMap: Record<number, number | null>;
}

/** What a restore is allowed to touch. */
export interface RestoreOptions {
  /** Mute affected outputs before writing and leave them muted afterwards. */
  muteBeforeWrite: boolean;
  /** Write the FC=57 block (EQ, crossover, limiter, delay, polarity, FIR). */
  speakerProcessing: boolean;
  /** Write levels: output volume, trim, input gain. */
  levels: boolean;
  /** Write mute states (input and output) as captured. */
  muteStates: boolean;
  /** Write matrix routing and source selection. */
  routing: boolean;
  /** Write channel names. */
  names: boolean;
}

export const DEFAULT_RESTORE_OPTIONS: RestoreOptions = {
  muteBeforeWrite: true,
  speakerProcessing: true,
  levels: true,
  muteStates: false,
  routing: true,
  names: true
};

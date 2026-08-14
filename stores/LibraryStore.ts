import { create } from "zustand";
import { toSlug } from "@/lib/constants";
import type {
  ParsedSpeakerData,
  SpeakerVariant,
  SpeakerEqBand,
  SpeakerRmsLimiter,
  SpeakerPeakLimiter,
  SpeakerFir
} from "@/lib/parse-speaker-data";

// Re-export parsed types so consumers don't need a separate import
export type { ParsedSpeakerData, SpeakerVariant, SpeakerEqBand, SpeakerRmsLimiter, SpeakerPeakLimiter, SpeakerFir };

export interface LibrarySpeakerWayEntry {
  id: string;
  label: string;
  role: string;
}

/** FC=57 device data captured for a single way/physical output at save time. */
export interface LibraryWayDeviceData {
  /** Which physical output channel (0-based) this was read from */
  physicalChannel: number;
  /** Amp variant detected from body length */
  variant: SpeakerVariant;
  /** Raw FC=57 body as hex — can be sent back verbatim for injection */
  hex: string;
  /** Byte length of the raw blob */
  byteLength: number;
  /** Fully parsed fields from the blob */
  parsed: ParsedSpeakerData;
}

export interface LibrarySpeakerProcessingEntry {
  fir?: Record<string, unknown>;
  eq?: Record<string, unknown>;
  trim?: Record<string, unknown>;
  delay?: Record<string, unknown>;
  polarity?: Record<string, unknown>;
  limiter?: Record<string, unknown>;
  mode?: Record<string, unknown>;
}

export interface LibraryFileEntry {
  schemaVersion: number;
  id: string;
  kind: string;
  name: string;
  brand: string;
  family: string;
  model: string;
  application: string;
  notes: string;
  wayLabelsText: string;
  wayCount: number;
  ways: LibrarySpeakerWayEntry[];
  processing: LibrarySpeakerProcessingEntry[];
  /** Per-way FC=57 snapshots captured at save time. Same order/length as `ways`. */
  deviceData: (LibraryWayDeviceData | null)[];
  parseError?: string;
}

/** Payload passed to saveToLibrary — describes one way to capture. */
export interface SaveWayMapping {
  /** Way label (e.g. "High", "Low") */
  label: string;
  /** Way role hint */
  role: string;
  /** Physical output channel 0-based to read FC=57 from */
  physicalChannel: number;
}

export interface SaveToLibraryParams {
  mac: string;
  id?: string;
  /**
   * When set, PUT /api/library/[existingId] is used instead of POST.
   * The existing file is overwritten in-place (metadata updated, deviceData preserved/replaced).
   */
  existingId?: string;
  brand: string;
  family: string;
  model: string;
  application: string;
  notes: string;
  wayMappings: SaveWayMapping[];
  onProgress?: (progress: SaveProgress) => void;
}

/** Payload for applyToDevice — maps each way's stored hex to a physical channel. */
export interface ApplyWayMapping {
  /** Raw FC=57 hex blob to inject */
  hex: string;
  /** Physical output channels (0-based) to apply this way's data to */
  channels: number[];
  /** Way label used as the base name when embedding the sync hash into the channel name */
  wayLabel?: string;
}

export interface ApplyToDeviceParams {
  mac: string;
  /** One entry per way, in the same order as the library profile's ways array. */
  wayMappings: ApplyWayMapping[];
  /** Enable read-back verification per channel (default true). */
  qos?: boolean;
  /**
   * Speaker model name to embed in the FC=57 blob before sending.
   * Only has effect on variants that carry a SpeakerName field (YCST, 117, Tecnare).
   */
  speakerName?: string;
  onProgress?: (progress: ApplyProgress) => void;
}

export interface SaveProgress {
  stage: "reading-way" | "writing-library" | "refreshing-library";
  current: number;
  total: number;
  channel?: number;
  label?: string;
}

export interface ApplyProgress {
  stage: "sending-way" | "way-complete";
  current: number;
  total: number;
  channels: number[];
  result?: ApplyWayResult;
}

export interface ApplyWayResult {
  wayIndex: number;
  channels: number[];
  sent: boolean;
  /** true = verified, false = verification failed, null = QoS was not requested */
  verified: boolean | null;
  frameAttemptsMax: number;
  fragmentRetries: number;
  retriedChannels: number;
  error?: string;
}

interface LibraryStore {
  files: LibraryFileEntry[];
  selectedFileId: string | null;
  loading: boolean;
  saving: boolean;
  applying: boolean;
  deleting: boolean;
  error: string | null;
  hasLoaded: boolean;
  setSelectedFileId: (fileId: string | null) => void;
  loadLibrary: () => Promise<void>;
  deleteLibraryFile: (fileId: string) => Promise<{ ok: boolean; error?: string }>;
  saveToLibrary: (params: SaveToLibraryParams) => Promise<{ ok: boolean; savedId?: string; error?: string }>;
  applyToDevice: (params: ApplyToDeviceParams) => Promise<{ ok: boolean; results: ApplyWayResult[]; error?: string }>;
}

export const useLibraryStore = create<LibraryStore>((set, get) => ({
  files: [],
  selectedFileId: null,
  loading: false,
  saving: false,
  applying: false,
  deleting: false,
  error: null,
  hasLoaded: false,

  setSelectedFileId: (fileId) => {
    set({ selectedFileId: fileId });
  },

  loadLibrary: async () => {
    if (get().loading) return;
    set({ loading: true, error: null });

    try {
      const response = await fetch("/api/library", { cache: "no-store" });
      const data = (await response.json()) as {
        success: boolean;
        files?: LibraryFileEntry[];
        error?: string;
      };

      if (!response.ok || !data.success) {
        throw new Error(data.error ?? `HTTP ${response.status}`);
      }

      const files = data.files ?? [];
      const selectedFileId = get().selectedFileId;

      set({
        files,
        selectedFileId: files.some((file) => (file.id || file.name) === selectedFileId) ? selectedFileId : null,
        loading: false,
        error: null,
        hasLoaded: true
      });
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : "Failed to load library",
        hasLoaded: true
      });
    }
  },

  deleteLibraryFile: async (fileId) => {
    if (get().deleting) return { ok: false, error: "Delete already in progress" };

    set({ deleting: true, error: null });

    try {
      const response = await fetch(`/api/library?id=${encodeURIComponent(fileId)}`, {
        method: "DELETE"
      });
      const data = (await response.json()) as {
        success?: boolean;
        error?: string;
      };

      if (!response.ok || !data.success) {
        throw new Error(data.error ?? `HTTP ${response.status}`);
      }

      if (get().selectedFileId === fileId) {
        set({ selectedFileId: null });
      }

      set({ deleting: false });
      await get().loadLibrary();
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to delete library file";
      set({ deleting: false, error: message });
      return { ok: false, error: message };
    }
  },

  saveToLibrary: async (params) => {
    if (get().saving) return { ok: false, error: "Save already in progress" };

    set({ saving: true, error: null });

    try {
      const { mac, brand, family, model, application, notes, wayMappings, onProgress, existingId } = params;

      if (wayMappings.length === 0) {
        throw new Error("At least one way mapping is required");
      }

      // 1. Fetch FC=57 for each way's physical channel (sequentially)
      const wayDeviceData: (LibraryWayDeviceData | null)[] = [];

      for (let index = 0; index < wayMappings.length; index++) {
        const mapping = wayMappings[index];
        onProgress?.({
          stage: "reading-way",
          current: index + 1,
          total: wayMappings.length,
          channel: mapping.physicalChannel,
          label: mapping.label
        });

        const res = await fetch(
          `/api/amp-speaker-data?mac=${encodeURIComponent(mac)}&channel=${mapping.physicalChannel}`
        );
        const data = (await res.json()) as {
          success?: boolean;
          variant?: SpeakerVariant;
          byteLength?: number;
          hex?: string;
          parsed?: ParsedSpeakerData | null;
          error?: string;
          simulated?: boolean;
        };

        if (!res.ok || !data.success || !data.parsed) {
          wayDeviceData.push(null);
        } else {
          wayDeviceData.push({
            physicalChannel: mapping.physicalChannel,
            variant: data.variant ?? "unknown",
            hex: data.hex ?? "",
            byteLength: data.byteLength ?? 0,
            parsed: data.parsed
          });
        }
      }

      // 2. Build the profile payload
      const idSlug = toSlug(params.id ?? [brand, family, model].filter(Boolean).join("-")) || "speaker-profile";

      const ways = wayMappings.map((m, idx) => ({
        id: toSlug(m.label) || `way-${idx + 1}`,
        label: m.label || `Way ${idx + 1}`,
        role: m.role || "custom",
        deviceData: wayDeviceData[idx] ?? null
      }));

      const profile = {
        schemaVersion: 2,
        id: idSlug,
        kind: "speaker",
        speaker: {
          brand,
          family,
          model,
          application,
          notes,
          wayLabelsText: ways.map((w) => w.label).join(" & "),
          ways
        }
      };

      // 3. Write to library API — PUT to update existing, POST to create new
      onProgress?.({ stage: "writing-library", current: wayMappings.length, total: wayMappings.length });

      const isUpdate = Boolean(existingId);
      const writeRes = await fetch(isUpdate ? `/api/library/${encodeURIComponent(existingId!)}` : "/api/library", {
        method: isUpdate ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile })
      });

      const writeData = (await writeRes.json()) as {
        success?: boolean;
        file?: LibraryFileEntry;
        error?: string;
      };

      if (!writeRes.ok || !writeData.success) {
        throw new Error(writeData.error ?? `HTTP ${writeRes.status}`);
      }

      // The committed id: for updates the id is preserved as existingId; for creates use idSlug.
      const committedId = isUpdate ? existingId! : idSlug;

      // 4. Refresh the library list
      onProgress?.({ stage: "refreshing-library", current: wayMappings.length, total: wayMappings.length });

      set({ saving: false });
      await get().loadLibrary();

      return { ok: true, savedId: committedId };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to save to library";
      set({ saving: false, error: message });
      return { ok: false, error: message };
    }
  },

  applyToDevice: async (params) => {
    if (get().applying) return { ok: false, results: [], error: "Apply already in progress" };

    set({ applying: true, error: null });

    try {
      const { mac, wayMappings, qos = false, speakerName, onProgress } = params;

      if (wayMappings.length === 0) {
        throw new Error("At least one way mapping is required");
      }

      const results: ApplyWayResult[] = [];

      // Apply sequentially — one way at a time to avoid flooding the device.
      for (let i = 0; i < wayMappings.length; i++) {
        const mapping = wayMappings[i];

        onProgress?.({
          stage: "sending-way",
          current: i + 1,
          total: wayMappings.length,
          channels: mapping.channels
        });

        // Client-side validation before sending to the API (issue #7)
        const hexInvalid =
          !mapping.hex ||
          mapping.hex.length === 0 ||
          mapping.hex.length % 2 !== 0 ||
          !/^[0-9a-fA-F]+$/.test(mapping.hex);
        const badChannel = mapping.channels.find((ch) => !Number.isInteger(ch) || ch < 0 || ch > 7);

        if (hexInvalid || mapping.channels.length === 0 || badChannel !== undefined) {
          const errorMsg = hexInvalid
            ? "Invalid or missing hex data for this way"
            : badChannel !== undefined
              ? `Channel ${String(badChannel)} is out of range (0–7)`
              : "No target channels specified";
          const result = {
            wayIndex: i,
            channels: mapping.channels,
            sent: false,
            verified: null,
            frameAttemptsMax: 0,
            fragmentRetries: 0,
            retriedChannels: 0,
            error: errorMsg
          };
          results.push(result);
          onProgress?.({
            stage: "way-complete",
            current: i + 1,
            total: wayMappings.length,
            channels: mapping.channels,
            result
          });
          continue;
        }

        try {
          const res = await fetch("/api/amp-speaker-data", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ mac, channels: mapping.channels, hex: mapping.hex, qos, speakerName })
          });

          const data = (await res.json()) as {
            success?: boolean;
            allVerified?: boolean | null;
            results?: {
              channel: number;
              sent: boolean;
              verified: boolean | null;
              error?: string;
              transport?: { frameAttempts: number; fragmentRetries: number };
            }[];
            error?: string;
          };

          if (!res.ok || !data.success) {
            const result = {
              wayIndex: i,
              channels: mapping.channels,
              sent: false,
              verified: null,
              frameAttemptsMax: 0,
              fragmentRetries: 0,
              retriedChannels: 0,
              error: data.error ?? `HTTP ${res.status}`
            };
            results.push(result);
            onProgress?.({
              stage: "way-complete",
              current: i + 1,
              total: wayMappings.length,
              channels: mapping.channels,
              result
            });
          } else {
            const channelResults = data.results ?? [];
            const allSent = channelResults.every((r) => r.sent);
            // null = QoS not requested; true/false = pass/fail
            const allVerified: boolean | null = qos ? channelResults.every((r) => r.verified === true) : null;
            const frameAttemptsMax = channelResults.reduce(
              (max, r) => Math.max(max, r.transport?.frameAttempts ?? 1),
              1
            );
            const fragmentRetries = channelResults.reduce((sum, r) => sum + (r.transport?.fragmentRetries ?? 0), 0);
            const retriedChannels = channelResults.filter(
              (r) => (r.transport?.frameAttempts ?? 1) > 1 || (r.transport?.fragmentRetries ?? 0) > 0
            ).length;

            const result = {
              wayIndex: i,
              channels: mapping.channels,
              sent: allSent,
              verified: allVerified,
              frameAttemptsMax,
              fragmentRetries,
              retriedChannels
            };
            results.push(result);
            onProgress?.({
              stage: "way-complete",
              current: i + 1,
              total: wayMappings.length,
              channels: mapping.channels,
              result
            });
          }
        } catch (err) {
          const result = {
            wayIndex: i,
            channels: mapping.channels,
            sent: false,
            verified: null,
            frameAttemptsMax: 0,
            fragmentRetries: 0,
            retriedChannels: 0,
            error: err instanceof Error ? err.message : String(err)
          };
          results.push(result);
          onProgress?.({
            stage: "way-complete",
            current: i + 1,
            total: wayMappings.length,
            channels: mapping.channels,
            result
          });
        }
      }

      // `sent` only means the write left the Mac — with QoS enabled (verified !== null),
      // require the read-back byte comparison to have passed too, otherwise "ok" would
      // report success even when the amp ended up with different preset content.
      const allOk = results.every((r) => r.sent && r.verified !== false);
      set({ applying: false });
      return { ok: allOk, results };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to apply to device";
      set({ applying: false, error: message });
      return { ok: false, results: [], error: message };
    }
  }
}));

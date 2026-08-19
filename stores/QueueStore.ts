import { create } from "zustand";
import { toast } from "sonner";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type QueueStepStatus = "pending" | "inflight" | "done" | "failed";
export type QueuePacketStatus =
  | "queued"
  | "processing"
  | "completed"
  | "partial"
  | "failed"
  /** Dropped before reaching the wire because a newer packet fully replaces it. */
  | "superseded";
export type QueuePriority = "realtime" | "reliable";

export interface QueueStep {
  id: string;
  mac: string;
  channel?: number;
  endpoint: string;
  payload: Record<string, unknown>;
  status: QueueStepStatus;
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
  error?: string;
  httpStatus?: number;
}

export interface QueuePacket {
  id: string;
  origin: string;
  action: string;
  priority: QueuePriority;
  status: QueuePacketStatus;
  createdAt: number;
  completedAt?: number;
  durationMs?: number;
  steps: QueueStep[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_HISTORY = 300;
const RELIABLE_MAX_RETRIES = 2;
const STEP_TIMEOUT_MS = 5000;

// ---------------------------------------------------------------------------
// ID generation (no external deps)
// ---------------------------------------------------------------------------

let _counter = 0;

function generateId(prefix: string): string {
  const now = Date.now().toString(36);
  const count = (++_counter).toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${prefix}_${now}${count}${rand}`;
}

// ---------------------------------------------------------------------------
// Coalescing key for realtime lane
// ---------------------------------------------------------------------------

function coalesceKey(step: { mac: string; channel?: number; endpoint: string }, action: string): string {
  return `${step.mac}|${action}|${step.channel ?? "*"}|${step.endpoint}`;
}

// ---------------------------------------------------------------------------
// Supersession for the reliable lane
// ---------------------------------------------------------------------------

/**
 * Actions that write a COMPLETE state block, so a newer packet for the same
 * scope makes an older still-queued one redundant. Dropping the stale one keeps
 * rapid clicking responsive instead of building a backlog where every click
 * costs a full apply+verify round-trip.
 *
 * Only add actions here whose payload is the entire state for that scope —
 * incremental/relative actions must never be superseded.
 */
const SUPERSEDABLE_ACTIONS = new Set(["eqBlock"]);

/** Scope identity of a supersedable packet: same scope ⇒ newer replaces older. */
function supersedeKey(packet: QueuePacket): string | null {
  if (!SUPERSEDABLE_ACTIONS.has(packet.action)) return null;
  const scope = packet.steps
    .map((s) => `${s.mac}#${s.channel ?? "*"}`)
    .sort()
    .join(",");
  // eqBlock addresses input and output EQ separately — they must not supersede
  // each other, so the target is part of the identity.
  const target = typeof packet.steps[0]?.payload?.target === "string" ? packet.steps[0].payload.target : "";
  return `${packet.action}|${scope}|${target}`;
}

// ---------------------------------------------------------------------------
// Store interface
// ---------------------------------------------------------------------------

interface QueueStore {
  /** Packets currently being processed or queued. */
  inflight: QueuePacket[];
  /** Completed/failed packet history (ring buffer). */
  history: QueuePacket[];
  /** Total packets processed since app start. */
  totalProcessed: number;
  /** Total steps executed since app start. */
  totalSteps: number;

  /** Enqueue a packet for processing. Returns the packet ID. */
  enqueue: (packet: Omit<QueuePacket, "id" | "status" | "createdAt">) => string;
  /** Get a packet by ID (from inflight or history). */
  getPacket: (id: string) => QueuePacket | undefined;
  /** Clear history. */
  clearHistory: () => void;
}

// ---------------------------------------------------------------------------
// Internal processor
// ---------------------------------------------------------------------------

async function executeStep(step: QueueStep): Promise<QueueStep> {
  const startedAt = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), STEP_TIMEOUT_MS);

    const res = await fetch(step.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(step.payload),
      signal: controller.signal
    });

    clearTimeout(timeout);

    const completedAt = Date.now();
    const durationMs = completedAt - startedAt;

    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      return {
        ...step,
        status: "failed",
        startedAt,
        completedAt,
        durationMs,
        httpStatus: res.status,
        error: data.error ?? `HTTP ${res.status}`
      };
    }

    return {
      ...step,
      status: "done",
      startedAt,
      completedAt,
      durationMs,
      httpStatus: res.status
    };
  } catch (err) {
    const completedAt = Date.now();
    const isTimeout = err instanceof DOMException && err.name === "AbortError";
    return {
      ...step,
      status: "failed",
      startedAt,
      completedAt,
      durationMs: completedAt - startedAt,
      error: isTimeout ? `Timeout (${STEP_TIMEOUT_MS}ms)` : err instanceof Error ? err.message : String(err)
    };
  }
}

async function executeStepWithRetry(step: QueueStep, retries: number): Promise<QueueStep> {
  let result = await executeStep(step);
  let attempt = 0;
  while (result.status === "failed" && attempt < retries) {
    attempt++;
    result = await executeStep(step);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Realtime coalescing state (module-level, not in Zustand to avoid re-renders)
// ---------------------------------------------------------------------------

const realtimePending = new Map<string, { packet: QueuePacket; timeout: ReturnType<typeof setTimeout> }>();

// Reliable lane: one FIFO chain per amp. Writes to the same amp must not overlap —
// the API verifies each write by reading channel data back, so two concurrent
// multi-command operations (e.g. two EQ blocks from fast clicking) would each read
// the other's values, treat them as a mismatch, re-send, and fight until one gives
// up with "[Queue] eqBlock failed". Serializing per amp makes each verification see
// only its own write. Different amps still run in parallel.
const reliableChains = new Map<string, Promise<void>>();

// Packets sitting in a chain that a newer packet may still replace.
const supersedablePending = new Map<string, string>(); // supersedeKey -> packet id
const supersededPacketIds = new Set<string>();

// ---------------------------------------------------------------------------
// Store implementation
// ---------------------------------------------------------------------------

export const useQueueStore = create<QueueStore>()((set, get) => {
  function moveToHistory(packet: QueuePacket) {
    set((state) => {
      const nextHistory = [packet, ...state.history].slice(0, MAX_HISTORY);
      return {
        inflight: state.inflight.filter((p) => p.id !== packet.id),
        history: nextHistory,
        totalProcessed: state.totalProcessed + 1,
        totalSteps: state.totalSteps + packet.steps.length
      };
    });
  }

  function updateInflight(packetId: string, updater: (p: QueuePacket) => QueuePacket) {
    set((state) => ({
      inflight: state.inflight.map((p) => (p.id === packetId ? updater(p) : p))
    }));
  }

  async function processPacket(packet: QueuePacket) {
    updateInflight(packet.id, (p) => ({ ...p, status: "processing" }));

    const retries = packet.priority === "reliable" ? RELIABLE_MAX_RETRIES : 0;
    const completedSteps: QueueStep[] = [];

    // Execute all steps in parallel
    const results = await Promise.allSettled(packet.steps.map((step) => executeStepWithRetry(step, retries)));

    for (const result of results) {
      if (result.status === "fulfilled") {
        completedSteps.push(result.value);
      } else {
        // This shouldn't happen since executeStepWithRetry catches errors
        completedSteps.push({
          ...packet.steps[completedSteps.length],
          status: "failed",
          error: result.reason instanceof Error ? result.reason.message : String(result.reason)
        });
      }
    }

    const failedCount = completedSteps.filter((s) => s.status === "failed").length;
    const completedAt = Date.now();

    let status: QueuePacketStatus;
    if (failedCount === 0) status = "completed";
    else if (failedCount === completedSteps.length) status = "failed";
    else status = "partial";

    const finalPacket: QueuePacket = {
      ...packet,
      status,
      steps: completedSteps,
      completedAt,
      durationMs: completedAt - packet.createdAt
    };

    moveToHistory(finalPacket);

    if (status === "failed") {
      toast.error(`[Queue] ${packet.action} failed`, {
        description: `${failedCount} step${failedCount > 1 ? "s" : ""} failed • ${packet.origin}`,
        duration: 4000
      });
    } else if (status === "partial") {
      toast.warning(`[Queue] ${packet.action} partial`, {
        description: `${failedCount}/${completedSteps.length} steps failed • ${packet.origin}`,
        duration: 4000
      });
    }

    return finalPacket;
  }

  function processRealtime(packet: QueuePacket) {
    // For realtime: coalesce by action+mac+channel. Latest value wins.
    const key = packet.steps.length === 1 ? coalesceKey(packet.steps[0], packet.action) : packet.id; // multi-step realtime packets don't coalesce

    const existing = realtimePending.get(key);
    if (existing) {
      // Replace the pending packet with the newer one, keep the timeout
      clearTimeout(existing.timeout);
      // Remove old from inflight
      set((state) => ({
        inflight: state.inflight.filter((p) => p.id !== existing.packet.id)
      }));
    }

    // Add to inflight
    set((state) => ({ inflight: [...state.inflight, packet] }));

    // Dispatch after a microtask (allows rapid-fire coalescing within the same frame)
    const timeout = setTimeout(() => {
      realtimePending.delete(key);
      void processPacket(packet);
    }, 0);

    realtimePending.set(key, { packet, timeout });
  }

  function processReliable(packet: QueuePacket) {
    set((state) => ({ inflight: [...state.inflight, packet] }));

    // A newer packet for the same scope retires the one still waiting in the chain.
    const key = supersedeKey(packet);
    if (key) {
      const pendingId = supersedablePending.get(key);
      if (pendingId) supersededPacketIds.add(pendingId);
      supersedablePending.set(key, packet.id);
    }

    // Chain per amp so writes to one device never overlap.
    const mac = packet.steps[0]?.mac ?? "";
    const previous = reliableChains.get(mac) ?? Promise.resolve();

    const chained = previous.then(async () => {
      if (supersededPacketIds.has(packet.id)) {
        supersededPacketIds.delete(packet.id);
        const completedAt = Date.now();
        moveToHistory({
          ...packet,
          status: "superseded",
          completedAt,
          durationMs: completedAt - packet.createdAt
        });
        return;
      }
      if (key && supersedablePending.get(key) === packet.id) supersedablePending.delete(key);
      await processPacket(packet);
    });

    // Keep the chain alive even if a packet throws, and drop it once idle so the
    // map doesn't grow unbounded across a long session.
    const settled = chained.catch(() => undefined);
    reliableChains.set(mac, settled);
    void settled.then(() => {
      if (reliableChains.get(mac) === settled) reliableChains.delete(mac);
    });
  }

  return {
    inflight: [],
    history: [],
    totalProcessed: 0,
    totalSteps: 0,

    enqueue: (input) => {
      const packet: QueuePacket = {
        ...input,
        id: generateId("pkt"),
        status: "queued",
        createdAt: Date.now()
      };

      toast.info(`[Queue] ${packet.action}`, {
        description: `${packet.priority} • ${packet.steps.length} step${packet.steps.length > 1 ? "s" : ""} • ${packet.origin}`,
        duration: 2000
      });

      if (packet.priority === "realtime") {
        processRealtime(packet);
      } else {
        processReliable(packet);
      }

      return packet.id;
    },

    getPacket: (id) => {
      const state = get();
      return state.inflight.find((p) => p.id === id) ?? state.history.find((p) => p.id === id);
    },

    clearHistory: () => set({ history: [] })
  };
});

// ---------------------------------------------------------------------------
// Public helpers for creating steps
// ---------------------------------------------------------------------------

export function createStep(
  mac: string,
  endpoint: string,
  payload: Record<string, unknown>,
  channel?: number
): QueueStep {
  return {
    id: generateId("stp"),
    mac,
    channel,
    endpoint,
    payload,
    status: "pending"
  };
}

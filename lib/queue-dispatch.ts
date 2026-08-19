import { toast } from "sonner";
import { useQueueStore, createStep, type QueuePacket, type QueuePriority, type QueueStep } from "@/stores/QueueStore";
import { getLinkedChannels, type LinkScope } from "@/lib/amp-action-linking";
import { getStoredAmpLinkConfig, useAmpActionLinkStore } from "@/stores/AmpActionLinkStore";
import { useActionPending } from "@/stores/ActionPendingStore";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DispatchTarget {
  mac: string;
  channel?: number;
}

export interface DispatchOptions {
  /** Identifies where the action originated (e.g. "useAmpActions.muteOut"). */
  origin: string;
  /** The action name (e.g. "muteOut", "recallPreset"). */
  action: string;
  /** Realtime = coalesce & fire immediately. Reliable = FIFO with retries. */
  priority: QueuePriority;
  /** Target(s) for the action. Each becomes a step. */
  targets: DispatchTarget[];
  /** The API endpoint to POST to. */
  endpoint: string;
  /** Build the request body for each target. */
  buildPayload: (target: DispatchTarget) => Record<string, unknown>;
  /** If true, don't show toast on failure (caller handles). */
  suppressToast?: boolean;
  /** If true, throw on any step failure. */
  throwOnError?: boolean;
}

export interface DispatchLinkedOptions {
  /** Identifies where the action originated. */
  origin: string;
  /** The action name sent to the API. */
  action: string;
  /** Realtime or reliable. */
  priority: QueuePriority;
  /** The amp MAC address. */
  mac: string;
  /** The channel the user interacted with. */
  channel: number;
  /** Linking scope — determines which channels are grouped. */
  scope: LinkScope;
  /** The API endpoint. */
  endpoint: string;
  /** Build payload for each linked channel target. */
  buildPayload: (target: DispatchTarget) => Record<string, unknown>;
  /** If true, don't show toast on failure. */
  suppressToast?: boolean;
  /** If true, throw on failure. */
  throwOnError?: boolean;
}

// ---------------------------------------------------------------------------
// Core dispatch — creates a queue packet and waits for completion.
// ---------------------------------------------------------------------------

export async function dispatch(opts: DispatchOptions): Promise<QueuePacket> {
  const { origin, action, priority, targets, endpoint, buildPayload, suppressToast, throwOnError } = opts;

  const steps: QueueStep[] = targets.map((target) =>
    createStep(target.mac, endpoint, buildPayload(target), target.channel)
  );

  // Mark an action in flight so the UI shows a loading indicator from the moment
  // the user clicks until the amp has confirmed it (the backend reads the value
  // back before responding).
  useActionPending.getState().begin();
  try {
    const packetId = useQueueStore.getState().enqueue({
      origin,
      action,
      priority,
      steps
    });

    // Wait for the packet to finish processing
    const packet = await waitForPacket(packetId);

    if (packet.status === "failed" || packet.status === "partial") {
      const failedSteps = packet.steps.filter((s) => s.status === "failed");
      const firstError = failedSteps[0]?.error ?? "Unknown error";

      if (!suppressToast) {
        const totalSteps = packet.steps.length;
        const failedCount = failedSteps.length;
        if (totalSteps > 1) {
          toast.error(`${action} partially failed (${totalSteps - failedCount}/${totalSteps}): ${firstError}`);
        } else {
          toast.error(`Command failed: ${firstError}`);
        }
      }

      if (throwOnError) {
        throw new Error(failedSteps[0]?.error ?? `${action} failed`);
      }
    }

    return packet;
  } finally {
    useActionPending.getState().end();
  }
}

// ---------------------------------------------------------------------------
// Linked dispatch — resolves intra-amp channel linking, then dispatches.
// ---------------------------------------------------------------------------

export async function dispatchLinked(opts: DispatchLinkedOptions): Promise<QueuePacket> {
  const { mac, channel, scope, ...rest } = opts;

  const config = getStoredAmpLinkConfig(useAmpActionLinkStore.getState().byMac, mac);
  const linkedChannels = getLinkedChannels(config, scope, channel);

  const targets: DispatchTarget[] = linkedChannels.map((ch) => ({ mac, channel: ch }));

  return dispatch({
    ...rest,
    targets
  });
}

// ---------------------------------------------------------------------------
// Wait for packet completion (polls store — packets resolve fast via fetch)
// ---------------------------------------------------------------------------

function waitForPacket(packetId: string): Promise<QueuePacket> {
  return new Promise((resolve) => {
    const check = () => {
      const packet = useQueueStore.getState().getPacket(packetId);
      if (
        packet &&
        (packet.status === "completed" ||
          packet.status === "failed" ||
          packet.status === "partial" ||
          // Replaced by a newer packet for the same scope before it was sent —
          // a normal outcome of fast clicking, not an error.
          packet.status === "superseded")
      ) {
        resolve(packet);
        return;
      }
      // Use microtask polling — packets resolve within a single event loop tick for realtime,
      // or a few hundred ms for reliable.
      setTimeout(check, 2);
    };
    check();
  });
}

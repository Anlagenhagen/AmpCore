"use client";

import { useEffect } from "react";
import { useAmpStore } from "@/stores/AmpStore";
import { useTabStore } from "@/stores/TabStore";
import { useLibraryStore } from "@/stores/LibraryStore";
import { parseFC27Channels, parseFC27RotaryLock } from "@/lib/parse-channel-data";

// Tiered polling: fast for active amp, slow for background amps.
// With 10 amps this drops from ~40 req/sec to ~5 req/sec.
const ACTIVE_POLL_MS = 250; // tick interval (drives active amp)
const BACKGROUND_CHANNEL_MS = 2000; // background amps channel data interval

let channelDataTimer: ReturnType<typeof setInterval> | null = null;
let channelDataSubscribers = 0;
const inFlightMacs = new Set<string>();
const lastChannelPollAtByMac = new Map<string, number>();

/**
 * useAmpChannelData — Tiered channel-data poller
 *
 * Polls FC=27 channel data at 250ms for the active amp (selected in TabStore)
 * and at 2000ms for all other reachable amps. This keeps the active amp
 * fully responsive while preventing network overload with 10+ amps.
 *
 * Lock state is derived from the FC=27 response (no separate poll needed).
 * Standby state is derived from heartbeat machineMode via the SSE stream.
 */
export function useAmpChannelData(): void {
  useEffect(() => {
    channelDataSubscribers++;

    if (!channelDataTimer) {
      channelDataTimer = setInterval(() => {
        const { applying } = useLibraryStore.getState();
        if (applying) {
          return;
        }

        const amps = useAmpStore.getState().amps;
        const reachableAmps = amps.filter((amp) => amp.reachable);
        const selectedMac = useTabStore.getState().selectedAmpMac;
        const now = Date.now();

        reachableAmps.forEach((amp) => {
          const isActive = amp.mac === selectedMac;

          // ── Channel data: fast for active, throttled for background ──
          if (!isActive) {
            const lastPoll = lastChannelPollAtByMac.get(amp.mac) ?? 0;
            if (now - lastPoll < BACKGROUND_CHANNEL_MS) return;
          }

          if (inFlightMacs.has(amp.mac)) return;
          inFlightMacs.add(amp.mac);
          lastChannelPollAtByMac.set(amp.mac, now);

          fetch(`/api/amp-channel-data?mac=${encodeURIComponent(amp.mac)}`)
            .then((r) => r.json())
            .then((response) => {
              if (response.success && response.hex) {
                const { syncChannelParams, updateAmpStatus } = useAmpStore.getState();

                // Authoritative channel count from FC=0 discovery (Output_chx).
                // The FC=27 trailer size varies by firmware, so the parser must
                // not derive the count from the payload length (see
                // resolveFC27ChannelCount) — otherwise 1.1.9 mis-reads a phantom
                // 5th channel and every trailer field (e.g. muteIn) shifts.
                const authoritativeChannelCount = amp.output_chx ?? amp.constants?.channels?.length;
                const channels = parseFC27Channels(response.hex, amp.sourceCapabilities, authoritativeChannelCount);
                const locked = parseFC27RotaryLock(response.hex, authoritativeChannelCount);

                syncChannelParams(amp.mac, channels);
                if (locked !== undefined) {
                  updateAmpStatus(amp.mac, { locked });
                }
              }
            })
            .catch(() => {})
            .finally(() => {
              inFlightMacs.delete(amp.mac);
            });
        });
      }, ACTIVE_POLL_MS);
    }

    return () => {
      channelDataSubscribers = Math.max(0, channelDataSubscribers - 1);
      if (channelDataSubscribers === 0 && channelDataTimer) {
        clearInterval(channelDataTimer);
        channelDataTimer = null;
        inFlightMacs.clear();
        lastChannelPollAtByMac.clear();
      }
    };
  }, []);
}

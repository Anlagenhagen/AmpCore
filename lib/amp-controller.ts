/**
 * amp-controller.ts
 *
 * Server-side singleton that faithfully mirrors the original C# UDP.cs
 * architecture, adapted for multi-amp support (all amps polled, not just one).
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  Receive_Thread  → one persistent UDP socket on 0.0.0.0:45454          │
 * │                    Every packet is:                                      │
 * │                      1. checksum-validated  (isSelfData equivalent)     │
 * │                      2. reassembled if multi-fragment                   │
 * │                      3. ACK'd back to sender  (setReceiveData)          │
 * │                      4. dispatched by function_code                     │
 * │                                                                          │
 * │  queryT_V_A()    → 140 ms loop, unicast FC=6 HEARTBEAT to each known    │
 * │                    amp IP in turn (multi-amp: one per tick, cycling).   │
 * │                    Falls back to broadcast when no amps are known yet.  │
 * │                    Every 25 ticks: judgeOnline() watchdog.              │
 * │                                                                          │
 * │  refrash()       → 4000 ms timer (refresh_step counter):               │
 * │                      step=1: clear window list + broadcast FC=0        │
 * │                      step=2: broadcast FC=0 again + mark offline       │
 * │                    Two-cycle grace: a device must miss TWO consecutive  │
 * │                    4s windows (~8 s) before being declared offline.    │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

import { EventEmitter } from "events";
import { FuncCode, parseHeartbeat } from "./amp-device";
import type { BridgeReadback, HeartbeatData } from "@/stores/AmpStore";
import { NetworkAdapter } from "@/lib/network/network-adapter";
import {
  prependNetworkHeaderToAssembled,
  buildStructHeader,
  buildNetworkDataHeader,
  calcCheckCode,
  FRAGMENT_SIZE,
  NETWORK_HEADER_LEN
} from "@/lib/network/protocol";

// ---------------------------------------------------------------------------
// Constants — matching original C# values exactly
// ---------------------------------------------------------------------------
const BROADCAST_ADDR = "255.255.255.255";
const HEARTBEAT_MS = 140; // queryT_V_A Thread.Sleep(140)
const DISCOVERY_MS = 4000; // TimerRefresh.Interval = 4000
const DISCOVERY_WINDOW_MS = 1000; // MainWindow.Sleep(1000) after broadcast
const MAX_PACKETS_COUNT = 255; // network header packets_count is uint8
// Watchdog: if an amp hasn't sent a heartbeat in this many ms → offline
const HEARTBEAT_TIMEOUT_MS = 3_500; // 25 × 140 ms

// ---------------------------------------------------------------------------
// Event payload types
// ---------------------------------------------------------------------------
export interface DiscoveryEvent {
  ip: string;
  mac: string;
  name: string;
  version: string;
  basicInfo: BasicInfoSnapshot;
}

export interface BasicInfoSnapshot {
  Gain_max: number;
  Analog_signal_Input_chx: number;
  Digital_signal_input_chx: number;
  Output_chx: number;
  Machine_state: number;
}

export interface HeartbeatEvent {
  ip: string;
  mac: string;
  name: string;
  version: string;
  heartbeat: HeartbeatData;
  bridgePairs?: BridgeReadback[];
}

export interface OfflineEvent {
  mac: string;
}

export interface SendFCResult {
  frameAttempts: number;
  fragmentRetries: number;
}

async function getDirectedBroadcasts(): Promise<string[]> {
  const broadcasts: string[] = [];
  for (const iface of Object.values(await ampController.network.getNetworkInterfaces())) {
    if (!iface) continue;
    for (const addr of iface) {
      if (addr.family !== "IPv4" || addr.internal) continue;
      const ip = addr.address.split(".").map(Number);
      const mask = addr.netmask.split(".").map(Number);
      const bcast = ip.map((b, i) => (b & mask[i]) | (~mask[i] & 0xff));
      broadcasts.push(bcast.join("."));
    }
  }
  // Keep limited broadcast as fallback for edge setups.
  const unique = new Set(broadcasts);
  unique.add(BROADCAST_ADDR);
  return Array.from(unique);
}

// ---------------------------------------------------------------------------
// Discovery parser — FC=0 BASIC_INFO response.
//
// FC=0 body variants seen in the original software:
//   75 bytes: Basic_information struct
//   79 bytes: Basic_information + 4-byte extension (vendor/meta)
//   83 bytes: Basic_information variant with 32-byte name field
//   87 bytes: 83-byte variant + 4-byte extension
//
// This parser accepts all of the above. For +4-byte extension variants,
// it trims the extension and parses the base body.
// ---------------------------------------------------------------------------
function parseDiscoveryPacket(raw: Buffer, ip: string): DiscoveryEvent | null {
  // Minimum valid FC=0 packet: NetworkData(10) + StructHeader(10) + body75 + checksum(3)
  if (raw.length < 98) return null;
  if (raw[10] !== 0x55) return null;
  if (raw[11] !== FuncCode.BASIC_INFO) return null;

  const fullBody = raw.slice(20, raw.length - 3);
  let body = fullBody;

  if (fullBody.length === 79 || fullBody.length === 87) {
    body = fullBody.slice(0, fullBody.length - 4);
  }

  if (body.length < 75) {
    return null;
  }

  const readMacAt = (offset: number): Buffer | null => {
    if (body.length < offset + 6) return null;
    const mac = body.slice(offset, offset + 6);
    return mac.reduce((a, b) => a + b, 0) > 0 ? mac : null;
  };

  // Legacy layout: name=24, mac@64. Newer layout: name=32, mac@72.
  const macOffset = readMacAt(72) ? 72 : 64;
  const macBytes = readMacAt(macOffset);
  if (!macBytes) return null;

  const mac = Array.from(macBytes)
    .map((b) => b.toString(16).toUpperCase().padStart(2, "0"))
    .join(":");

  const verSlice = body.slice(0, 24);
  const verNull = verSlice.indexOf(0);
  const version = verSlice
    .slice(0, verNull === -1 ? 24 : verNull)
    .toString("ascii")
    .trim();

  const nameSlice = body.slice(32, macOffset);
  const nameNull = nameSlice.indexOf(0);
  const name = nameSlice
    .slice(0, nameNull === -1 ? nameSlice.length : nameNull)
    .toString("ascii")
    .trim();

  // Basic_information struct tail bytes.
  const basicInfoOffset = macOffset + 6;
  const gainMax = body[basicInfoOffset] ?? 0;
  const analogSignalInputChx = body[basicInfoOffset + 1] ?? 0;
  const digitalSignalInputChx = body[basicInfoOffset + 2] ?? 0;
  const outputChx = body[basicInfoOffset + 3] ?? 0;
  const machineState = body[basicInfoOffset + 4] ?? 0;

  const basicInfo: BasicInfoSnapshot = {
    Gain_max: gainMax,
    Analog_signal_Input_chx: analogSignalInputChx,
    Digital_signal_input_chx: digitalSignalInputChx,
    Output_chx: outputChx,
    Machine_state: machineState
  };

  return { ip, mac, name, version, basicInfo };
}

// ---------------------------------------------------------------------------
// AmpController
// ---------------------------------------------------------------------------
class AmpController extends EventEmitter {
  readonly network = new NetworkAdapter();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private discoveryTimer: ReturnType<typeof setInterval> | null = null;

  // Fix #3 — refresh_step counter (mirrors C# refresh_step field)
  // step=0 → idle
  // step=1 → first broadcast sent, window MACs cleared, do NOT mark offline yet
  // step=2 → second broadcast sent, now mark offline
  private refreshStep = 0;

  /** MACs seen in the current discovery window (mirrors refresh_MacList) */
  private currentWindowMacs = new Set<string>();

  /**
   * All known online amps: MAC → { ip, name }.
   * Written by discovery, read by heartbeat loop and judgeOnline.
   */
  private knownMacs = new Map<string, { ip: string; name: string; version: string; basicInfo: BasicInfoSnapshot }>(); // mac → { ip, name, version, basicInfo }

  // Fix #5 — per-amp last-heartbeat timestamp for judgeOnline watchdog
  private lastHeartbeatAt = new Map<string, number>(); // mac → ms timestamp

  /** isRefresh gate (mirrors UDP.isRefresh = false during send()) */
  private isRefresh = true;

  /** Heartbeat tick counter — triggers judgeOnline every 25 ticks */
  private heartbeatCount = 0;

  private running = false;
  private bindingInProgress = false;
  private boundAddress = "0.0.0.0";
  private controlTargetIp: string | null = null;

  private readonly pendingFc27ByIp = new Map<
    string,
    {
      frames: Buffer[];
      timeout: ReturnType<typeof setTimeout>;
      settleTimer: ReturnType<typeof setTimeout> | null;
      resolve: (value: Buffer) => void;
      reject: (error: Error) => void;
    }
  >();
  private readonly fc27QueueByIp = new Map<string, Promise<Buffer>>();

  // Generic one-shot request/response tracking — used for FC codes that
  // CvrAmpDevice previously sent from an ephemeral socket (FC=59, FC=71, etc.).
  // Routing these through the persistent controller socket (port 45454) fixes
  // Dante amps that only respond to the well-known control port.
  private readonly pendingOneShot = new Map<
    string, // key: `${ip}:${fc}`
    {
      frames: Buffer[];
      timeout: ReturnType<typeof setTimeout>;
      settleTimer: ReturnType<typeof setTimeout> | null;
      resolve: (value: Buffer) => void;
      reject: (error: Error) => void;
    }
  >();
  private readonly oneShotQueueByKey = new Map<string, Promise<Buffer>>();
  private readonly pendingSendAckByIp = new Map<
    string,
    {
      timeout: ReturnType<typeof setTimeout>;
      expectedStep: number;
      expectedCount: number;
      expectedLastlen: number;
      resolve: () => void;
      reject: (error: Error) => void;
    }
  >();
  private readonly ioQueueByIp = new Map<string, Promise<void>>();
  private readonly lastFc27ByIp = new Map<string, { body: Buffer; at: number }>();

  /**
   * Cross-subnet support: remembered MAC→IP pairs from discovery responses.
   * These are NOT cleared when an amp goes offline, so the next discovery
   * cycle can unicast-probe the last known IP even across subnets.
   */
  private rememberedIps = new Map<string, string>();

  private readonly bridgePairsByMac = new Map<string, BridgeReadback[]>();
  private bridgePollTick = 0;

  // Promise that resolves once the UDP socket is successfully bound.
  // triggerDiscovery awaits this so it never fires into a null socket.
  private _socketReadyResolve: (() => void) | null = null;
  private _socketReady: Promise<void> = new Promise((res) => (this._socketReadyResolve = res));

  // Pre-built query packets (re-used every tick, immutable)
  private readonly heartbeatPacket = this.network.buildProtocolPacket({
    functionCode: FuncCode.HEARTBEAT,
    statusCode: 2,
    chx: 0
  });
  private readonly discoveryPacket = this.network.buildProtocolPacket({
    functionCode: FuncCode.BASIC_INFO,
    statusCode: 2,
    chx: 0
  });

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  constructor() {
    super();
    this.setMaxListeners(30);
    this.network.on("message", (msg, rinfo) => {
      this._onPacket(msg, rinfo.address);
    });
    this.network.on("error", (err) => {
      this._handleNetworkError(err);
    });
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    // Reset the ready promise for a fresh bind cycle
    this._socketReady = new Promise((res) => (this._socketReadyResolve = res));
    void this._bindAndStart();
  }

  stop(): void {
    this.running = false;
    this._clearTimers();
    void this.network.stop();
  }

  private _handleNetworkError(_err: Error): void {
    if (!this.running) return;

    this._clearTimers();
    void this.network.stop().finally(() => {
      if (!this.running) return;
      setTimeout(() => {
        if (this.running) {
          void this._bindAndStart();
        }
      }, 200);
    });
  }

  /** Pause heartbeat loop during a user command (mirrors isRefresh = false) */
  pauseHeartbeat(): void {
    this.isRefresh = false;
  }
  /** Resume heartbeat loop after a user command (mirrors isRefresh = true) */
  resumeHeartbeat(): void {
    this.isRefresh = true;
  }

  /**
   * Enter focused control mode for one amp (original setSendIP + setIsBroadcast(false)).
   * Heartbeat becomes unicast and periodic discovery timer is paused.
   */
  setControlTargetIp(ip: string | null): void {
    this.controlTargetIp = ip && ip.trim().length > 0 ? ip.trim() : null;

    if (this.controlTargetIp) {
      if (this.discoveryTimer) {
        clearInterval(this.discoveryTimer);
        this.discoveryTimer = null;
      }
      return;
    }

    if (this.running) {
      this._startDiscoveryTimer();
    }
  }

  /**
   * Fire-and-forget command via the shared persistent socket.
   *
   * Uses the same socket that receives heartbeats — no ephemeral port needed.
   * The amp will ACK back (data_state=1) which we already ignore in _onPacket.
   *
   * @param ip         Target amp IP
   * @param fc         Function code (e.g. FuncCode.MUTE = 10)
   * @param chx        Channel index 0–3
   * @param body       Command payload bytes
   * @param inOutFlag  StructHeader byte 5: 0=input, 1=output (default 0)
   */
  sendCommand(ip: string, fc: number, chx: number, body: Buffer, inOutFlag = 0): void {
    if (!this.network.isStarted) return;
    try {
      const packet = this.network.buildProtocolPacket({
        functionCode: fc,
        statusCode: 3,
        chx,
        body,
        segment: 0,
        link: 0,
        inOutFlag
      });
      void this.network.sendRaw_shouldBeReplacedWithSendPacket(packet, 0, packet.length, ip, false).catch(() => {});
    } catch {
      // Silently ignore send failures
    }
  }

  /** Returns the last known IP for a given MAC, or null if not yet discovered. */
  getIpForMac(mac: string): string | null {
    for (const [m, entry] of this.knownMacs) {
      if (m.toUpperCase() === mac.toUpperCase()) return entry.ip;
    }
    return null;
  }

  /** Authoritative output channel count (Output_chx from FC=0 discovery), or
   *  undefined if the amp isn't discovered. Needed to parse FC=27 trailer fields
   *  (e.g. muteIn) correctly — the trailer size varies by firmware, so the count
   *  must not be derived from the payload length. */
  getChannelCountForMac(mac: string): number | undefined {
    for (const [m, entry] of this.knownMacs) {
      if (m.toUpperCase() === mac.toUpperCase()) {
        const n = entry.basicInfo?.Output_chx;
        return typeof n === "number" && n > 0 ? n : undefined;
      }
    }
    return undefined;
  }

  /** Returns the MAC and name for a given IP, or null if not yet discovered. */
  getMacForIp(ip: string): { mac: string; name: string } | null {
    for (const [mac, entry] of this.knownMacs) {
      if (entry.ip === ip) return { mac, name: entry.name };
    }
    return null;
  }

  /** Last successful FC=27 payload for this amp, if available. */
  getLastFC27(mac: string): { body: Buffer; at: number } | null {
    const ip = this.getIpForMac(mac);
    if (!ip) return null;
    const hit = this.lastFc27ByIp.get(ip);
    return hit ? { body: Buffer.from(hit.body), at: hit.at } : null;
  }

  /**
   * Seed an IP into rememberedIps for cross-subnet discovery.
   * Also sends an immediate probe if socket is ready, or schedules one for shortly after.
   */
  seedIp(ip: string): void {
    this.rememberedIps.set(`__seed__${ip}`, ip);
    // Send an immediate probe if socket is ready, otherwise retry after 500ms
    const sendProbe = () => {
      if (this.network.isStarted) {
        void this.network
          .sendRaw_shouldBeReplacedWithSendPacket(this.discoveryPacket, 0, this.discoveryPacket.length, ip, false)
          .catch(() => {});
      }
    };
    sendProbe();
    setTimeout(sendProbe, 500);
    setTimeout(sendProbe, 1500);
  }

  /**
   * Seed a specific IP for cross-subnet discovery and immediately probe it.
   * Used when the user manually enters an IP for an unreachable amp.
   * Sends multiple probes to handle UDP packet loss.
   */
  probeIp(ip: string): void {
    // Store with a placeholder key so it survives in rememberedIps
    this.rememberedIps.set(`__probe__${ip}`, ip);

    // Send multiple unicast FC=0 discovery probes to handle UDP packet loss
    if (this.network.isStarted) {
      const sendProbe = () => {
        void this.network
          .sendRaw_shouldBeReplacedWithSendPacket(this.discoveryPacket, 0, this.discoveryPacket.length, ip, false)
          .catch(() => {});
      };

      // Send 5 probes with 200ms interval to maximize chance of delivery
      sendProbe();
      setTimeout(sendProbe, 200);
      setTimeout(sendProbe, 400);
      setTimeout(sendProbe, 600);
      setTimeout(sendProbe, 800);
    } else {
      // Socket not ready
    }
  }

  /**
   * Request FC=27 (Synchronous_data) from a specific amp/channel.
   * Handles multi-frame responses by accumulating all fragments.
   * Returns the complete body buffer (may be >437 bytes).
   * Times out after 5 seconds if no response.
   */
  public async requestFC27(mac: string, channel: number): Promise<Buffer> {
    await this._socketReady;

    const ip = this.getIpForMac(mac);
    if (!ip) {
      throw new Error(`Amp ${mac} not found or not yet discovered`);
    }

    if (!this.network.isStarted) {
      throw new Error("Socket not initialized");
    }

    return this._runIpSerial(ip, async () => {
      const timeoutMs = 2000;

      const previous = this.fc27QueueByIp.get(ip) ?? Promise.resolve(Buffer.alloc(0));
      const queued = previous.catch(() => Buffer.alloc(0)).then(() => this._sendAndAwaitFC27(ip, channel, timeoutMs));

      this.fc27QueueByIp.set(ip, queued);

      return queued
        .then((buf) => {
          this.lastFc27ByIp.set(ip, { body: Buffer.from(buf), at: Date.now() });
          return buf;
        })
        .catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          const isTimeout = msg.toLowerCase().includes("timed out");
          if (!isTimeout) {
            throw err;
          }

          // Touring hardening: one immediate retry for transient post-apply gaps.
          return this._sendAndAwaitFC27(ip, channel, 2200)
            .then((retryBuf) => {
              this.lastFc27ByIp.set(ip, { body: Buffer.from(retryBuf), at: Date.now() });
              return retryBuf;
            })
            .catch((retryErr) => {
              throw retryErr;
            });
        })
        .finally(() => {
          if (this.fc27QueueByIp.get(ip) === queued) {
            this.fc27QueueByIp.delete(ip);
          }
        });
    });
  }

  /**
   * Generic request/response via the persistent socket (port 45454).
   *
   * Unlike CvrAmpDevice (ephemeral port), this routes through the same socket
   * that handles heartbeats and channel-data — with proper ACK handling.
   * This fixes Dante amps that only respond to the well-known control port.
   *
   * @param mac        Target device MAC
   * @param fc         Function code (e.g. 59 = SAVE_RECALL, 71 = SN_TABLE)
   * @param chx        Channel index
   * @param body       Request body payload
   * @param inOutFlag  0 = input, 1 = output
   * @param timeoutMs  How long to wait for a response (default 2000ms)
   */
  public async requestFC(
    mac: string,
    fc: number,
    chx = 0,
    body: Buffer = Buffer.alloc(0),
    inOutFlag = 0,
    timeoutMs = 2000
  ): Promise<Buffer> {
    await this._socketReady;

    const ip = this.getIpForMac(mac);
    if (!ip) {
      throw new Error(`Amp ${mac} not found or not yet discovered`);
    }

    if (!this.network.isStarted) {
      throw new Error("Socket not initialized");
    }

    return this._runIpSerial(ip, async () => {
      const key = `${ip}:${fc}`;
      const previous = this.oneShotQueueByKey.get(key) ?? Promise.resolve(Buffer.alloc(0));
      const queued = previous
        .catch(() => Buffer.alloc(0))
        .then(() => this._sendAndAwaitOneShot(ip, fc, chx, body, inOutFlag, timeoutMs));

      this.oneShotQueueByKey.set(key, queued);

      return queued
        .then((buf) => buf)
        .catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          const isTimeout = msg.toLowerCase().includes("timed out");
          if (!isTimeout) {
            throw err;
          }

          // Deterministic transport hardening: one immediate retry for transient
          // post-write response gaps observed on FC=59/FC=17/FC=15.
          const retryTimeoutMs = Math.max(timeoutMs, 2200);

          return this._sendAndAwaitOneShot(ip, fc, chx, body, inOutFlag, retryTimeoutMs)
            .then((retryBuf) => retryBuf)
            .catch((retryErr) => {
              throw retryErr;
            });
        })
        .finally(() => {
          if (this.oneShotQueueByKey.get(key) === queued) {
            this.oneShotQueueByKey.delete(key);
          }
        });
    });
  }

  /**
   * Fire-and-forget send via the persistent socket with application-level
   * fragmentation (450-byte chunks), matching the C# UDP.SendStruct() pattern.
   *
   * Unlike `requestFC`, this does NOT wait for a response — it just pushes
   * the fragmented payload and returns.  Used for large write commands like
   * FC=57 speaker data inject where the device doesn't send a meaningful
   * response body.
   *
   * @param mac        Target device MAC
   * @param fc         Function code
   * @param chx        Channel index
   * @param body       Payload bytes
   * @param inOutFlag  0=input, 1=output
   * @param link       Link field (e.g. channel bitmask for FC=57 paste)
   * @param statusCode Status code (0=Response/inject, 1=write, 2=request)
   * @param interFragmentMs  Retained for API compatibility; fragment pacing is ACK-driven.
   */
  public async sendFC(
    mac: string,
    fc: number,
    chx = 0,
    body: Buffer = Buffer.alloc(0),
    inOutFlag = 0,
    link = 0,
    statusCode = 1,
    interFragmentMs = 5
  ): Promise<SendFCResult> {
    await this._socketReady;

    const ip = this.getIpForMac(mac);
    if (!ip) {
      throw new Error(`Amp ${mac} not found or not yet discovered`);
    }

    if (!this.network.isStarted) {
      throw new Error("Socket not initialized");
    }

    return this._runIpSerial(ip, async () => {
      // Build the inner frame: structHeader + body + checkCode
      const structHeader = buildStructHeader({ functionCode: fc, statusCode, chx, link, inOutFlag });
      const inner = Buffer.concat([structHeader, body]);
      const frame = Buffer.concat([inner, calcCheckCode(inner)]);

      // Fragment at application level (450-byte chunks) matching C# UDP.cs behaviour.
      const packetsCount = frame.length <= FRAGMENT_SIZE ? 1 : Math.ceil(frame.length / FRAGMENT_SIZE);
      const packetsLastlen = frame.length % FRAGMENT_SIZE === 0 ? FRAGMENT_SIZE : frame.length % FRAGMENT_SIZE;

      if (packetsCount > MAX_PACKETS_COUNT) {
        throw new Error(
          `Payload too large for one protocol transfer: frame=${frame.length} bytes requires ${packetsCount} packets, max is ${MAX_PACKETS_COUNT}`
        );
      }

      const previousRefresh = this.isRefresh;
      this.isRefresh = false;

      try {
        const maxFrameAttempts = 3;
        let fragmentRetries = 0;

        for (let frameAttempt = 1; frameAttempt <= maxFrameAttempts; frameAttempt++) {
          try {
            for (let step = 1; step <= packetsCount; step++) {
              const chunkStart = (step - 1) * FRAGMENT_SIZE;
              const chunkLen = step === packetsCount ? packetsLastlen : FRAGMENT_SIZE;
              const chunk = frame.slice(chunkStart, chunkStart + chunkLen);

              const networkHeader = buildNetworkDataHeader({
                frameLen: packetsLastlen,
                machineMode: 0,
                dataState: 0,
                packetsCount,
                packetsStep: step
              });

              const packet = Buffer.concat([networkHeader, chunk]);
              const ackAttempts = await this._sendPacketAwaitAck(ip, packet, step, packetsCount, packetsLastlen);
              fragmentRetries += Math.max(0, ackAttempts - 1);

              // Match original sender pacing: even with ACK-driven flow, keep a
              // small fixed gap between fragments to avoid overrunning DSP reassembly.
              if (step < packetsCount && interFragmentMs > 0) {
                await new Promise<void>((resolve) => setTimeout(resolve, interFragmentMs));
              }
            }
            return { frameAttempts: frameAttempt, fragmentRetries };
          } catch (err) {
            if (frameAttempt >= maxFrameAttempts) {
              throw err;
            }

            // Brief cool-down before replaying the whole frame from step 1.
            await new Promise<void>((resolve) => setTimeout(resolve, 120));
          }
        }

        throw new Error("sendFC exhausted frame attempts without completion");
      } finally {
        this.isRefresh = previousRefresh;
      }
      return { frameAttempts: 1, fragmentRetries: 0 };
    });
  }

  // -------------------------------------------------------------------------
  // Socket bootstrap — bind to 0.0.0.0 so all NICs are covered
  // -------------------------------------------------------------------------
  private async _bindAndStart(): Promise<void> {
    if (this.bindingInProgress || !this.running) return;
    this.bindingInProgress = true;
    this._clearTimers();

    try {
      // Always bind to 0.0.0.0:
      //   - Receives UDP from every interface (WiFi, Ethernet, etc.)
      //   - Unicast sends are routed by the kernel per destination (correct NIC chosen automatically)
      //   - Directed broadcasts sent to each subnet's broadcast address reach the right NIC
      // Binding to a specific NIC IP (the old per-candidate loop) locked the socket to
      // one adapter, breaking amps on any other subnet — especially strict on macOS.
      try {
        await this.network.start("0.0.0.0");
      } catch {
        return;
      }

      if (!this.running) return;
      this.boundAddress = "0.0.0.0";

      // Resolve the ready promise so triggerDiscovery() can proceed
      this._socketReadyResolve?.();
      this._socketReadyResolve = null;

      this._startHeartbeatLoop();
      this._startDiscoveryTimer();
    } finally {
      this.bindingInProgress = false;
    }
  }

  private _onPacket(raw: Buffer, ip: string): void {
    const nd = this.network.parseNetworkData(raw);
    if (!nd) return;

    if (nd.dataState === 1) {
      const pendingAck = this.pendingSendAckByIp.get(ip);
      if (pendingAck) {
        const strictMatch =
          nd.packetsStep === pendingAck.expectedStep &&
          nd.packetsCount === pendingAck.expectedCount &&
          nd.packetsLastlen === pendingAck.expectedLastlen;

        // Some amps ACK every fragment with a generic 1/1/0 tuple.
        const genericMatch = nd.packetsStep === 1 && nd.packetsCount === 1 && nd.packetsLastlen === 0;

        // A header-only packet (no struct/body) with data_state=1 is a pure ACK.
        // Firmware versions fill packetsCount/packetsLastlen inconsistently — FW
        // 1.1.8 sends 1/0, FW 1.1.9 sends 0/450 — so those fields cannot be used
        // to correlate. Since fragments are sent strictly sequentially (only one
        // in flight while a pendingAck exists), any header-only ACK from this IP
        // acknowledges the current fragment. This unblocks FC=57 speaker-data
        // apply on 1.1.9 (previously "ACK timed out" -> speaker preset apply failed).
        const headerOnlyAck = raw.length === NETWORK_HEADER_LEN;

        if (strictMatch || genericMatch || headerOnlyAck) {
          this.pendingSendAckByIp.delete(ip);
          clearTimeout(pendingAck.timeout);
          pendingAck.resolve();
        }
      }
      return;
    }

    // --- Step 2: ACK back to sender (Fix #1) ---
    // mirrors: networkData.data_state = 1; UDP_Receive.Send(SendData, ..., ACK_IP)
    // We echo the NetworkData header with data_state=1, no body.
    this._sendAck(ip, raw);

    const assembled = this.network.pushFragment(ip, raw);
    if (!assembled) {
      return;
    }

    const decoded = this.network.decodeAssembled(assembled);
    if (!decoded) {
      return;
    }

    this._dispatchFC(decoded.functionCode, decoded.body, ip, nd.machineMode, decoded.rawAssembled);
  }

  // -------------------------------------------------------------------------
  // Fix #1 — ACK sender (mirrors setReceiveData: data_state=1, send back)
  // The device expects exactly the original NetworkData header echoed back
  // with data_state flipped to 1 as the handshake acknowledgement.
  // -------------------------------------------------------------------------
  private _sendAck(ip: string, originalPacket: Buffer): void {
    const ack = this.network.buildAck(originalPacket);
    if (!ack) return;
    void this.network.sendRaw_shouldBeReplacedWithSendPacket(ack, 0, ack.length, ip, false).catch(() => {
      /* ignore */
    });
  }

  // -------------------------------------------------------------------------
  // Dispatch assembled, validated frame by function_code
  // (mirrors NoClientDataSet / ClientDataSet switch in the original)
  // -------------------------------------------------------------------------
  private _dispatchFC(fc: number, body: Buffer, ip: string, machineMode: number, rawAssembled: Buffer): void {
    switch (fc) {
      // FC=0 BASIC_INFO — device replied to our discovery broadcast
      case FuncCode.BASIC_INFO: {
        // parseDiscoveryPacket needs the full raw packet with NetworkData header
        // re-prepend a synthetic NetworkData so offsets are correct
        const withNd = prependNetworkHeaderToAssembled(rawAssembled, machineMode);
        const event = parseDiscoveryPacket(withNd, ip);
        if (!event) return;

        this.currentWindowMacs.add(event.mac);
        this.knownMacs.set(event.mac, {
          ip,
          name: event.name,
          version: event.version,
          basicInfo: event.basicInfo
        });

        // Remember MAC→IP for cross-subnet unicast probing (survives offline)
        this.rememberedIps.set(event.mac, ip);

        this.emit("discovery", event satisfies DiscoveryEvent);
        break;
      }

      // FC=6 HEARTBEAT — device replied to our heartbeat unicast
      case FuncCode.HEARTBEAT: {
        // Reconstruct the full raw packet for parseHeartbeat (expects NetworkData prefix)
        const withNd = prependNetworkHeaderToAssembled(rawAssembled, machineMode);

        const mac = this._macFromIp(ip);
        if (!mac) {
          // IP not yet in knownMacs — trigger a discovery cycle to learn it
          this._sendDiscovery();
          return;
        }

        const heartbeat = parseHeartbeat(withNd);
        if (!heartbeat) return;

        // Fix #5 — update per-amp last-seen timestamp
        this.lastHeartbeatAt.set(mac, Date.now());

        const known = this.knownMacs.get(mac);
        this.emit("heartbeat", {
          ip,
          mac,
          name: known?.name ?? "",
          version: known?.version ?? "",
          heartbeat,
          bridgePairs: this.bridgePairsByMac.get(mac)
        } satisfies HeartbeatEvent);
        break;
      }

      case FuncCode.BRIDGE: {
        const mac = this._macFromIp(ip);
        if (!mac) break;

        const pair = rawAssembled[3];
        if (pair !== 0 && pair !== 1) break;

        const raw = body.length > 0 ? body[0] : null;
        const current = this.bridgePairsByMac.get(mac) ?? [
          { pair: 0, raw: null, bridged: null },
          { pair: 1, raw: null, bridged: null }
        ];

        const next = current.map((entry) =>
          entry.pair === pair
            ? {
                pair: entry.pair,
                raw,
                bridged: raw === null ? null : raw === 0
              }
            : entry
        );

        this.bridgePairsByMac.set(mac, next);
        break;
      }

      case FuncCode.SYNC_DATA: {
        const pending = this.pendingFc27ByIp.get(ip);
        if (!pending) break;

        pending.frames.push(Buffer.from(body));
        if (pending.settleTimer) {
          clearTimeout(pending.settleTimer);
        }

        pending.settleTimer = setTimeout(() => {
          if (pending.settleTimer) clearTimeout(pending.settleTimer);
          clearTimeout(pending.timeout);
          this.pendingFc27ByIp.delete(ip);
          pending.resolve(Buffer.concat(pending.frames));
        }, 20);
        break;
      }

      default: {
        // Check for pending one-shot requests (FC=59 presets, FC=71 runtime, etc.)
        const key = `${ip}:${fc}`;
        const pending = this.pendingOneShot.get(key);
        if (pending) {
          pending.frames.push(Buffer.from(body));
          if (pending.settleTimer) clearTimeout(pending.settleTimer);
          pending.settleTimer = setTimeout(() => {
            if (pending.settleTimer) clearTimeout(pending.settleTimer);
            clearTimeout(pending.timeout);
            this.pendingOneShot.delete(key);
            pending.resolve(Buffer.concat(pending.frames));
          }, 20);
        }
        break;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Refresh_Thread — queryT_V_A() equivalent
  //
  // Broadcast a single FC=6 heartbeat packet every 140ms.
  // All discovered amps reply simultaneously — poll rate is always 140ms
  // regardless of how many amps are on the network (2–20+).
  // -------------------------------------------------------------------------
  private _startHeartbeatLoop(): void {
    if (this.heartbeatTimer) return;

    this.heartbeatTimer = setInterval(() => {
      if (!this.network.isStarted || !this.isRefresh) {
        this.heartbeatCount = 0;
        return;
      }

      if (this.controlTargetIp) {
        // Focused control mode: unicast heartbeat to selected amp.
        void this.network
          .sendRaw_shouldBeReplacedWithSendPacket(
            this.heartbeatPacket,
            0,
            this.heartbeatPacket.length,
            this.controlTargetIp,
            false
          )
          .catch(() => {
            /* ignore */
          });
      } else {
        // Default mode: broadcast heartbeat to all amps.
        void this.network
          .sendRaw_shouldBeReplacedWithSendPacket(
            this.heartbeatPacket,
            0,
            this.heartbeatPacket.length,
            BROADCAST_ADDR,
            true
          )
          .catch(() => {
            /* ignore */
          });

        // Cross-subnet: unicast heartbeat to all remembered IPs
        // (broadcast doesn't cross subnet boundaries)
        for (const [, ip] of this.rememberedIps) {
          void this.network
            .sendRaw_shouldBeReplacedWithSendPacket(this.heartbeatPacket, 0, this.heartbeatPacket.length, ip, false)
            .catch(() => {
              /* ignore */
            });
        }
      }

      this.heartbeatCount++;
      this.bridgePollTick++;

      // Every 25 ticks (~3.5 s) — run the connection watchdog
      if (this.heartbeatCount >= 25) {
        this.heartbeatCount = 0;
        this._judgeOnline();
      }

      if (this.bridgePollTick >= 5) {
        this.bridgePollTick = 0;
        this._pollBridgePairs();
      }
    }, HEARTBEAT_MS);
  }

  // -------------------------------------------------------------------------
  // TimerRefresh — refrash() timer + two-cycle offline detection (Fix #3)
  //
  // Original C# refresh_step logic:
  //   step++ → if step==1: clear list   → broadcast → sleep 1s → don't mark offline
  //   step++ → if step==2: don't clear  → broadcast → sleep 1s → DO mark offline → step=0
  //
  // For multi-amp: we check ALL knownMacs against currentWindowMacs.
  // -------------------------------------------------------------------------
  private _startDiscoveryTimer(): void {
    if (this.discoveryTimer) return;

    this.discoveryTimer = setInterval(() => {
      if (!this.isRefresh) return;
      this._runDiscoveryCycle();
    }, DISCOVERY_MS);
  }

  private _runDiscoveryCycle(): void {
    this.refreshStep++;

    if (this.refreshStep === 1) {
      // First pass: clear the window list so we start fresh
      // (mirrors: if (refresh_step == 1) refresh_MacList.Clear())
      this.currentWindowMacs.clear();
    }

    // Broadcast and wait the discovery window
    this._sendDiscovery();

    setTimeout(() => {
      if (this.refreshStep < 2) {
        // First pass done — do not mark offline yet (grace period)
        return;
      }

      // Second pass: any knownMac that did not appear in either window is offline
      this.refreshStep = 0;

      this.knownMacs.forEach((_, mac) => {
        if (!this.currentWindowMacs.has(mac)) {
          this.knownMacs.delete(mac);
          this.lastHeartbeatAt.delete(mac);
          this.bridgePairsByMac.delete(mac);
          this.emit("offline", { mac } satisfies OfflineEvent);
        }
      });
    }, DISCOVERY_WINDOW_MS);
  }

  private async _sendDiscovery(): Promise<void> {
    if (!this.network.isStarted) return;

    // Cross-subnet: unicast FC=0 probes to all remembered IPs (survives offline)
    for (const [, ip] of this.rememberedIps) {
      void this.network
        .sendRaw_shouldBeReplacedWithSendPacket(this.discoveryPacket, 0, this.discoveryPacket.length, ip, false)
        .catch(() => {
          /* ignore — target may be unreachable */
        });
    }

    // Standard subnet broadcast
    for (const target of await getDirectedBroadcasts()) {
      void this.network
        .sendRaw_shouldBeReplacedWithSendPacket(this.discoveryPacket, 0, this.discoveryPacket.length, target, true)
        .catch(() => {});
    }
  }

  // -------------------------------------------------------------------------
  // Fix #5 — judgeOnline(): per-amp heartbeat watchdog
  //
  // Called every 25 heartbeat ticks (~3.5 s).
  // For each known amp: if we haven't received a heartbeat from it within
  // HEARTBEAT_TIMEOUT_MS, emit an "offline" event immediately.
  // This catches amps that go silent without missing a discovery broadcast.
  // -------------------------------------------------------------------------
  private _judgeOnline(): void {
    const now = Date.now();
    this.knownMacs.forEach((_, mac) => {
      const last = this.lastHeartbeatAt.get(mac);
      if (last !== undefined && now - last > HEARTBEAT_TIMEOUT_MS) {
        this.knownMacs.delete(mac);
        this.lastHeartbeatAt.delete(mac);
        this.currentWindowMacs.delete(mac);
        this.bridgePairsByMac.delete(mac);
        this.emit("offline", { mac } satisfies OfflineEvent);
      }
    });
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------
  private _macFromIp(ip: string): string | null {
    for (const [mac, entry] of this.knownMacs) {
      if (entry.ip === ip) return mac;
    }
    return null;
  }

  private _pollBridgePairs(): void {
    if (!this.network.isStarted || !this.isRefresh) return;

    const targetIps = this.controlTargetIp
      ? [this.controlTargetIp]
      : Array.from(this.knownMacs.values()).map((entry) => entry.ip);

    for (const ip of targetIps) {
      for (const pair of [0, 1] as const) {
        const packet = this.network.buildProtocolPacket({
          functionCode: FuncCode.BRIDGE,
          statusCode: 2,
          chx: pair
        });

        void this.network.sendRaw_shouldBeReplacedWithSendPacket(packet, 0, packet.length, ip, false).catch(() => {
          /* ignore */
        });
      }
    }
  }

  private _sendAndAwaitFC27(ip: string, channel: number, timeoutMs: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const timeout = setTimeout(() => {
        const pending = this.pendingFc27ByIp.get(ip);
        if (pending) {
          if (pending.settleTimer) clearTimeout(pending.settleTimer);
          this.pendingFc27ByIp.delete(ip);
        }
        reject(new Error(`FC=27 request for ${ip}:${channel} timed out`));
      }, timeoutMs);

      this.pendingFc27ByIp.set(ip, {
        frames: [],
        timeout,
        settleTimer: null,
        resolve,
        reject
      });

      const packet = this.network.buildProtocolPacket({
        functionCode: FuncCode.SYNC_DATA,
        statusCode: 2,
        chx: channel
      });

      void this.network.sendRaw_shouldBeReplacedWithSendPacket(packet, 0, packet.length, ip, false).catch((err) => {
        const pending = this.pendingFc27ByIp.get(ip);
        if (pending) {
          clearTimeout(pending.timeout);
          if (pending.settleTimer) clearTimeout(pending.settleTimer);
          this.pendingFc27ByIp.delete(ip);
        }
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  private _sendAndAwaitOneShot(
    ip: string,
    fc: number,
    chx: number,
    body: Buffer,
    inOutFlag: number,
    timeoutMs: number
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const key = `${ip}:${fc}`;

      const timeout = setTimeout(() => {
        const pending = this.pendingOneShot.get(key);
        if (pending) {
          if (pending.settleTimer) clearTimeout(pending.settleTimer);
          this.pendingOneShot.delete(key);
        }
        reject(new Error(`FC=${fc} request for ${ip} timed out`));
      }, timeoutMs);

      this.pendingOneShot.set(key, {
        frames: [],
        timeout,
        settleTimer: null,
        resolve,
        reject
      });

      const packet = this.network.buildProtocolPacket({
        functionCode: fc,
        statusCode: 2,
        chx,
        body,
        inOutFlag
      });

      void this.network.sendRaw_shouldBeReplacedWithSendPacket(packet, 0, packet.length, ip, false).catch((err) => {
        const pending = this.pendingOneShot.get(key);
        if (pending) {
          clearTimeout(pending.timeout);
          if (pending.settleTimer) clearTimeout(pending.settleTimer);
          this.pendingOneShot.delete(key);
        }
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  private async _sendPacketAwaitAck(
    ip: string,
    packet: Buffer,
    step: number,
    totalPackets: number,
    packetsLastlen: number
  ): Promise<number> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const ackPromise = new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            if (this.pendingSendAckByIp.get(ip)?.timeout === timeout) {
              this.pendingSendAckByIp.delete(ip);
            }
            reject(new Error(`ACK timed out for ${ip} step=${step} attempt=${attempt}`));
          }, 1000);

          this.pendingSendAckByIp.set(ip, {
            timeout,
            expectedStep: step,
            expectedCount: totalPackets,
            expectedLastlen: packetsLastlen,
            resolve: () => {
              clearTimeout(timeout);
              resolve();
            },
            reject: (error) => {
              clearTimeout(timeout);
              reject(error);
            }
          });
        });

        await this.network.sendRaw_shouldBeReplacedWithSendPacket(packet, 0, packet.length, ip, false);
        await ackPromise;
        return attempt;
      } catch (err) {
        const pendingAck = this.pendingSendAckByIp.get(ip);
        if (pendingAck) {
          clearTimeout(pendingAck.timeout);
          this.pendingSendAckByIp.delete(ip);
        }
        lastError = err instanceof Error ? err : new Error(String(err));
      }
    }

    throw lastError ?? new Error(`ACK failed for ${ip} step=${step}`);
  }

  private async _runIpSerial<T>(ip: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.ioQueueByIp.get(ip) ?? Promise.resolve();

    let release: () => void = () => {};
    const marker = new Promise<void>((resolve) => {
      release = resolve;
    });

    this.ioQueueByIp.set(
      ip,
      previous
        .catch(() => {
          // ignore previous errors, keep queue progressing
        })
        .then(() => marker)
    );

    try {
      await previous.catch(() => {
        // ignore previous errors, current operation should still run
      });
      return await operation();
    } finally {
      release();
      if (this.ioQueueByIp.get(ip) === marker) {
        this.ioQueueByIp.delete(ip);
      }
    }
  }

  /**
   * Public API for on-demand discovery (used by /api/scan route).
   *
   * Sends a broadcast FC=0 using the already-bound socket and collects
   * all "discovery" events received within `windowMs` milliseconds.
   * This avoids creating a second socket on port 45454.
   */
  public async triggerDiscovery(windowMs = 500): Promise<DiscoveryEvent[]> {
    // Wait for the socket to be bound before sending anything
    await this._socketReady;

    return new Promise((resolve) => {
      const found: Map<string, DiscoveryEvent> = new Map();

      const listener = (event: DiscoveryEvent) => {
        found.set(event.mac, event);
      };

      this.on("discovery", listener);
      this._sendDiscovery();

      setTimeout(() => {
        this.off("discovery", listener);
        resolve(Array.from(found.values()));
      }, windowMs);
    });
  }

  private _clearTimers(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.discoveryTimer) {
      clearInterval(this.discoveryTimer);
      this.discoveryTimer = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------
// Attached to globalThis so Next.js HMR hot reloads do not spawn a second
// socket — the same instance survives module re-evaluation.
declare global {
  var __ampController: AmpController | undefined;
}

if (!globalThis.__ampController) {
  globalThis.__ampController = new AmpController();
}

export const ampController: AmpController = globalThis.__ampController;

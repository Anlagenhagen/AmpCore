#!/usr/bin/env node
// Faithful standalone sender for CVR amp control commands.
// Mirrors lib/network/protocol.ts + CvrAmpDevice.sendControl EXACTLY so we send
// the same bytes AmpCore sends — no guessing at real hardware.
//
// Modes:
//   node scripts/send-control.mjs send --ip 192.168.20.73 --cmd standby-on
//   node scripts/send-control.mjs send --ip 192.168.20.73 --fc 10 --chx 0 --body 00 --inout 1
//   node scripts/send-control.mjs seq-standby --a 192.168.20.73 --b 192.168.20.203
//
// Named safe commands (--cmd): standby-on, standby-off,
//   muteout-on/off, mutein-on/off (need --chx).
import dgram from "dgram";
import os from "os";

const AMP_SEND_PORT = 45455;
const NETWORK_DATA_FLAG = 0xd903;
const FRAGMENT_SIZE = 450;

function getLocalAddressFor(targetIp) {
  const t = targetIp.split(".").map(Number);
  for (const iface of Object.values(os.networkInterfaces())) {
    for (const a of iface || []) {
      if (a.family !== "IPv4" || a.internal) continue;
      const l = a.address.split(".").map(Number);
      const m = a.netmask.split(".").map(Number);
      if (l.every((b, i) => (b & m[i]) === (t[i] & m[i]))) return a.address;
    }
  }
  return "0.0.0.0";
}

function buildStructHeader({ functionCode, statusCode = 1, chx = 0, segment = 0, link = 0, inOutFlag = 0 }) {
  const b = Buffer.alloc(10);
  b[0] = 0x55; b[1] = functionCode; b[2] = statusCode; b[3] = chx; b[4] = segment;
  b.writeInt32LE(link, 5); b[9] = inOutFlag;
  return b;
}
function calcCheckCode(inner) {
  const num = inner.length + 3;
  const hi = (num >> 8) & 0xff, lo = num & 0xff;
  let sum = hi + lo;
  for (const x of inner) sum += x;
  return Buffer.from([hi, lo, sum & 0xff]);
}
function buildNetworkDataHeader(frameLen, { packetsCount = 1, packetsStep = 1 } = {}) {
  const b = Buffer.alloc(10);
  b.writeUInt16LE(NETWORK_DATA_FLAG, 0);
  b.writeInt16LE(0, 2);        // machineMode = 0 for control
  b[4] = packetsCount;
  b.writeUInt16LE(frameLen, 5);
  b[7] = packetsStep;
  b[8] = 0;                    // dataState
  b[9] = 0;
  return b;
}
function buildPacket(fields) {
  const inner = Buffer.concat([buildStructHeader(fields), fields.body ?? Buffer.alloc(0)]);
  const frame = Buffer.concat([inner, calcCheckCode(inner)]);
  if (frame.length > FRAGMENT_SIZE) throw new Error("multi-fragment not supported in this helper");
  return Buffer.concat([buildNetworkDataHeader(frame.length), frame]);
}

function sendOnce(ip, fields) {
  const packet = buildPacket(fields);
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket("udp4");
    sock.bind({ port: 0, address: getLocalAddressFor(ip) }, () => {
      sock.send(packet, 0, packet.length, AMP_SEND_PORT, ip, (err) => {
        const ts = new Date().toISOString();
        console.log(`${ts}  -> ${ip}:${AMP_SEND_PORT}  fc=${fields.functionCode} chx=${fields.chx ?? 0} inout=${fields.inOutFlag ?? 0}  ${packet.toString("hex")}`);
        setTimeout(() => { try { sock.close(); } catch {} err ? reject(err) : resolve(); }, 20);
      });
    });
  });
}

// exact payloads from app/api/amp-actions/route.ts
const CMDS = {
  "standby-on":  (chx) => ({ functionCode: 15, chx: 0, body: Buffer.from([0x01]), inOutFlag: 0, statusCode: 0 }),
  "standby-off": (chx) => ({ functionCode: 15, chx: 0, body: Buffer.from([0x00]), inOutFlag: 0, statusCode: 0 }),
  "muteout-on":  (chx) => ({ functionCode: 10, chx, body: Buffer.from([0x00]), inOutFlag: 1, statusCode: 1 }),
  "muteout-off": (chx) => ({ functionCode: 10, chx, body: Buffer.from([0x01]), inOutFlag: 1, statusCode: 1 }),
  "mutein-on":   (chx) => ({ functionCode: 10, chx, body: Buffer.from([0x00]), inOutFlag: 0, statusCode: 1 }),
  "mutein-off":  (chx) => ({ functionCode: 10, chx, body: Buffer.from([0x01]), inOutFlag: 0, statusCode: 1 }),
};

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const mode = process.argv[2];
  if (mode === "send") {
    const ip = arg("ip"); const cmd = arg("cmd"); const chx = Number(arg("chx", "0"));
    let fields;
    if (cmd) { if (!CMDS[cmd]) throw new Error(`unknown cmd ${cmd}`); fields = CMDS[cmd](chx); }
    else fields = { functionCode: Number(arg("fc")), chx, body: Buffer.from(arg("body", ""), "hex"),
                    inOutFlag: Number(arg("inout", "0")), statusCode: Number(arg("status", "1")),
                    segment: Number(arg("segment", "0")), link: Number(arg("link", "0")) };
    await sendOnce(ip, fields);
  } else if (mode === "seq-standby") {
    // Controlled differential: standby ON->OFF on each amp, spaced so heartbeats
    // capture each state. Print timestamps for pcap alignment.
    const A = arg("a"), B = arg("b");
    const hold = Number(arg("hold", "6000"));
    for (const ip of [A, B].filter(Boolean)) {
      console.log(`# --- ${ip}: standby ON ---`);
      await sendOnce(ip, CMDS["standby-on"]()); await wait(hold);
      console.log(`# --- ${ip}: standby OFF ---`);
      await sendOnce(ip, CMDS["standby-off"]()); await wait(hold);
    }
    console.log("# sequence done");
  } else if (mode === "steps") {
    // Run a JSON list of steps with per-step waits (for RE candidate sweeps).
    // JSON: [{ip,fc,chx,body(hex),inout,status,segment,link,label,waitMs}]
    const { readFileSync } = await import("fs");
    const steps = JSON.parse(readFileSync(arg("file"), "utf8"));
    for (const s of steps) {
      console.log(`# STEP ${s.label ?? ""}`);
      await sendOnce(s.ip, {
        functionCode: s.fc, chx: s.chx ?? 0, body: Buffer.from(s.body ?? "", "hex"),
        inOutFlag: s.inout ?? 0, statusCode: s.status ?? 1,
        segment: s.segment ?? 0, link: s.link ?? 0,
      });
      await wait(s.waitMs ?? 6000);
    }
    console.log("# steps done");
  } else {
    console.log("modes: send | seq-standby | steps");
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

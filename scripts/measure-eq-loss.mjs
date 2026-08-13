#!/usr/bin/env node
// Phase-A measurement for the "EQ copy-paste only partially applies" symptom.
// Applies a full 10-band INPUT eqBlock (fire-and-forget, ~30 FC writes, no ACK)
// with per-round-varying band gains, then reads the amp back (FC=27) and counts
// how many of the 8 parametric bands actually landed. Repeats to get a rate.
//
// Run: node --experimental-strip-types scripts/measure-eq-loss.mjs [iterations]
import { parseFC27Channels } from "../lib/parse-channel-data.ts";

const BASE = "http://localhost:3000";
const AMPS = [["1.1.8", "00:1D:C1:D0:BA:A4"], ["1.1.9", "00:1D:C1:2F:21:82"]];
const CH = 0;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function buildBands(round) {
  const bands = [{ type: 0, gain: 0, freq: 30, q: 1.0, bypass: false }]; // HP
  for (let i = 1; i <= 8; i++) {
    const gain = (((round * 3 + i * 2) % 25) - 12); // distinctive per (round,band), within ±12
    bands.push({ type: 1, gain, freq: i * 1000, q: 1.0, bypass: false });
  }
  bands.push({ type: 4, gain: 0, freq: 18000, q: 1.0, bypass: false }); // LP
  return bands;
}

async function applyEq(mac, bands) {
  const res = await fetch(`${BASE}/api/amp-actions`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mac, action: "eqBlock", channel: CH, target: "input", bands })
  });
  return res.ok;
}
async function readEqIn(mac) {
  const res = await fetch(`${BASE}/api/amp-channel-data?mac=${encodeURIComponent(mac)}`);
  const d = await res.json();
  if (!d.success || !d.hex) return null;
  const chans = parseFC27Channels(d.hex, undefined, 4);
  return chans[CH]?.eqIn ?? null;
}

async function main() {
  const iters = Number(process.argv[2] ?? 12);
  for (const [fw, mac] of AMPS) {
    let full = 0, landedTotal = 0, calib = "";
    for (let r = 0; r < iters; r++) {
      const bands = buildBands(r);
      await applyEq(mac, bands);
      await wait(900); // let the fire-and-forget burst + commit settle
      const eqIn = await readEqIn(mac);
      if (!eqIn) { console.log(`  ${fw}: readback fehlgeschlagen`); continue; }
      if (!calib) calib = `eqIn.length=${eqIn.length}`;
      // parametric band i (1..8): index i when eqIn = [HP, 1..8, LP] (len>=10), else i-1
      let landed = 0;
      const dbg = [];
      for (let i = 1; i <= 8; i++) {
        const want = bands[i].gain;
        const idx = eqIn.length >= 10 ? i : i - 1;
        const got = eqIn[idx]?.gain ?? NaN;
        dbg.push(`b${i}:${want}->${typeof got === "number" ? got.toFixed(1) : got}`);
        if (Math.abs(got - want) < 0.25) landed++;
      }
      if (r === 0) console.log(`   DEBUG ${fw} r0: ${dbg.join("  ")}`);
      landedTotal += landed;
      if (landed === 8) full++;
    }
    console.log(`=== ${fw} (${mac}) [${calib}] ===`);
    console.log(`  Voll übernommen (8/8 Bänder): ${full}/${iters}  (${(100 * full / iters).toFixed(0)}%)`);
    console.log(`  Ø angekommene Bänder je Versuch: ${(landedTotal / iters).toFixed(1)} / 8\n`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

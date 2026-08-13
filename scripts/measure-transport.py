#!/usr/bin/env python3
"""Phase-A transport reliability measurement for AmpCore.

Fires a realistic fragmented write (FC=57 speaker-data, ~2.4 kB → 6 fragments)
repeatedly at each amp via the running app's /api/amp-speaker-data and records
per-send wall time, success, frameAttempts and fragmentRetries (transport meta).
Prints per-amp summary stats so we can quantify "commands not taken / slow /
wrong" before changing anything.

Usage: python3 scripts/measure-transport.py [iterations]
Requires the AmpCore app (or dev server) on http://localhost:3000 and the amps
discovered. Reads the FC=57 blob from the local speaker-library (read-only).
"""
import json, os, sys, time, statistics, urllib.request

BASE = "http://localhost:3000"
AMPS = [("1.1.8 DSP2004D", "00:1D:C1:D0:BA:A4"),
        ("1.1.9 DSP3004D", "00:1D:C1:2F:21:82")]
PROFILE = os.path.expanduser(
    "~/Library/Application Support/ampcore/storage/speaker-library/speaker-profile-5.json")


def load_hex():
    d = json.load(open(PROFILE))
    return d["speaker"]["ways"][0]["deviceData"]["hex"]


def post(path, payload, timeout=15):
    req = urllib.request.Request(BASE + path, data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = json.load(r)
        ok_http = True
    except Exception as e:
        body = {"_error": str(e)}
        ok_http = False
    dt = (time.perf_counter() - t0) * 1000
    return dt, ok_http, body


def pct(xs, p):
    if not xs:
        return 0
    xs = sorted(xs)
    k = min(len(xs) - 1, int(round((p / 100) * (len(xs) - 1))))
    return xs[k]


def main():
    iters = int(sys.argv[1]) if len(sys.argv) > 1 else 20
    hexblob = load_hex()
    print(f"FC=57 blob: {len(hexblob)//2} bytes  |  iterations/amp: {iters}\n")
    for name, mac in AMPS:
        times, retries, attempts, ok = [], [], [], 0
        for i in range(iters):
            dt, ok_http, body = post("/api/amp-speaker-data",
                                     {"mac": mac, "channels": [0], "hex": hexblob, "qos": False})
            r0 = (body.get("results") or [{}])[0]
            sent = bool(r0.get("sent"))
            tr = r0.get("transport") or {}
            if body.get("success") and sent:
                ok += 1
            times.append(dt)
            retries.append(tr.get("fragmentRetries", 0) or 0)
            attempts.append(tr.get("frameAttempts", 0) or 0)
        print(f"=== {name} ({mac}) ===")
        print(f"  Erfolg:       {ok}/{iters}  ({100*ok/iters:.0f}%)")
        print(f"  Wall-Zeit ms: min={min(times):.0f}  median={statistics.median(times):.0f}  "
              f"p90={pct(times,90):.0f}  max={max(times):.0f}")
        print(f"  frameAttempts: {{{','.join(f'{a}:{attempts.count(a)}' for a in sorted(set(attempts)))}}}  "
              f"(1 = ohne Frame-Retry)")
        print(f"  fragmentRetries: gesamt={sum(retries)}  max/send={max(retries)}")
        print()


if __name__ == "__main__":
    main()

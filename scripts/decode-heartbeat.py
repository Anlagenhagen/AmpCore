#!/usr/bin/env python3
"""Decode CVR amp UDP frames from a pcap/pcapng for reverse-engineering.

Per source amp it prints frame-length distribution, FuncCode histogram and a
byte-precise decode of one HEARTBEAT (FuncCode 6) body under both the current
"legacy" and "shifted" layouts from lib/network/heartbeat-parser.ts, plus a raw
float/state dump so real captures can be compared field-by-field.

Usage: python3 scripts/decode-heartbeat.py <capture.pcapng> [--all-heartbeats]
Requires tshark (bundled with Wireshark.app).
"""
import subprocess, sys, struct, collections, os

TSHARK_CANDIDATES = [
    "/Applications/Wireshark.app/Contents/MacOS/tshark",
    "tshark",
]

# Known amps in Hagen's test setup (extend as needed).
AMP_INFO = {
    "192.168.20.203": ("DSP3004D", "1.1.9"),
    "192.168.20.73": ("DSP2004D", "1.1.8"),
}
VALID_STATES = set(range(0, 12))


def tshark_bin():
    for c in TSHARK_CANDIDATES:
        if os.path.sep in c and os.path.exists(c):
            return c
    return "tshark"


def f(b, o):
    return round(struct.unpack_from("<f", b, o)[0], 2) if o + 4 <= len(b) else None


def looks_like_states(body, off, n=4):
    return off + n <= len(body) and all(body[off + i] in VALID_STATES for i in range(n))


def decode_body(body):
    """Mirror parseWhole118Family: report what legacy vs shifted would yield."""
    legacy = looks_like_states(body, 52)
    shifted = looks_like_states(body, 36)
    decision = "SHIFTED" if (shifted and not legacy) else "LEGACY"
    return {
        "bodyLen": len(body),
        "states@36": list(body[36:40]) if len(body) >= 40 else None,
        "states@52": list(body[52:56]) if len(body) >= 56 else None,
        "states@88": list(body[88:92]) if len(body) >= 92 else None,
        "heuristic": decision,
        "legacy_layout": {
            "temps@0": [f(body, 4 * i) for i in range(5)],
            "outV@20": [f(body, 20 + 4 * i) for i in range(4)],
            "outI@36": [f(body, 36 + 4 * i) for i in range(4)],
            "inV@56": [f(body, 56 + 4 * i) for i in range(4)],
            "lim@72": [f(body, 72 + 4 * i) for i in range(4)],
            "fan@92": f(body, 92),
        },
    }


def timeline(pcap):
    """Per amp: collapse consecutive identical HEARTBEAT bodies, print transitions
    with epoch time so control commands can be aligned to state changes."""
    ts = tshark_bin()
    for ip, (model, fw) in AMP_INFO.items():
        rows = subprocess.run(
            [ts, "-r", pcap, "-Y", f"ip.src=={ip} && udp.srcport==45455",
             "-T", "fields", "-e", "frame.time_epoch", "-e", "udp.payload"],
            capture_output=True, text=True).stdout.strip().splitlines()
        print(f"===== {model} FW {fw} ({ip}) — heartbeat transitions =====")
        last = None
        for line in rows:
            if not line or "\t" not in line:
                continue
            t, payload = line.split("\t", 1)
            b = bytes.fromhex(payload.replace(":", ""))
            if len(b) < 12 or b[10] != 0x55 or b[11] != 6:
                continue
            body = b[20:len(b) - 3]
            sig = (list(body[52:56]), list(body[88:92]),
                   [f(body, 4 * i) for i in range(5)],
                   [f(body, 20 + 4 * i) for i in range(4)],   # outV legacy
                   [f(body, 36 + 4 * i) for i in range(4)])    # outI legacy
            if sig != last:
                print(f"  t={float(t):.2f}  states@52={sig[0]} @88={sig[1]} "
                      f"temps={sig[2]} outV@20={sig[3]} outI@36={sig[4]}")
                last = sig
        print()


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    pcap = sys.argv[1]
    if "--timeline" in sys.argv[2:]:
        timeline(pcap)
        return
    all_hb = "--all-heartbeats" in sys.argv[2:]
    ts = tshark_bin()

    for ip, (model, fw) in AMP_INFO.items():
        rows = subprocess.run(
            [ts, "-r", pcap, "-Y", f"ip.src=={ip} && udp.srcport==45455",
             "-T", "fields", "-e", "udp.payload"],
            capture_output=True, text=True).stdout.strip().splitlines()
        if not rows:
            continue
        lens = collections.Counter()
        fcs = collections.Counter()
        hbs = []
        for line in rows:
            if not line:
                continue
            b = bytes.fromhex(line.replace(":", ""))
            lens[len(b)] += 1
            if len(b) >= 12 and b[10] == 0x55:
                fcs[b[11]] += 1
                if b[11] == 6:
                    hbs.append(b)
        print(f"===== {model} FW {fw} ({ip}) — {len(rows)} frames =====")
        print("  frame lengths:", dict(sorted(lens.items())))
        print("  funccodes    :", dict(sorted(fcs.items())))
        seen = set()
        for b in hbs:
            body = b[20:len(b) - 3]
            key = None if all_hb else len(body)
            if not all_hb and key in seen:
                continue
            seen.add(key)
            d = decode_body(body)
            print(f"  HEARTBEAT bodyLen={d['bodyLen']} heuristic={d['heuristic']} "
                  f"states@36={d['states@36']} @52={d['states@52']} @88={d['states@88']}")
            for k, v in d["legacy_layout"].items():
                print(f"      {k:8}: {v}")
            print(f"      raw body: {body.hex()}")
        print()


if __name__ == "__main__":
    main()

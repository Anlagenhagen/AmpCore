#!/usr/bin/env bash
# Capture CVR amp UDP traffic on the Mac (needs Wireshark.app's dumpcap; the
# user must be in group access_bpf so no sudo is required).
#
# Usage: scripts/capture-amps.sh <output.pcapng> [duration_seconds] [interface]
# Example: scripts/capture-amps.sh captures/idle-baseline.pcapng 20 en0
set -euo pipefail

OUT="${1:?output path required}"
DUR="${2:-20}"
IFACE="${3:-en0}"
DUMPCAP="/Applications/Wireshark.app/Contents/MacOS/dumpcap"

mkdir -p "$(dirname "$OUT")"
echo "Capturing ${DUR}s on ${IFACE} (udp ports 45454/45455) -> ${OUT}"
"$DUMPCAP" -i "$IFACE" -a "duration:${DUR}" -f "udp port 45454 or udp port 45455" -w "$OUT"
echo "Done. Decode with: python3 scripts/decode-heartbeat.py \"$OUT\""

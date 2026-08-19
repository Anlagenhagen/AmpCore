import type { EqBand } from "@/stores/AmpStore";

/**
 * Short-lived memory of the EQ block we last asked an amp for.
 *
 * The EQ panel builds the full 10-band block from POLLED amp data, and the
 * "pending" lock after a click only covers the cell that was clicked. Clicking
 * through several bands faster than the poll updates therefore builds every
 * block from a base that still lacks the previous change — and because a block
 * writes all ten bands, the newer block silently reverts the older one.
 *
 * Merging a click onto the last intended block instead of onto stale polled data
 * fixes that. The intent is only trusted while writes for its scope are in
 * flight, plus a short grace period for the poll to catch up; afterwards it is
 * dropped so an EQ change from somewhere else (preset recall, another client)
 * can never be resurrected from a stale intent.
 */

export interface EqScope {
  mac: string;
  channel: number;
  target: string;
}

interface IntentEntry {
  bands: EqBand[];
  /** Number of applies for this scope still awaiting their result. */
  inFlight: number;
  expiry?: ReturnType<typeof setTimeout>;
}

/** How long an intent stays usable after the last apply for it settled. */
const GRACE_MS = 2500;

const intents = new Map<string, IntentEntry>();

function keyOf(scope: EqScope): string {
  return `${scope.mac}|${scope.channel}|${scope.target}`;
}

/** Float compare with a tolerance far below anything the UI can produce. */
function nearlyEqual(a: number, b: number): boolean {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return a === b;
  return Math.abs(a - b) <= 1e-6;
}

export function bandsMatch(a: EqBand | undefined, b: EqBand | undefined): boolean {
  if (!a || !b) return false;
  return (
    a.type === b.type &&
    a.bypass === b.bypass &&
    nearlyEqual(a.freq, b.freq) &&
    nearlyEqual(a.gain, b.gain) &&
    nearlyEqual(a.q, b.q)
  );
}

export function getEqIntent(scope: EqScope): EqBand[] | null {
  return intents.get(keyOf(scope))?.bands ?? null;
}

/** Record what we are about to send and mark one apply as in flight. */
export function beginEqIntent(scope: EqScope, bands: EqBand[]): void {
  const key = keyOf(scope);
  const existing = intents.get(key);
  if (existing?.expiry) clearTimeout(existing.expiry);
  intents.set(key, {
    bands: bands.map((band) => ({ ...band })),
    inFlight: (existing?.inFlight ?? 0) + 1,
    expiry: undefined
  });
}

/** One apply settled. Once none are left, keep the intent only briefly. */
export function endEqIntent(scope: EqScope): void {
  const key = keyOf(scope);
  const entry = intents.get(key);
  if (!entry) return;
  entry.inFlight = Math.max(0, entry.inFlight - 1);
  if (entry.inFlight > 0) return;
  if (entry.expiry) clearTimeout(entry.expiry);
  entry.expiry = setTimeout(() => {
    const current = intents.get(key);
    if (current && current.inFlight === 0) intents.delete(key);
  }, GRACE_MS);
}

/**
 * Merge the bands a click produced onto the last intended block.
 *
 * `requested` is what the component built (polled base + the one band the user
 * just touched); `polled` is the base it built from. Bands that differ between
 * the two are the user's actual edit and are carried over; every other band is
 * taken from the intent, which already holds edits the poll hasn't shown yet.
 *
 * Falls back to `requested` unchanged when there is no usable intent, when
 * nothing differs, or when everything differs (a paste or preset load, where the
 * whole block is meant to replace the current state).
 */
export function mergeWithEqIntent(scope: EqScope, requested: EqBand[], polled: EqBand[] | null): EqBand[] {
  const intent = getEqIntent(scope);
  if (!intent || !polled) return requested;
  if (intent.length !== requested.length || polled.length !== requested.length) return requested;

  const changed: number[] = [];
  for (let idx = 0; idx < requested.length; idx++) {
    if (!bandsMatch(requested[idx], polled[idx])) changed.push(idx);
  }
  if (changed.length === 0) return intent.map((band) => ({ ...band }));
  if (changed.length === requested.length) return requested;

  const merged = intent.map((band) => ({ ...band }));
  for (const idx of changed) merged[idx] = { ...requested[idx] };
  return merged;
}

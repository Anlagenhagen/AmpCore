"use client";

import { useActionPending } from "@/stores/ActionPendingStore";

/**
 * Global loading indicator shown while any amp control action is in flight.
 * Appears the moment a control is clicked and stays until the amp has confirmed
 * the change (the backend reads back before responding), so the user always sees
 * that their click was accepted and is being applied.
 */
export function GlobalActionSpinner() {
  const count = useActionPending((s) => s.count);
  if (count <= 0) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed left-1/2 top-3 z-[200] flex -translate-x-1/2 items-center gap-2 rounded-full border border-border bg-background/95 px-3.5 py-1.5 shadow-lg backdrop-blur"
    >
      <span
        aria-hidden
        className="h-4 w-4 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-foreground"
      />
      <span className="text-sm font-medium text-foreground">Wird übernommen…</span>
    </div>
  );
}

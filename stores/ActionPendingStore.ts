import { create } from "zustand";

/**
 * Tracks how many amp control actions are currently in flight (sent to the amp
 * and awaiting the read-back confirmation). Used to show a loading indicator so
 * the user immediately sees that their click was accepted and is being applied.
 */
interface ActionPendingState {
  count: number;
  begin: () => void;
  end: () => void;
}

export const useActionPending = create<ActionPendingState>((set) => ({
  count: 0,
  begin: () => set((s) => ({ count: s.count + 1 })),
  end: () => set((s) => ({ count: Math.max(0, s.count - 1) }))
}));

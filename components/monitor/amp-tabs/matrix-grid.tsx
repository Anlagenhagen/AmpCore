"use client";

import { useEffect, useState } from "react";
import type { ChannelParams } from "@/stores/AmpStore";
import { useAmpActions } from "@/hooks/useAmpActions";
import { MATRIX_GAIN_MAX_DB, MATRIX_GAIN_MIN_DB } from "@/lib/constants";

function MatrixCell({
  gain,
  active,
  disabled,
  onToggleActive,
  onGainChange
}: {
  gain: number;
  active: boolean;
  disabled?: boolean;
  onToggleActive: () => void;
  onGainChange: (db: number) => void;
}) {
  const [draft, setDraft] = useState(String(gain));

  useEffect(() => {
    setDraft(String(gain));
  }, [gain]);

  const clampGain = (value: number) => Math.max(MATRIX_GAIN_MIN_DB, Math.min(MATRIX_GAIN_MAX_DB, value));

  const commitGain = () => {
    const parsed = Number.parseFloat(draft);
    if (!Number.isNaN(parsed)) {
      const clamped = clampGain(parsed);
      setDraft(String(clamped));
      if (clamped !== gain) onGainChange(clamped);
    } else {
      setDraft(String(gain));
    }
  };

  if (disabled) {
    return (
      <div className="flex w-24 h-14 select-none flex-col items-center justify-center gap-0.5 rounded-md border border-border bg-muted/30 text-xs text-muted-foreground/60">
        <span>N/A</span>
        <span className="text-[9px]">Disabled</span>
      </div>
    );
  }

  // Single click anywhere on the cell toggles the crosspoint on/off. The gain
  // field stops click propagation so editing gain doesn't also toggle.
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onToggleActive}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onToggleActive();
        }
      }}
      title="Klick: an/aus"
      className={`flex w-24 h-14 cursor-pointer select-none flex-col items-center justify-center gap-1 rounded-md border transition-colors ${
        active
          ? "border-primary bg-card text-foreground hover:shadow-md"
          : "border-border bg-card text-muted-foreground hover:bg-muted/30 hover:border-primary/40"
      }`}
    >
      <span className={`text-[9px] font-semibold uppercase tracking-wider ${active ? "text-primary" : "text-muted-foreground"}`}>
        {active ? "An" : "Aus"}
      </span>
      <div className="flex items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
        <input
          type="number"
          step={0.5}
          min={MATRIX_GAIN_MIN_DB}
          max={MATRIX_GAIN_MAX_DB}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitGain}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              commitGain();
              (e.target as HTMLInputElement).blur();
            }
            if (e.key === "Escape") {
              setDraft(String(gain));
              (e.target as HTMLInputElement).blur();
            }
          }}
          aria-label="Matrix Gain dB"
          className={`h-6 w-12 rounded border border-border bg-background text-center text-[11px] tabular-nums focus:outline-none focus:ring-1 focus:ring-primary [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none ${
            active ? "" : "opacity-70"
          }`}
        />
        <span className="text-[9px] text-muted-foreground">dB</span>
      </div>
    </div>
  );
}

export function MatrixGrid({
  channels,
  mac,
  analogInputCount
}: {
  channels: ChannelParams["channels"];
  mac: string;
  analogInputCount?: number;
}) {
  const { setMatrixGain, setMatrixActive } = useAmpActions();
  const matrixSourceCount = channels.reduce((max, channel) => Math.max(max, channel.matrix.length), 0);
  // Prefer discovery's analogInputCount as authoritative; FC=27 may always return 4 matrix entries
  const headerCount = analogInputCount ?? matrixSourceCount;
  const sourceLabels = Array.from({ length: headerCount }, (_, idx) => `AIn${idx + 1}`);
  const enabledInputCount = headerCount;

  return (
    <div className="overflow-auto">
      <table className="border-separate border-spacing-1 text-sm">
        <thead>
          <tr>
            <th className="w-16" />
            {sourceLabels.map((label, idx) => (
              <th
                key={label}
                className={`text-center text-xs font-semibold pb-1 w-24 ${
                  idx < enabledInputCount ? "text-muted-foreground" : "text-muted-foreground/50"
                }`}
              >
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {channels.map((ch) => (
            <tr key={ch.channel}>
              <td className="text-xs font-semibold text-muted-foreground pr-2 text-right align-middle whitespace-nowrap">
                {ch.outputName}
              </td>
              {sourceLabels.map((_, sourceIndex) => {
                const cell = ch.matrix[sourceIndex] ?? { source: sourceIndex, gain: 0, active: false };
                const enabled = sourceIndex < enabledInputCount;
                return (
                  <td key={sourceIndex} className="align-middle">
                    <MatrixCell
                      gain={cell.gain}
                      active={cell.active}
                      disabled={!enabled}
                      onToggleActive={() => enabled && setMatrixActive(mac, ch.channel, sourceIndex, !cell.active)}
                      onGainChange={(db) => enabled && setMatrixGain(mac, ch.channel, sourceIndex, db)}
                    />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

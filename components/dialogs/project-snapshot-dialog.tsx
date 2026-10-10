"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Camera, Download, FolderOpen, RotateCcw, Trash2, Upload, AlertTriangle, Check } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useI18n } from "@/components/layout/i18n-provider";
import { useAmpActions } from "@/hooks/useAmpActions";
import { useAmpStore } from "@/stores/AmpStore";
import { useProjectStore } from "@/stores/ProjectStore";
import {
  buildDefaultMapping,
  executeRestore,
  planRestore,
  type RestoreStepResult
} from "@/lib/snapshot-restore";
import { DEFAULT_RESTORE_OPTIONS, type ProjectSnapshot, type RestoreOptions } from "@/lib/types/amp-snapshot";

interface SnapshotSummary {
  id: string;
  createdAt: string;
  note: string;
  ampCount: number;
  fullyVerified: boolean;
  byteLength: number;
}

const formatSize = (bytes: number) =>
  bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} kB`;

const formatWhen = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
};

export function ProjectSnapshotDialog() {
  const dict = useI18n();
  const t = dict.dialogs.snapshots;
  const actions = useAmpActions();

  const selectedProject = useProjectStore((state) => state.selectedProject);
  const amps = useAmpStore((state) => state.amps);

  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState("save");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [list, setList] = useState<SnapshotSummary[]>([]);

  const [loaded, setLoaded] = useState<ProjectSnapshot | null>(null);
  const [mapping, setMapping] = useState<ReturnType<typeof buildDefaultMapping>>({});
  const [options, setOptions] = useState<RestoreOptions>(DEFAULT_RESTORE_OPTIONS);
  const [results, setResults] = useState<RestoreStepResult[] | null>(null);
  const [mutedAfter, setMutedAfter] = useState<Array<{ mac: string; channel: number }>>([]);

  /** Amps that belong to this project and are online right now. */
  const projectAmps = useMemo(() => {
    const macs = new Set((selectedProject?.assigned_amps ?? []).map((a) => a.mac.toUpperCase()));
    return amps.filter((a) => macs.has(a.mac.toUpperCase()));
  }, [amps, selectedProject]);

  const liveIndex = useMemo(() => {
    const out: Record<string, { name: string; channelParams?: (typeof amps)[number]["channelParams"]; outputChannels: number }> =
      {};
    for (const amp of projectAmps) {
      out[amp.mac] = {
        name: amp.name ?? amp.lastKnownName ?? amp.mac,
        channelParams: amp.channelParams,
        outputChannels: amp.output_chx ?? amp.channelParams?.channels.length ?? 4
      };
    }
    return out;
  }, [projectAmps]);

  const refreshList = useCallback(async () => {
    if (!selectedProject) return;
    try {
      const res = await fetch(`/api/snapshots?projectId=${encodeURIComponent(selectedProject.id)}`);
      const data = (await res.json()) as { snapshots?: SnapshotSummary[] };
      setList(data.snapshots ?? []);
    } catch {
      setList([]);
    }
  }, [selectedProject]);

  useEffect(() => {
    if (open) void refreshList();
  }, [open, refreshList]);

  // --- Capture --------------------------------------------------------------

  const handleCapture = async () => {
    if (!selectedProject || projectAmps.length === 0) return;
    setBusy(true);
    setProgress(t.capturing);
    try {
      const res = await fetch("/api/amp-snapshot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ macs: projectAmps.map((a) => a.mac) })
      });
      const data = (await res.json()) as {
        success?: boolean;
        amps?: ProjectSnapshot["amps"];
        fullyVerified?: boolean;
        error?: string;
      };
      if (!res.ok || !data.success || !data.amps) throw new Error(data.error ?? `HTTP ${res.status}`);

      const snapshot: ProjectSnapshot = {
        schemaVersion: 1,
        id: `snap-${Date.now()}`,
        createdAt: new Date().toISOString(),
        note: note.trim(),
        projectId: selectedProject.id,
        projectName: selectedProject.name,
        amps: data.amps,
        project: {
          ampConstants: Object.fromEntries(
            (selectedProject.assigned_amps ?? []).map((a) => [a.mac, a.constants as unknown])
          ),
          ampOrder: (selectedProject.assigned_amps ?? []).map((a) => a.mac)
        },
        fullyVerified: Boolean(data.fullyVerified)
      };

      const save = await fetch("/api/snapshots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(snapshot)
      });
      if (!save.ok) throw new Error((await save.json())?.error ?? `HTTP ${save.status}`);

      setNote("");
      await refreshList();
      if (snapshot.fullyVerified) {
        toast.success(t.captureDone, { description: t.verifiedAll });
      } else {
        toast.warning(t.captureDone, { description: t.verifiedPartial });
      }
    } catch (err) {
      toast.error(t.captureFailed, { description: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
      setProgress("");
    }
  };

  // --- Restore --------------------------------------------------------------

  const loadSnapshot = async (id: string) => {
    if (!selectedProject) return;
    try {
      const res = await fetch(
        `/api/snapshots?projectId=${encodeURIComponent(selectedProject.id)}&id=${encodeURIComponent(id)}`
      );
      const data = (await res.json()) as { snapshot?: ProjectSnapshot; error?: string };
      if (!data.snapshot) throw new Error(data.error ?? "nicht lesbar");
      setLoaded(data.snapshot);
      setMapping(buildDefaultMapping(data.snapshot, projectAmps.map((a) => a.mac)));
      setResults(null);
      setMutedAfter([]);
    } catch (err) {
      toast.error(t.restoreFailed, { description: err instanceof Error ? err.message : String(err) });
    }
  };

  const plan = useMemo(
    () => (loaded ? planRestore(loaded, mapping, liveIndex, options) : null),
    [loaded, mapping, liveIndex, options]
  );

  const changeCount = plan?.channels.reduce((n, c) => n + c.changes.length, 0) ?? 0;
  const runnableChannels = plan?.channels.filter((c) => c.blockers.length === 0 && c.changes.length > 0) ?? [];

  const handleRestore = async () => {
    if (!loaded || !plan) return;
    setBusy(true);
    setResults(null);
    try {
      const stepResults = await executeRestore(
        plan,
        loaded,
        options,
        {
          muteOut: (mac, ch, m) => actions.muteOut(mac, ch, m),
          muteIn: (mac, ch, m) => actions.muteIn(mac, ch, m),
          setVolumeOut: (mac, ch, db) => actions.setVolumeOut(mac, ch, db),
          setTrimOut: (mac, ch, db) => actions.setTrimOut(mac, ch, db),
          setDelayOut: (mac, ch, ms) => actions.setDelayOut(mac, ch, ms),
          setDelayIn: (mac, ch, ms) => actions.setDelayIn(mac, ch, ms),
          noiseGateOut: (mac, ch, on) => actions.noiseGateOut(mac, ch, on),
          setMatrixGain: (mac, ch, src, db) => actions.setMatrixGain(mac, ch, src, db),
          setMatrixActive: (mac, ch, src, on) => actions.setMatrixActive(mac, ch, src, on),
          renameOutput: (mac, ch, name) => actions.renameOutput(mac, ch, name, { suppressToast: true })
        },
        (p) => setProgress(`${p.label} (${p.done}/${p.total})`)
      );
      setResults(stepResults);

      // Outputs we muted and did not deliberately restore stay muted; the user
      // decides when it gets loud again.
      if (options.muteBeforeWrite && !options.muteStates) {
        setMutedAfter(runnableChannels.map((c) => ({ mac: c.targetMac, channel: c.targetChannel })));
      }

      const ok = stepResults.filter((r) => r.ok).length;
      const failed = stepResults.length - ok;
      if (failed === 0) {
        toast.success(t.restoreDone, {
          description: t.resultOk.replace("{ok}", String(ok)).replace("{total}", String(stepResults.length))
        });
      } else {
        toast.error(t.restoreFailed, {
          description: t.resultOk.replace("{ok}", String(ok)).replace("{total}", String(stepResults.length))
        });
      }
    } catch (err) {
      toast.error(t.restoreFailed, { description: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
      setProgress("");
    }
  };

  const handleUnmuteAll = async () => {
    setBusy(true);
    try {
      for (const { mac, channel } of mutedAfter) {
        await actions.muteOut(mac, channel, false);
      }
      setMutedAfter([]);
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!selectedProject) return;
    await fetch(
      `/api/snapshots?projectId=${encodeURIComponent(selectedProject.id)}&id=${encodeURIComponent(id)}`,
      { method: "DELETE" }
    );
    if (loaded?.id === id) setLoaded(null);
    await refreshList();
  };

  if (!selectedProject) return null;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2">
          <Camera className="h-4 w-4" />
          {t.trigger}
        </Button>
      </DialogTrigger>

      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t.title}</DialogTitle>
          <DialogDescription>{t.description}</DialogDescription>
        </DialogHeader>

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="save">{t.tabSave}</TabsTrigger>
            <TabsTrigger value="restore">{t.tabRestore}</TabsTrigger>
          </TabsList>

          {/* ---------------- Capture ---------------- */}
          <TabsContent value="save" className="space-y-4 pt-4">
            <div className="space-y-2">
              <Label htmlFor="snapshot-note">{t.noteLabel}</Label>
              <div className="flex gap-2">
                <Input
                  id="snapshot-note"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder={t.notePlaceholder}
                  disabled={busy}
                />
                <Button onClick={handleCapture} disabled={busy || projectAmps.length === 0} className="gap-2">
                  <Camera className="h-4 w-4" />
                  {busy ? t.capturing : t.capture}
                </Button>
              </div>
              {progress && <p className="text-xs text-muted-foreground">{progress}</p>}
            </div>

            <div className="space-y-2">
              {list.length === 0 && <p className="text-sm text-muted-foreground">{t.noSnapshots}</p>}
              {list.map((s) => (
                <div
                  key={s.id}
                  className="flex items-center justify-between gap-3 rounded-md border border-border/60 px-3 py-2"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{s.note || formatWhen(s.createdAt)}</span>
                      {s.fullyVerified ? (
                        <Check className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
                      ) : (
                        <Badge variant="destructive" className="shrink-0 text-[10px]">
                          {t.unverifiedBadge}
                        </Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {formatWhen(s.createdAt)} ·{" "}
                      {t.snapshotMeta.replace("{amps}", String(s.ampCount)).replace("{size}", formatSize(s.byteLength))}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        void loadSnapshot(s.id);
                        setTab("restore");
                      }}
                    >
                      <RotateCcw className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => void handleDelete(s.id)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>

            <div className="flex flex-wrap gap-2 border-t border-border/60 pt-3">
              <Button variant="outline" size="sm" className="gap-2" onClick={() => void handleExport()}>
                <Download className="h-4 w-4" />
                {t.export}
              </Button>
              <Button variant="outline" size="sm" className="gap-2" onClick={() => void handleImport()}>
                <Upload className="h-4 w-4" />
                {t.import}
              </Button>
              <Button variant="outline" size="sm" className="gap-2" onClick={() => void handleOpenFolder()}>
                <FolderOpen className="h-4 w-4" />
                {t.openFolder}
              </Button>
            </div>
          </TabsContent>

          {/* ---------------- Restore ---------------- */}
          <TabsContent value="restore" className="space-y-4 pt-4">
            {!loaded && (
              <div className="space-y-2">
                <Label>{t.selectSnapshot}</Label>
                {list.length === 0 && <p className="text-sm text-muted-foreground">{t.noSnapshots}</p>}
                {list.map((s) => (
                  <Button
                    key={s.id}
                    variant="outline"
                    className="w-full justify-start"
                    onClick={() => void loadSnapshot(s.id)}
                  >
                    {s.note || formatWhen(s.createdAt)}
                  </Button>
                ))}
              </div>
            )}

            {loaded && (
              <>
                <section className="space-y-2">
                  <h3 className="text-sm font-semibold">{t.mappingTitle}</h3>
                  <p className="text-xs text-muted-foreground">{t.mappingHint}</p>
                  {loaded.amps.map((amp) => (
                    <div key={amp.mac} className="flex items-center gap-2 rounded-md border border-border/60 px-3 py-2">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{amp.name || amp.mac}</p>
                        <p className="text-xs text-muted-foreground">
                          {amp.mac} · {t.channels.replace("{n}", String(amp.outputChannels))}
                          {!amp.fullyVerified && ` · ${t.unverifiedBadge}`}
                        </p>
                      </div>
                      <span className="text-muted-foreground">→</span>
                      <Select
                        value={mapping[amp.mac]?.targetMac ?? "__none__"}
                        onValueChange={(v) =>
                          setMapping((prev) => ({
                            ...prev,
                            [amp.mac]: { ...prev[amp.mac], targetMac: v === "__none__" ? null : v }
                          }))
                        }
                      >
                        <SelectTrigger className="w-56">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">{t.targetNone}</SelectItem>
                          {projectAmps.map((a) => (
                            <SelectItem key={a.mac} value={a.mac}>
                              {a.name ?? a.lastKnownName ?? a.mac}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  ))}
                </section>

                <section className="space-y-2">
                  <h3 className="text-sm font-semibold">{t.optionsTitle}</h3>
                  {(
                    [
                      ["muteBeforeWrite", t.optMute],
                      ["speakerProcessing", t.optSpeaker],
                      ["levels", t.optLevels],
                      ["routing", t.optRouting],
                      ["names", t.optNames],
                      ["muteStates", t.optMuteStates]
                    ] as Array<[keyof RestoreOptions, string]>
                  ).map(([key, label]) => (
                    <label key={key} className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={options[key]}
                        onCheckedChange={(v) => setOptions((prev) => ({ ...prev, [key]: Boolean(v) }))}
                      />
                      {label}
                    </label>
                  ))}
                </section>

                <section className="space-y-2">
                  <h3 className="text-sm font-semibold">
                    {t.preview} —{" "}
                    {t.previewCount
                      .replace("{channels}", String(runnableChannels.length))
                      .replace("{changes}", String(changeCount))}
                  </h3>

                  {plan?.warnings.map((w) => (
                    <p key={w} className="flex items-start gap-2 text-xs text-amber-500">
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      {w}
                    </p>
                  ))}

                  {changeCount === 0 && <p className="text-sm text-muted-foreground">{t.previewEmpty}</p>}

                  <div className="max-h-64 space-y-2 overflow-y-auto">
                    {plan?.channels
                      .filter((c) => c.changes.length > 0 || c.blockers.length > 0)
                      .map((c) => (
                        <div
                          key={`${c.sourceMac}-${c.sourceChannel}`}
                          className="rounded-md border border-border/60 px-3 py-2"
                        >
                          <p className="text-xs font-semibold">{c.targetLabel}</p>
                          {c.blockers.map((b) => (
                            <p key={b} className="text-xs text-destructive">
                              {t.blocked}: {b}
                            </p>
                          ))}
                          {c.changes.map((ch, i) => (
                            <p key={i} className="text-xs text-muted-foreground">
                              {ch.label}: {ch.from !== undefined ? `${ch.from} → ` : ""}
                              <span className="text-foreground">{ch.to}</span>
                            </p>
                          ))}
                        </div>
                      ))}
                  </div>
                </section>

                {results && (
                  <section className="space-y-1 border-t border-border/60 pt-3">
                    {results
                      .filter((r) => !r.ok)
                      .map((r, i) => (
                        <p key={i} className="text-xs text-destructive">
                          CH{r.targetChannel + 1} {r.step}: {r.error}
                        </p>
                      ))}
                  </section>
                )}

                {mutedAfter.length > 0 && (
                  <div className="flex items-center justify-between gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2">
                    <p className="text-xs">{t.stillMuted.replace("{count}", String(mutedAfter.length))}</p>
                    <div className="flex gap-2">
                      <Button size="sm" variant="ghost" onClick={() => setMutedAfter([])}>
                        {t.keepMuted}
                      </Button>
                      <Button size="sm" onClick={() => void handleUnmuteAll()} disabled={busy}>
                        {t.unmuteAll}
                      </Button>
                    </div>
                  </div>
                )}
              </>
            )}
          </TabsContent>
        </Tabs>

        <DialogFooter className="gap-2">
          {progress && <span className="mr-auto text-xs text-muted-foreground">{progress}</span>}
          {tab === "restore" && loaded && (
            <Button onClick={() => void handleRestore()} disabled={busy || runnableChannels.length === 0}>
              {busy ? t.restoring : t.restore}
            </Button>
          )}
          <Button variant="outline" onClick={() => setOpen(false)}>
            {t.close}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  // --- File handling (Electron) ---------------------------------------------

  async function handleExport() {
    if (!selectedProject) return;
    const id = loaded?.id ?? list[0]?.id;
    if (!id) return;
    try {
      const res = await fetch(
        `/api/snapshots?projectId=${encodeURIComponent(selectedProject.id)}&id=${encodeURIComponent(id)}`
      );
      const data = (await res.json()) as { snapshot?: ProjectSnapshot };
      if (!data.snapshot) return;
      const json = JSON.stringify(data.snapshot, null, 2);
      const suggested = `${selectedProject.name}-${data.snapshot.createdAt.slice(0, 10)}.ampcore-snapshot.json`;

      if (typeof window !== "undefined" && window.electronWindow?.saveSnapshotFile) {
        const outcome = await window.electronWindow.saveSnapshotFile(suggested, json);
        if (outcome?.ok) toast.success(t.export, { description: outcome.path });
        return;
      }
      // Browser fallback: hand it to the download folder.
      const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = suggested;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error(t.captureFailed, { description: err instanceof Error ? err.message : String(err) });
    }
  }

  async function handleImport() {
    if (!selectedProject) return;
    try {
      let json: string | null = null;
      if (typeof window !== "undefined" && window.electronWindow?.openSnapshotFile) {
        const outcome = await window.electronWindow.openSnapshotFile();
        json = outcome?.content ?? null;
      }
      if (!json) return;

      const parsed = JSON.parse(json) as ProjectSnapshot;
      // Re-home the snapshot into this project so it shows up in this list,
      // while keeping the original capture metadata intact.
      parsed.projectId = selectedProject.id;
      parsed.id = `snap-imported-${Date.now()}`;
      await fetch("/api/snapshots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed)
      });
      await refreshList();
      toast.success(t.import);
    } catch (err) {
      toast.error(t.captureFailed, { description: err instanceof Error ? err.message : String(err) });
    }
  }

  async function handleOpenFolder() {
    if (typeof window !== "undefined" && window.electronWindow?.openSnapshotFolder) {
      await window.electronWindow.openSnapshotFolder();
    }
  }
}

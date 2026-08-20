"use client";

import { useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Download,
  FolderOpen,
  Link2,
  RotateCcw,
  SplitSquareVertical,
  Trash2,
  Upload
} from "lucide-react";
import { toast } from "sonner";
import { ConfirmActionDialog } from "@/components/dialogs/confirm-action-dialog";
import {
  ImportSlFolderDialog,
  type SlFolderItem,
  type SlImportParseResult
} from "@/components/dialogs/import-sl-folder-dialog";
import { LoadSpeakerConfigDialog, type LoadWaySelection } from "@/components/dialogs/load-speaker-config-dialog";
import { SpeakerConfigEditorDialog, type SpeakerProfileDraft } from "@/components/dialogs/speaker-config-editor-dialog";
import { Button } from "@/components/ui/button";
import { type ApplyWayMapping, type LibraryFileEntry, useLibraryStore } from "@/stores/LibraryStore";
import { fileKey, formatChannelList, toScopeKey } from "@/lib/speaker-config";
import {
  type ChannelGroup,
  type SpeakerOutputAssignment,
  useSpeakerConfigStore,
  findGroupForChannel
} from "@/stores/SpeakerConfigStore";
import {
  formatPostApplyResultSummary,
  runPostApplyActions,
  type PostApplyContext,
  type SpeakerApplyPolicy
} from "@/lib/speaker-apply-policy";
import { useAmpActions } from "@/hooks/useAmpActions";
import { useAmpStore, type ChannelParams } from "@/stores/AmpStore";
import { useI18n } from "@/components/layout/i18n-provider";
import { waitForFreshChannelData } from "@/lib/wait-for-fresh-channel-data";
import {
  computeSyncHashFromParsed,
  embedHashInName,
  extractBaseNameFromName,
  validateAllChannelsSync,
  validateChannelSync,
  type ChannelSyncResult
} from "@/lib/speaker-sync-hash";

/** Stable empty fallback for the store selector below — see the note there. */
const EMPTY_CHANNELS: ChannelParams["channels"] = [];

type QueuedApplyItem = {
  model: string;
  channels: number[];
  segmentType: "single" | "join" | "bridge";
  wayMappings: ApplyWayMapping[];
  missingReason?: string;
};

interface SpeakerControlBarProps {
  scope?: string | null;
  channelCount?: number;
}

function buildQueuedApplyItems(
  assignments: Record<number, SpeakerOutputAssignment>,
  files: LibraryFileEntry[],
  channelGroups: ChannelGroup[]
): QueuedApplyItem[] {
  const groupedAssignments = new Map<string, SpeakerOutputAssignment[]>();

  for (const assignment of Object.values(assignments)) {
    const key = assignment.groupId || `channel:${assignment.channel}`;
    const bucket = groupedAssignments.get(key);

    if (bucket) {
      bucket.push(assignment);
    } else {
      groupedAssignments.set(key, [assignment]);
    }
  }

  return [...groupedAssignments.entries()]
    .map(([groupId, grouped]) => {
      const orderedAssignments = [...grouped].sort((left, right) => {
        if (left.channel !== right.channel) return left.channel - right.channel;
        return left.wayIndex - right.wayIndex;
      });
      const firstAssignment = orderedAssignments[0];
      const profile = files.find((file) => file.id === firstAssignment.itemId);
      const channels = orderedAssignments.map((assignment) => assignment.channel);

      // Determine segment type from channel groups
      const group = findGroupForChannel(channelGroups, channels[0]);
      const segmentType: "single" | "join" | "bridge" = group?.type ?? "single";

      if (!profile) {
        return {
          model: firstAssignment.model,
          channels,
          segmentType,
          wayMappings: [],
          missingReason: "Missing linked library profile"
        };
      }

      if (firstAssignment.wayCount === 1) {
        const wayData = profile.deviceData?.[0];
        if (!wayData?.hex) {
          return {
            model: firstAssignment.model,
            channels,
            segmentType,
            wayMappings: [],
            missingReason: "Missing stored speaker payload"
          };
        }

        return {
          model: firstAssignment.model,
          channels,
          segmentType,
          wayMappings: [
            { hex: wayData.hex, channels: channels.map((channel) => channel - 1), wayLabel: profile.ways[0]?.label }
          ]
        };
      }

      const wayMappings: ApplyWayMapping[] = [];

      for (const assignment of [...orderedAssignments].sort((left, right) => left.wayIndex - right.wayIndex)) {
        const wayData = profile.deviceData?.[assignment.wayIndex];
        if (!wayData?.hex) {
          return {
            model: firstAssignment.model,
            channels,
            segmentType,
            wayMappings: [],
            missingReason: `Missing stored payload for ${assignment.wayLabel}`
          };
        }

        wayMappings.push({
          hex: wayData.hex,
          channels: [assignment.channel - 1],
          wayLabel: assignment.wayLabel
        });
      }

      return {
        model: firstAssignment.model,
        channels,
        segmentType,
        wayMappings
      };
    })
    .sort((left, right) => left.channels[0] - right.channels[0]);
}

export function SpeakerControlBar({ scope, channelCount = 4 }: SpeakerControlBarProps) {
  const i18n = useI18n();
  const cb = i18n.dialogs.speakerConfig.controlBar;
  const t = i18n.dialogs.speakerConfig.toasts;
  const scopeKey = toScopeKey(scope);
  const selectedOutputChannelsByScope = useSpeakerConfigStore((state) => state.selectedOutputChannelsByScope);
  const outputAssignmentsByScope = useSpeakerConfigStore((state) => state.outputAssignmentsByScope);
  const channelGroupsByScope = useSpeakerConfigStore((state) => state.channelGroupsByScope);
  const joinSelected = useSpeakerConfigStore((state) => state.joinSelected);
  const bridgeSelected = useSpeakerConfigStore((state) => state.bridgeSelected);
  const splitReset = useSpeakerConfigStore((state) => state.splitReset);
  const assignItemToOutputs = useSpeakerConfigStore((state) => state.assignItemToOutputs);

  // Post-apply policy state
  const postApplyEnabled = useSpeakerConfigStore((state) => state.postApplyEnabled);
  const postApplyChannelActions = useSpeakerConfigStore((state) => state.postApplyChannelActions);
  const postApplyTopologyActions = useSpeakerConfigStore((state) => state.postApplyTopologyActions);

  const files = useLibraryStore((state) => state.files);
  const selectedFileId = useLibraryStore((state) => state.selectedFileId);
  const loadLibrary = useLibraryStore((state) => state.loadLibrary);
  const applyToDevice = useLibraryStore((state) => state.applyToDevice);
  const deleteLibraryFile = useLibraryStore((state) => state.deleteLibraryFile);
  const applying = useLibraryStore((state) => state.applying);
  const deleting = useLibraryStore((state) => state.deleting);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [loadDialogOpen, setLoadDialogOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [slImportPreview, setSlImportPreview] = useState<SlImportParseResult | null>(null);
  const [slEditorOpen, setSlEditorOpen] = useState(false);
  const [slEditorDraft, setSlEditorDraft] = useState<SpeakerProfileDraft>({
    brand: "",
    family: "",
    model: "",
    application: "",
    notes: "",
    ways: []
  });
  const [slImporting, setSlImporting] = useState(false);
  const [slFolderDialogOpen, setSlFolderDialogOpen] = useState(false);
  const [slFolderItems, setSlFolderItems] = useState<SlFolderItem[]>([]);
  const [slFolderParsing, setSlFolderParsing] = useState(false);

  // Amp actions for post-apply operations
  const { muteOut, noiseGateOut, setTrimOut, setBridgePair, setAllBridgePairs, renameOutput } = useAmpActions();

  // Live sync status — derived from store data, recomputes on every poller tick.
  // The fallback MUST be a stable reference: zustand feeds this selector to
  // useSyncExternalStore, which compares snapshots by identity. A fresh `[]`
  // literal here looks like a new snapshot on every check, so React re-renders
  // forever and dies with "Maximum update depth exceeded" — which in the packaged
  // app surfaced as a blank "This page couldn't load" window.
  const liveChannels = useAmpStore(
    (state) => state.amps.find((a) => a.mac === scope)?.channelParams?.channels ?? EMPTY_CHANNELS
  );
  const syncResults = useMemo(
    () => (liveChannels.length > 0 ? validateAllChannelsSync(liveChannels) : null),
    [liveChannels]
  );

  // Build the post-apply policy from store state
  const applyPolicy = useMemo<SpeakerApplyPolicy>(
    () => ({
      enabled: postApplyEnabled,
      channelActions: {
        enabled: postApplyEnabled && postApplyChannelActions.length > 0,
        actions: postApplyChannelActions
      },
      topologyActions: {
        enabled: postApplyEnabled && postApplyTopologyActions.length > 0,
        actions: postApplyTopologyActions
      },
      behavior: {
        failureMode: "continue-and-report"
      }
    }),
    [postApplyEnabled, postApplyChannelActions, postApplyTopologyActions]
  );

  const selection = [...(selectedOutputChannelsByScope[scopeKey] ?? [])].sort((a, b) => a - b);
  const scopedAssignments = outputAssignmentsByScope[scopeKey] ?? {};
  const channelGroups = channelGroupsByScope[scopeKey] ?? [];
  const selectionCount = selection.length;
  const canJoin =
    selectionCount >= 2 && selection.every((channel, idx) => idx === 0 || channel === selection[idx - 1] + 1);
  const canBridge =
    selectionCount >= 2 &&
    selection.every((channel) => {
      const start = channel % 2 === 1 ? channel : channel - 1;
      return selection.includes(start) && selection.includes(start + 1);
    });
  const canReset = selectionCount > 0;
  const selectedLibraryFile = files.find((file) => fileKey(file) === selectedFileId) ?? null;
  const queuedApplyItems = useMemo(
    () => buildQueuedApplyItems(scopedAssignments, files, channelGroups),
    [scopedAssignments, files, channelGroups]
  );
  const readyQueuedApplyItems = queuedApplyItems.filter((item) => item.wayMappings.length > 0);
  const skippedQueuedApplyItems = queuedApplyItems.filter((item) => item.wayMappings.length === 0);
  const canApplyAll = Boolean(scope && !applying && readyQueuedApplyItems.length > 0);

  const handleApplyAll = async () => {
    if (!scope) {
      toast.error(t.applyAllNoDevice);
      return;
    }

    if (readyQueuedApplyItems.length === 0) {
      toast.error(t.applyAllNotReady, {
        description: skippedQueuedApplyItems[0]?.missingReason ?? t.applyAllNotReadyFallback
      });
      return;
    }

    const toastId = `speaker-apply-all-${scope}`;
    let appliedCount = 0;
    let failedCount = 0;
    let firstError: string | null = null;

    // Track post-apply results across all items
    let postApplySucceeded = 0;
    let postApplyFailed = 0;
    const postApplyActionTypes = new Set<string>();

    toast.loading(t.applyAllLoadingTitle, {
      id: toastId,
      description:
        skippedQueuedApplyItems.length > 0
          ? t.applyAllLoadingSkip
              .replace("{ready}", String(readyQueuedApplyItems.length))
              .replace("{skip}", String(skippedQueuedApplyItems.length))
          : t.applyAllLoading.replace("{count}", String(readyQueuedApplyItems.length))
    });

    for (let index = 0; index < readyQueuedApplyItems.length; index += 1) {
      const item = readyQueuedApplyItems[index];
      toast.loading(t.applyAllLoadingTitle, {
        id: toastId,
        description: t.applyAllProgress
          .replace("{index}", String(index + 1))
          .replace("{total}", String(readyQueuedApplyItems.length))
          .replace("{model}", item.model)
          .replace("{channels}", formatChannelList(item.channels))
      });

      // Channels touched by this single preset, and their way-label base names.
      const appliedChannels0Based = Array.from(new Set(item.wayMappings.flatMap((m) => m.channels))).sort(
        (a, b) => a - b
      );
      // ch0 → way label lookup for use as hash base name
      const wayLabelByChannel = new Map<number, string>(
        item.wayMappings.flatMap((m) => m.channels.map((ch) => [ch, m.wayLabel ?? ""]))
      );

      // Self-healing per SINGLE speaker preset: apply → embed sync hash → verify the
      // checksum actually landed ("synced") by reading channel data back. If any applied
      // channel is still not synced ("No Checksum"/drifted), re-apply and re-embed. Keep
      // trying until every applied channel reports "synced" or the retry budget is spent.
      const MAX_APPLY_ROUNDS = 4;
      let itemSynced = false;
      let lastApplyError: string | null = null;

      for (let round = 0; round < MAX_APPLY_ROUNDS && !itemSynced; round += 1) {
        if (round > 0) {
          toast.loading(t.applyAllLoadingTitle, {
            id: toastId,
            description:
              t.applyAllProgress
                .replace("{index}", String(index + 1))
                .replace("{total}", String(readyQueuedApplyItems.length))
                .replace("{model}", item.model)
                .replace("{channels}", formatChannelList(item.channels)) +
              ` · Prüfe (${round + 1}/${MAX_APPLY_ROUNDS})`
          });
        }

        // qos: true makes applyToDevice read each way's raw FC=57 blob back from the
        // amp and byte-compare it against what we intended to send — real content
        // verification, not just "the write left the Mac". This is what actually
        // proves the preset was applied correctly; the sync-hash step below only
        // detects drift *after* this has succeeded.
        const outcome = await applyToDevice({
          mac: scope,
          wayMappings: item.wayMappings,
          speakerName: item.model,
          qos: true
        });

        if (!outcome.ok) {
          const failedResult = outcome.results.find((result) => !result.sent || result.verified === false);
          lastApplyError =
            failedResult?.error ??
            (failedResult?.verified === false
              ? "Preset-Daten stimmten nach Rücklesen nicht mit dem Amp überein"
              : undefined) ??
            outcome.error ??
            "Unknown apply failure";
          // Send/verify failed — try the whole apply again.
          continue;
        }

        // Embed sync hash into output channel names after successful apply.
        // Wait for the poller to deliver fresh params (stale data would produce wrong hash).
        try {
          const freshParams = await waitForFreshChannelData(scope);
          if (freshParams?.channels) {
            for (const ch0 of appliedChannels0Based) {
              const chData = freshParams.channels[ch0];
              if (!chData) continue;
              const hash = computeSyncHashFromParsed(chData);
              const baseName = wayLabelByChannel.get(ch0) || extractBaseNameFromName(chData.outputName);
              const newName = embedHashInName(baseName, hash);
              // Server verifies the rename landed; suppress its per-attempt toast —
              // this loop's own verify + retry decides overall success.
              await renameOutput(scope, ch0 as 0 | 1 | 2 | 3, newName, { suppressToast: true });
            }
          }
        } catch {
          // Hash embedding is best-effort — the verify step below decides success.
        }

        // Verify: read fresh data back and confirm every applied channel is "synced".
        // Poll a couple of times so the rename has a chance to settle before we give up
        // on this round and re-apply.
        for (let verifyPoll = 0; verifyPoll < 3 && !itemSynced; verifyPoll += 1) {
          const verifyParams = await waitForFreshChannelData(scope);
          const channels = verifyParams?.channels;
          if (!channels) continue;
          itemSynced = appliedChannels0Based.every((ch0) => {
            const chData = channels[ch0];
            return chData ? validateChannelSync(chData).status === "synced" : false;
          });
        }
      }

      if (!itemSynced) {
        failedCount += 1;
        firstError ??= lastApplyError ?? "Checksum konnte nicht bestätigt werden (No Checksum)";
        // Skip post-apply actions for a preset we could not confirm.
        continue;
      }

      appliedCount += 1;

      // Run post-apply actions for this item
      const allAppliedChannels0Based = Array.from(new Set(item.wayMappings.flatMap((m) => m.channels))).sort(
        (a, b) => a - b
      );

      // Compute bridgePairsToEnable for adjustBridgeMode
      // Each bridge group in channelGroups with 2 channels means that pair should be bridged
      const totalOutputChannels = channelCount;
      const bridgePairsToEnable = channelGroups
        .filter((g) => g.type === "bridge" && g.channels.length === 2)
        .map((g) => Math.floor((Math.min(...g.channels) - 1) / 2));

      const postApplyContext: PostApplyContext = {
        mac: scope,
        segmentType: item.segmentType,
        segmentChannels1Based: item.channels,
        appliedTargets0Based: allAppliedChannels0Based,
        totalOutputChannels,
        bridgePairsToEnable
      };

      const postApplyResult = await runPostApplyActions(applyPolicy, postApplyContext, {
        muteOut,
        noiseGateOut,
        setTrimOut,
        setBridgePair,
        setAllBridgePairs
      });

      if (postApplyResult) {
        postApplySucceeded += postApplyResult.succeeded;
        postApplyFailed += postApplyResult.failed;

        // Collect action types for summary
        for (const r of postApplyResult.results) {
          if (r.ok) {
            const actionType = r.id.startsWith("bridge-pair")
              ? "Bridge enabled"
              : r.id.includes("unmuteOut")
                ? "Unmuted"
                : r.id.includes("disableNoiseGateOut")
                  ? "Gate off"
                  : r.id.includes("resetTrimOut")
                    ? "Trim reset"
                    : r.id;
            postApplyActionTypes.add(actionType);
          }
        }
      }
    }

    // Build summary
    const postApplySummary = postApplyActionTypes.size > 0 ? [...postApplyActionTypes].join(", ") : null;
    const hasPostApplyIssues = postApplyFailed > 0;

    if (failedCount > 0) {
      toast.error(t.applyAllErrorTitle, {
        id: toastId,
        description:
          t.applyAllErrorDesc
            .replace("{applied}", String(appliedCount))
            .replace("{failed}", String(failedCount))
            .replace("{skipped}", String(skippedQueuedApplyItems.length)) + (firstError ? `. ${firstError}` : "")
      });
      return;
    }

    if (hasPostApplyIssues) {
      toast.warning(t.applyAllWarningTitle, {
        id: toastId,
        description: t.applyAllWarningDesc
          .replace("{count}", String(appliedCount))
          .replace("{succeeded}", String(postApplySucceeded))
          .replace("{failed}", String(postApplyFailed))
      });
      return;
    }

    toast.success(t.applyAllSuccessTitle, {
      id: toastId,
      description: postApplySummary
        ? t.applyAllSuccessDesc.replace("{count}", String(appliedCount)).replace("{summary}", postApplySummary)
        : skippedQueuedApplyItems.length > 0
          ? t.applyAllSuccessSkipped
              .replace("{count}", String(appliedCount))
              .replace("{skipped}", String(skippedQueuedApplyItems.length))
          : t.applyAllSuccessNoSummary.replace("{count}", String(appliedCount))
    });
  };

  const handleDeleteSelected = async () => {
    if (!selectedLibraryFile) return;

    const outcome = await deleteLibraryFile(fileKey(selectedLibraryFile));
    if (!outcome.ok) {
      toast.error(t.deleteFailedTitle, {
        description: outcome.error ?? t.deleteFailedFallback
      });
      return;
    }

    setDeleteDialogOpen(false);
    toast.success(t.deleteSuccessTitle, {
      description: t.deleteSuccessDesc.replace(
        "{name}",
        selectedLibraryFile.brand || selectedLibraryFile.model || selectedLibraryFile.name
      )
    });
  };

  const handleOpenConfigFolder = async () => {
    if (typeof window === "undefined" || !window.electronWindow?.isDesktop) {
      toast.error(t.folderDesktopOnly);
      return;
    }

    const outcome = await window.electronWindow.openSpeakerLibraryFolder();
    if (!outcome.ok) {
      toast.error(t.folderFailedTitle, {
        description: outcome.error ?? t.folderFailedFallback
      });
    }
  };

  const handleImportSlClick = async () => {
    // In Electron: use native dialog (works on Windows + macOS, no webkitdirectory quirks)
    if (typeof window !== "undefined" && window.electronWindow?.pickSlFolder) {
      const outcome = await window.electronWindow.pickSlFolder();
      if (!outcome.ok) {
        if (!outcome.canceled) {
          toast.error(t.importSlFailedTitle, { description: outcome.error ?? t.importSlFailedFallback });
        }
        return;
      }
      const nativeFiles = outcome.files ?? [];
      if (nativeFiles.length === 0) {
        toast.error(t.importSlFolderEmpty);
        return;
      }
      await processSlFiles(nativeFiles.map(({ name, data }) => ({ name, data })));
      return;
    }
    // Fallback for web browser context
    fileInputRef.current?.click();
  };

  const handleSlFolderChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files;
    e.target.value = "";
    if (!fileList || fileList.length === 0) return;

    // Collect only .sl files from the picked folder (webkitdirectory gives all files)
    const webFiles = Array.from(fileList).filter((f) => f.name.toLowerCase().endsWith(".sl"));
    if (webFiles.length === 0) {
      toast.error(t.importSlFolderEmpty);
      return;
    }

    // Convert browser File objects to the same shape as Electron IPC results
    const items = await Promise.all(
      webFiles.map(async (file) => {
        const buf = await file.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let binary = "";
        for (const b of bytes) binary += String.fromCharCode(b);
        return { name: file.name, data: btoa(binary) };
      })
    );
    await processSlFiles(items);
  };

  const processSlFiles = async (files: Array<{ name: string; data: string }>) => {
    setSlFolderItems([]);
    setSlFolderParsing(true);
    setSlFolderDialogOpen(true);

    const results: SlFolderItem[] = [];
    for (const file of files) {
      // Decode base64 → Blob so the existing multipart API can accept it unchanged
      const binary = atob(file.data);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes]);

      const formData = new FormData();
      formData.append("file", blob, file.name);
      try {
        const res = await fetch("/api/library/import-sl", { method: "POST", body: formData });
        const data = (await res.json()) as SlImportParseResult;
        results.push({ fileName: file.name, result: data.success ? data : null, error: data.error });
      } catch {
        results.push({ fileName: file.name, result: null, error: "Network error" });
      }
    }

    setSlFolderItems(results);
    setSlFolderParsing(false);
  };

  const handleSlFolderSelect = (data: SlImportParseResult) => {
    setSlFolderDialogOpen(false);
    setSlImportPreview(data);
    setSlEditorDraft({
      id: data.id,
      brand: data.brand,
      family: data.family,
      model: data.model,
      application: "",
      notes: data.notes,
      ways: data.ways.map((w) => ({ id: w.id, label: w.label, role: w.role }))
    });
    setSlEditorOpen(true);
  };

  const handleSlImportSave = async (draft: SpeakerProfileDraft) => {
    if (!slImportPreview || slImporting) return;
    setSlImporting(true);

    const profile = {
      id: draft.id ?? slImportPreview.id,
      kind: "speaker",
      speaker: {
        brand: draft.brand,
        family: draft.family,
        model: draft.model,
        application: draft.application ?? "",
        notes: draft.notes,
        wayLabelsText: draft.ways.map((w) => w.label).join(" & "),
        ways: draft.ways.map((way, i) => ({
          id: way.id ?? "",
          label: way.label,
          role: way.role ?? "custom",
          deviceData: slImportPreview.ways[i]?.deviceData ?? null
        }))
      }
    };

    let res: Response;
    try {
      res = await fetch("/api/library", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile })
      });
    } catch {
      setSlImporting(false);
      toast.error(t.importSlFailedTitle, { description: t.importSlFailedFallback });
      return;
    }

    const data = (await res.json()) as { success: boolean; error?: string };
    setSlImporting(false);

    if (!data.success) {
      toast.error(t.importSlFailedTitle, { description: data.error ?? t.importSlFailedFallback });
      return;
    }

    setSlEditorOpen(false);
    setSlImportPreview(null);
    await loadLibrary();
    const displayName = `${draft.brand} ${draft.model}`.trim() || (draft.id ?? "");
    toast.success(t.importSlSuccessTitle, {
      description: t.importSlSuccessDesc.replace("{name}", displayName)
    });
  };

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        multiple
        {...{ webkitdirectory: "" }}
        onChange={(e) => void handleSlFolderChange(e)}
      />
      <section className="flex h-full min-h-0 flex-col rounded-md border border-border/50 bg-background/30 p-3">
        <div className="mb-2.5 flex items-center justify-between">
          <h3 className="text-sm font-semibold">{cb.controls}</h3>
        </div>

        <div className="flex flex-1 flex-col">
          <Button
            type="button"
            variant="outline"
            className="mb-2 h-8 w-full justify-start gap-2 text-xs"
            disabled={!canJoin}
            onClick={() => joinSelected(scope)}
          >
            <Link2 className="h-3.5 w-3.5" />
            {cb.join}
          </Button>

          <Button
            type="button"
            variant="outline"
            className="mb-2 h-8 w-full justify-start gap-2 text-xs"
            disabled={!canBridge}
            onClick={() => bridgeSelected(scope)}
          >
            <SplitSquareVertical className="h-3.5 w-3.5" />
            {cb.bridge}
          </Button>

          <Button
            type="button"
            variant="outline"
            className="mb-2 h-8 w-full justify-start gap-2 text-xs"
            disabled={!canReset}
            onClick={() => splitReset(scope)}
          >
            <RotateCcw className="h-3.5 w-3.5" />
            {cb.splitReset}
          </Button>

          <Button
            type="button"
            variant="outline"
            className="h-8 w-full justify-start gap-2 text-xs"
            disabled={!canApplyAll}
            onClick={() => void handleApplyAll()}
          >
            <Upload className="h-3.5 w-3.5" />
            {cb.applyAll}
          </Button>

          {syncResults && (
            <div className="mt-2 space-y-1">
              {syncResults
                .filter((r) => !!scopedAssignments[r.channel + 1])
                .map((r) => (
                  <div
                    key={r.channel}
                    className={`flex items-center justify-between rounded px-2 py-0.5 text-[10px] font-medium ${
                      r.status === "synced"
                        ? "bg-green-500/10 text-green-400"
                        : r.status === "drifted"
                          ? "bg-yellow-500/10 text-yellow-400"
                          : "bg-muted/40 text-muted-foreground"
                    }`}
                  >
                    <span>{r.outputName}</span>
                    <span className="uppercase">
                      {r.status === "unknown" ? "No Checksum" : r.status === "drifted" ? "Mismatch" : r.status}
                    </span>
                  </div>
                ))}
            </div>
          )}

          <div className="my-3 border-t border-border/50 pt-3">
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              {cb.libraryActions}
            </p>

            <Button
              type="button"
              variant="outline"
              className="mb-2 h-8 w-full justify-start gap-2 text-xs"
              disabled={!selectedLibraryFile}
              onClick={() => setLoadDialogOpen(true)}
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              {cb.load}
            </Button>

            <Button type="button" variant="outline" className="mb-2 h-8 w-full justify-start gap-2 text-xs" disabled>
              <ArrowRight className="h-3.5 w-3.5" />
              {cb.save}
            </Button>

            <Button
              type="button"
              variant="outline"
              className="mb-2 h-8 w-full justify-start gap-2 text-xs"
              disabled={!selectedLibraryFile || deleting}
              onClick={() => setDeleteDialogOpen(true)}
            >
              <Trash2 className="h-3.5 w-3.5" />
              {cb.deleteFromLibrary}
            </Button>

            <Button
              type="button"
              variant="outline"
              className="h-8 w-full justify-start gap-2 text-xs"
              onClick={() => void handleOpenConfigFolder()}
            >
              <FolderOpen className="h-3.5 w-3.5" />
              {cb.openConfigFolder}
            </Button>

            <Button
              type="button"
              variant="outline"
              className="mt-2 h-8 w-full justify-start gap-2 text-xs"
              onClick={() => void handleImportSlClick()}
            >
              <Download className="h-3.5 w-3.5" />
              {cb.importSl}
            </Button>
          </div>
        </div>

        {selectedLibraryFile && (
          <LoadSpeakerConfigDialog
            open={loadDialogOpen}
            onOpenChange={setLoadDialogOpen}
            scope={scope ?? null}
            channelCount={channelCount}
            profile={selectedLibraryFile}
            onLoad={(selections: LoadWaySelection[]) => {
              if (!selectedLibraryFile) return;

              for (const sel of selections) {
                assignItemToOutputs({
                  startChannel: sel.channel,
                  maxChannels: channelCount,
                  item: {
                    id: fileKey(selectedLibraryFile),
                    model:
                      [selectedLibraryFile.brand, selectedLibraryFile.model].filter(Boolean).join(" ").trim() ||
                      selectedLibraryFile.name,
                    ways: sel.wayLabel,
                    wayCount: 1
                  },
                  scope
                });
              }

              setLoadDialogOpen(false);

              toast.success(t.loadSuccessTitle, {
                description: t.loadSuccessDesc
                  .replace("{count}", String(selections.length))
                  .replace("{name}", selectedLibraryFile.brand || selectedLibraryFile.model || selectedLibraryFile.name)
              });
            }}
          />
        )}

        <ConfirmActionDialog
          open={deleteDialogOpen}
          onOpenChange={setDeleteDialogOpen}
          title={cb.deleteDialogTitle}
          description={
            selectedLibraryFile
              ? cb.deleteDialogDescription.replace(
                  "{name}",
                  selectedLibraryFile.brand || selectedLibraryFile.model || selectedLibraryFile.name
                )
              : cb.deleteDialogFallback
          }
          confirmLabel={cb.deleteLabel}
          confirmDisabled={!selectedLibraryFile || deleting}
          onConfirm={() => void handleDeleteSelected()}
        />

        <ImportSlFolderDialog
          open={slFolderDialogOpen}
          onOpenChange={setSlFolderDialogOpen}
          items={slFolderItems}
          parsing={slFolderParsing}
          onSelect={handleSlFolderSelect}
        />

        {slImportPreview && (
          <SpeakerConfigEditorDialog
            open={slEditorOpen}
            onOpenChange={(open) => {
              setSlEditorOpen(open);
              if (!open) setSlImportPreview(null);
            }}
            initialDraft={slEditorDraft}
            onChange={setSlEditorDraft}
            onSave={(draft) => void handleSlImportSave(draft)}
            saving={slImporting}
          />
        )}
      </section>
    </>
  );
}

"use client";

import { useEffect } from "react";
import { useProjectStore } from "@/stores/ProjectStore";
import { useAmpStore } from "@/stores/AmpStore";
import { useTabStore } from "@/stores/TabStore";
import { AssignAmpsDialog } from "@/components/dialogs/assign-amps-dialog";
import { AssignDemoAmpsDialog } from "@/components/dialogs/assign-demo-amps-dialog";
import { AmpTabs } from "@/components/monitor/amp-tabs";
import { NoProjectCard } from "@/components/monitor/no-project-card";
import { GlobalActionSpinner } from "@/components/monitor/global-action-spinner";
import type { Dictionary } from "@/lib/i18n/dictionaries";

interface MonitorPageProps {
  dictionary: Dictionary["monitor"];
}

export function MonitorPage({ dictionary }: MonitorPageProps) {
  const { selectedProject, loading } = useProjectStore();
  const amps = useAmpStore((state) => state.amps);
  const setCurrentView = useTabStore((state) => state.setCurrentView);

  useEffect(() => {
    setCurrentView("control");
  }, [setCurrentView]);

  return (
    <div className="flex min-h-0 flex-1 flex-col space-y-4">
      <GlobalActionSpinner />
      {selectedProject && (
        <section className="rounded-lg border border-border/50 bg-card/30 px-4 py-3 sm:px-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <h1 className="text-xl font-semibold sm:text-2xl">{selectedProject.name}</h1>

            <div className="flex flex-wrap items-center gap-2">
              {selectedProject.projectMode === "demo" ? <AssignDemoAmpsDialog /> : <AssignAmpsDialog />}
            </div>
          </div>
        </section>
      )}

      <div className="flex min-h-0 flex-1">{selectedProject ? <AmpTabs /> : !loading && <NoProjectCard />}</div>
    </div>
  );
}

export {};

declare global {
  interface Window {
    electronWindow?: {
      isDesktop: boolean;
      getVersion: () => Promise<string>;
      getPlatform: () => Promise<"darwin" | "win32" | "linux" | string>;
      openSpeakerLibraryFolder: () => Promise<{ ok: boolean; path?: string; error?: string }>;
      pickSlFolder: () => Promise<{
        ok: boolean;
        canceled?: boolean;
        error?: string;
        files?: Array<{ name: string; data: string }>;
      }>;
      minimize: () => Promise<boolean>;
      toggleMaximize: () => Promise<boolean>;
      close: () => Promise<boolean>;
      isMaximized: () => Promise<boolean>;
      /** Native save dialog for a project snapshot. */
      saveSnapshotFile: (
        suggestedName: string,
        content: string
      ) => Promise<{ ok: boolean; canceled?: boolean; path?: string; error?: string }>;
      /** Native open dialog; returns the file's text content. */
      openSnapshotFile: () => Promise<{
        ok: boolean;
        canceled?: boolean;
        content?: string;
        path?: string;
        error?: string;
      }>;
      /** Reveal the snapshot storage folder, for backing it up elsewhere. */
      openSnapshotFolder: () => Promise<{ ok: boolean; path?: string; error?: string }>;
      onMaximizedChange: (callback: (maximized: boolean) => void) => () => void;
    };
  }
}

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronWindow", {
  isDesktop: true,
  getVersion: () => ipcRenderer.invoke("app:get-version"),
  getPlatform: () => ipcRenderer.invoke("app:get-platform"),
  openSpeakerLibraryFolder: () => ipcRenderer.invoke("library:open-config-folder"),
  pickSlFolder: () => ipcRenderer.invoke("library:pick-sl-folder"),
  minimize: () => ipcRenderer.invoke("window:minimize"),
  toggleMaximize: () => ipcRenderer.invoke("window:toggle-maximize"),
  close: () => ipcRenderer.invoke("window:close"),
  isMaximized: () => ipcRenderer.invoke("window:is-maximized"),
  saveSnapshotFile: (suggestedName, content) =>
    ipcRenderer.invoke("snapshot:save-file", suggestedName, content),
  openSnapshotFile: () => ipcRenderer.invoke("snapshot:open-file"),
  openSnapshotFolder: () => ipcRenderer.invoke("snapshot:open-folder"),
  onMaximizedChange: (callback) => {
    const listener = (_event, maximized) => callback(Boolean(maximized));
    ipcRenderer.on("window:maximized-changed", listener);
    return () => ipcRenderer.removeListener("window:maximized-changed", listener);
  }
});

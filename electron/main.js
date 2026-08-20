const { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } = require("electron");
// Handle Squirrel.Windows events and shortcut creation
if (require("electron-squirrel-startup")) app.quit();
const fs = require("fs");
const path = require("path");
const http = require("http");
const { name: packageName, version: packageVersion } = require("../package.json");

const PORT = 3000;
const MIN_SPLASH_MS = 900;
const MAIN_READY_TIMEOUT_MS = 12000;
const isDev = !!process.env.ELECTRON_DEV;

let mainWindow;
let splashWindow;
let server;

function getSpeakerLibraryDir() {
  const base = process.env.APP_USER_DATA ?? process.cwd();
  return path.join(base, "storage", "speaker-library");
}

// Prevent multiple app instances.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}

app.on("second-instance", () => {
  const targetWindow = mainWindow && !mainWindow.isDestroyed() ? mainWindow : splashWindow;
  if (!targetWindow || targetWindow.isDestroyed()) return;
  if (targetWindow.isMinimized()) targetWindow.restore();
  targetWindow.focus();
});

// --- Server ---------------------------------------------------------------

/** Dev: poll until the external `next dev` process responds. */
function waitForDevServer() {
  return new Promise((resolve) => {
    const poll = () => {
      http
        .get(`http://localhost:${PORT}/`, (res) => {
          if (res.statusCode < 500) resolve();
          else setTimeout(poll, 300);
        })
        .on("error", () => setTimeout(poll, 300));
    };

    poll();
  });
}

/** Prod: start Next.js standalone server in-process. */
async function startServer() {
  const appRoot = path.join(__dirname, "..");
  const standaloneDir = path.join(appRoot, ".next", "standalone");
  process.env.APP_USER_DATA = app.getPath("userData");
  process.env.PORT = String(PORT);

  // The standalone server.js calls process.chdir(__dirname) which fails
  // inside an asar archive. Override chdir to silently ignore asar paths.
  const originalChdir = process.chdir.bind(process);
  process.chdir = (dir) => {
    if (typeof dir === "string" && dir.includes(".asar")) return;
    return originalChdir(dir);
  };

  // The standalone server.js sets up its own http server on PORT.
  require(path.join(standaloneDir, "server.js"));

  // Wait until the server is actually listening.
  await new Promise((resolve) => {
    const poll = () => {
      http
        .get(`http://localhost:${PORT}/`, (res) => {
          if (res.statusCode < 500) resolve();
          else setTimeout(poll, 200);
        })
        .on("error", () => setTimeout(poll, 200));
    };
    poll();
  });
}

// --- Window ---------------------------------------------------------------

function createSplashWindow() {
  const isDark = nativeTheme.shouldUseDarkColors;

  splashWindow = new BrowserWindow({
    width: 520,
    height: 420,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: isDark ? "#121212" : "#f5f5f5",
    show: true,
    title: "AmpCore",
    autoHideMenuBar: true,
    frame: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      devTools: isDev
    }
  });

  splashWindow.on("closed", () => {
    splashWindow = null;
  });

  splashWindow.loadFile(path.join(__dirname, "splash.html"), {
    query: {
      name: packageName,
      version: packageVersion
    }
  });
}

function createMainWindow() {
  const isDark = nativeTheme.shouldUseDarkColors;
  const isMac = process.platform === "darwin";

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: isDark ? "#121212" : "#f5f5f5",
    show: false,
    title: "AmpCore",
    autoHideMenuBar: true,
    frame: !isMac,
    titleBarStyle: isMac ? "hiddenInset" : "hidden",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js")
    }
  });

  const emitWindowState = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const wc = mainWindow.webContents;
    if (!wc || wc.isDestroyed() || wc.isCrashed()) return;

    try {
      wc.send("window:maximized-changed", mainWindow.isMaximized());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Happens when window/frame is torn down between event emission and send.
      if (!message.includes("Render frame was disposed")) {
        console.error("Failed to emit window state:", err);
      }
    }
  };

  // Recover from a failed navigation instead of leaving the user stranded on
  // Chrome's "This page couldn't load" page, which never retries by itself.
  // The Next server runs inside THIS process, so if the event loop is busy at
  // load time — e.g. the restored project points at amps that no longer answer,
  // and every poll to them has to run into its timeout — the navigation can fail
  // even though the server itself is fine seconds later.
  let reloadAttempts = 0;
  const MAX_RELOAD_ATTEMPTS = 10;
  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return;
    // -3 = ERR_ABORTED: a navigation we replaced ourselves, not a failure.
    if (errorCode === -3) return;
    if (reloadAttempts >= MAX_RELOAD_ATTEMPTS) {
      console.error(`Giving up reloading after ${reloadAttempts} attempts: ${errorDescription} (${validatedURL})`);
      return;
    }
    reloadAttempts += 1;
    const delayMs = Math.min(500 * reloadAttempts, 3000);
    console.error(`Load failed (${errorDescription}), retry ${reloadAttempts}/${MAX_RELOAD_ATTEMPTS} in ${delayMs}ms`);
    setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.loadURL(`http://localhost:${PORT}`).catch(() => {
        // Swallowed on purpose: the next did-fail-load drives the next retry.
      });
    }, delayMs);
  });

  mainWindow.webContents.on("did-finish-load", () => {
    reloadAttempts = 0;
  });

  mainWindow.on("maximize", emitWindowState);
  mainWindow.on("unmaximize", emitWindowState);
  mainWindow.on("enter-full-screen", emitWindowState);
  mainWindow.on("leave-full-screen", emitWindowState);

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function setSplashStatus(message, isError = false) {
  if (!splashWindow || splashWindow.isDestroyed()) return;

  const safeMessage = JSON.stringify(String(message));
  void splashWindow.webContents
    .executeJavaScript(`window.setSplashStatus ? window.setSplashStatus(${safeMessage}, ${Boolean(isError)}) : null`)
    .catch(() => {
      // Ignore if splash renderer is already closing.
    });
}

async function showMainWindowWhenReady(mainReadyAtMs) {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const elapsed = Date.now() - mainReadyAtMs;
  const remainingSplashMs = Math.max(0, MIN_SPLASH_MS - elapsed);
  if (remainingSplashMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, remainingSplashMs));
  }

  if (!mainWindow || mainWindow.isDestroyed()) return;

  mainWindow.show();
  mainWindow.focus();

  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.close();
  }
}

async function waitForMainWindowReady() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (isDev) return;
  if (mainWindow.webContents.isLoadingMainFrame() === false) return;

  await new Promise((resolve) => {
    let resolved = false;
    const wc = mainWindow?.webContents;

    const done = () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeoutId);
      mainWindow?.removeListener("ready-to-show", done);
      wc?.removeListener("did-finish-load", done);
      wc?.removeListener("did-stop-loading", done);
      resolve();
    };

    const timeoutId = setTimeout(done, MAIN_READY_TIMEOUT_MS);
    mainWindow.once("ready-to-show", done);
    wc?.once("did-finish-load", done);
    wc?.once("did-stop-loading", done);
  });
}

ipcMain.handle("window:minimize", () => {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  mainWindow.minimize();
  return true;
});

ipcMain.handle("window:toggle-maximize", () => {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize();
    return false;
  }
  mainWindow.maximize();
  return true;
});

ipcMain.handle("window:close", () => {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  mainWindow.close();
  return true;
});

ipcMain.handle("window:is-maximized", () => {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  return mainWindow.isMaximized();
});

ipcMain.handle("app:get-version", () => packageVersion);

ipcMain.handle("app:get-platform", () => process.platform);

ipcMain.handle("library:open-config-folder", async () => {
  try {
    const directory = getSpeakerLibraryDir();
    fs.mkdirSync(directory, { recursive: true });

    const error = await shell.openPath(directory);
    if (error) {
      return { ok: false, error };
    }

    return { ok: true, path: directory };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
});

ipcMain.handle("library:pick-sl-folder", async () => {
  if (!mainWindow || mainWindow.isDestroyed()) return { ok: false, error: "No window" };

  let result;
  try {
    result = await dialog.showOpenDialog(mainWindow, {
      title: "Select .sl folder",
      properties: ["openDirectory"]
    });
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  if (result.canceled || result.filePaths.length === 0) {
    return { ok: false, canceled: true };
  }

  const folderPath = result.filePaths[0];

  try {
    const entries = fs.readdirSync(folderPath);
    const slFiles = entries.filter((name) => name.toLowerCase().endsWith(".sl"));

    const files = slFiles.map((name) => {
      const data = fs.readFileSync(path.join(folderPath, name));
      return { name, data: data.toString("base64") };
    });

    return { ok: true, files };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

// --- Lifecycle ------------------------------------------------------------

app.whenReady().then(() => {
  createSplashWindow();
  createMainWindow();
  setSplashStatus(isDev ? "Waiting for development server..." : "Starting local server...");
  const splashShownAt = Date.now();
  const serverReady = isDev ? waitForDevServer() : startServer();

  serverReady
    .then(async () => {
      const url = `http://localhost:${PORT}`;
      setSplashStatus("Loading interface...");

      if (!mainWindow || mainWindow.isDestroyed()) return;

      // Retry with a short backoff instead of twice back-to-back: if the server
      // is not quite serving yet (e.g. right after a restart, while the previous
      // instance still holds the port), two immediate attempts both fail in the
      // same instant and the window is left stranded on Chrome's "This page
      // couldn't load" page, which never retries by itself.
      const LOAD_ATTEMPTS = 6;
      const LOAD_RETRY_MS = 500;
      let lastLoadErr;
      for (let attempt = 1; attempt <= LOAD_ATTEMPTS; attempt++) {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        try {
          await mainWindow.loadURL(url);
          lastLoadErr = undefined;
          break;
        } catch (loadErr) {
          lastLoadErr = loadErr;
          if (attempt < LOAD_ATTEMPTS) {
            setSplashStatus(`Loading interface... (${attempt + 1}/${LOAD_ATTEMPTS})`);
            await new Promise((resolve) => setTimeout(resolve, LOAD_RETRY_MS));
          }
        }
      }
      if (lastLoadErr) {
        console.error("Failed to load app URL:", lastLoadErr);
        throw lastLoadErr;
      }

      await waitForMainWindowReady();
      await showMainWindowWhenReady(splashShownAt);
    })
    .catch((err) => {
      console.error("Failed to start app server:", err);
      setSplashStatus(err instanceof Error ? err.message : String(err), true);

      if (splashWindow && !splashWindow.isDestroyed()) {
        const safeMessage = JSON.stringify(String(err instanceof Error ? err.message : err));
        void splashWindow.webContents.executeJavaScript(
          `window.setSplashStatus ? window.setSplashStatus(${safeMessage}, true) : null`
        );
      }
    });
});

app.on("window-all-closed", () => {
  if (server) server.close();
  app.quit();
});

import { app, BrowserWindow, Menu, nativeImage, shell, Tray } from "electron";
import type { ChildProcess } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  getAvailablePort,
  extractDshUrl,
  startDshServer,
  waitForDshStartup
} from "./dsh-server.js";
import { ensureWebProfilePlugins } from "./dsh-profile.js";

const DSH_HOST = "127.0.0.1";
const APP_NAME = "Harness Desktop";
const MAX_LOG_LINES = 80;
const APP_ICON_PATH = path.join(app.getAppPath(), "build", "icon.png");
const LOADING_PAGE_PATH = path.join(app.getAppPath(), "src", "loading.html");
const LOADING_PAGE_URL = pathToFileURL(LOADING_PAGE_PATH).href;
/**
 * Window chrome for `titleBarStyle: "hidden"` plus a `titleBarOverlay`: Windows
 * paints the native minimize/maximize/close buttons on top of the page, so the
 * strip they occupy must stay empty or they cover the app's own header.
 *
 * `body` reserves that strip and the page keeps its own layout because
 * `box-sizing: border-box` folds the padding into the existing
 * `html, body { height: 100% }`, leaving `#root` exactly the height of the
 * remaining content area instead of overflowing the window. The pseudo element
 * keeps the reserved strip draggable, which is the only title bar the window
 * has.
 */
const WINDOW_CHROME_CSS = `
  html::before {
    content: "";
    position: fixed;
    top: env(titlebar-area-y, 0px);
    left: env(titlebar-area-x, 0px);
    width: env(titlebar-area-width, calc(100% - 138px));
    height: env(titlebar-area-height, 32px);
    z-index: 2147483647;
    -webkit-app-region: drag;
  }

  body {
    box-sizing: border-box;
    padding-top: calc(
      env(titlebar-area-y, 0px) + env(titlebar-area-height, 32px)
    );
  }
`;

let mainWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let dshProcess: ChildProcess | undefined;
let dshUrl: string | undefined;
let isQuitting = false;
let hasLoadedDsh = false;
const recentLogs: string[] = [];

function appendLog(source: string, chunk: Buffer): void {
  const lines = chunk
    .toString()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => `[${source}] ${line}`);

  recentLogs.push(...lines);
  recentLogs.splice(0, Math.max(0, recentLogs.length - MAX_LOG_LINES));

  for (const line of lines) {
    console.log(line);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * List this application's bundled plugins in the dsh `web` profile before the
 * service starts. A packaged build cannot run `dsh plugin add` — Electron's
 * Node runtime ships neither npm nor corepack — so this is the only path by
 * which a bundled plugin reaches a user. Failure is never fatal: the profile
 * is an enhancement, and the service still starts on whatever dsh finds.
 */
function ensureProfilePlugins(): void {
  try {
    const result = ensureWebProfilePlugins();
    const detail = result.reason
      ? `${result.status} (${result.reason})`
      : result.status;
    appendLog("profile", Buffer.from(`web profile plugins: ${detail}`));

    if (result.installed.length > 0) {
      appendLog(
        "profile",
        Buffer.from(`installed into profile: ${result.installed.join(", ")}`)
      );
    }

    if (result.bundles.length > 0) {
      appendLog("profile", Buffer.from(`bundles: ${result.bundles.join(", ")}`));
    }
  } catch (error) {
    appendLog(
      "profile",
      Buffer.from(`web profile plugin setup failed: ${errorMessage(error)}`)
    );
  }
}

async function updateLoadingStatus(message: string): Promise<void> {
  const window = mainWindow;
  if (!window || window.isDestroyed()) {
    return;
  }

  await window.webContents.executeJavaScript(
    `window.setStatus(${JSON.stringify(message)})`
  );
}

async function showStartupError(title: string, error: unknown): Promise<void> {
  const window = mainWindow;
  if (!window || window.isDestroyed()) {
    return;
  }

  const details = [errorMessage(error), ...recentLogs].filter(Boolean).join("\n");
  await window.webContents.executeJavaScript(
    `window.showError(${JSON.stringify(title)}, ${JSON.stringify(details)})`
  );
}

async function showProcessError(title: string, error: unknown): Promise<void> {
  const window = mainWindow;
  if (!window || window.isDestroyed()) {
    return;
  }

  if (window.webContents.getURL() !== LOADING_PAGE_URL) {
    await window.loadFile(LOADING_PAGE_PATH);
  }

  await showStartupError(title, error);
}

function stopDshServer(): void {
  if (!dshProcess || dshProcess.killed) {
    return;
  }

  dshProcess.kill();
  dshProcess = undefined;
}

function isDshUrl(url: string): boolean {
  if (!dshUrl) {
    return false;
  }

  try {
    return new URL(url).origin === new URL(dshUrl).origin;
  } catch {
    return false;
  }
}

function openExternalUrl(url: string): void {
  try {
    const protocol = new URL(url).protocol;
    if (protocol === "http:" || protocol === "https:") {
      void shell.openExternal(url);
    }
  } catch {
    // Ignore malformed or unsupported external URLs.
  }
}

function configureNavigation(window: BrowserWindow): void {
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isDshUrl(url)) {
      return { action: "allow" };
    }

    openExternalUrl(url);
    return { action: "deny" };
  });

  window.webContents.on("will-navigate", (event, url) => {
    if (!isDshUrl(url) && url !== LOADING_PAGE_URL) {
      event.preventDefault();
      openExternalUrl(url);
    }
  });
}

function configureWindowChrome(window: BrowserWindow): void {
  window.webContents.on("did-finish-load", () => {
    void window.webContents.insertCSS(WINDOW_CHROME_CSS).catch((error) => {
      console.error("Failed to install the window chrome stylesheet.", error);
    });
  });
}

function showMainWindow(): void {
  const window = mainWindow;
  if (!window || window.isDestroyed()) {
    if (!app.isReady()) {
      return;
    }

    void createMainWindow().then(async () => {
      if (dshUrl && mainWindow) {
        await mainWindow.loadURL(dshUrl);
      }
    });
    return;
  }

  if (window.isMinimized()) {
    window.restore();
  }
  window.show();
  window.focus();
}

function quitApplication(): void {
  isQuitting = true;
  app.quit();
}

function createTray(): void {
  const icon = nativeImage.createFromPath(APP_ICON_PATH);
  tray = new Tray(icon);
  tray.setToolTip(APP_NAME);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "打开", click: showMainWindow },
      { label: "关闭", click: quitApplication }
    ])
  );
  tray.on("click", showMainWindow);
}

async function createMainWindow(): Promise<void> {
  const window = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 900,
    minHeight: 640,
    backgroundColor: "#15171a",
    icon: APP_ICON_PATH,
    show: false,
    title: APP_NAME,
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#15171a",
      symbolColor: "#ffffff",
      height: 32
    },
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow = window;
  configureNavigation(window);
  configureWindowChrome(window);
  window.on("page-title-updated", (event) => {
    event.preventDefault();
    window.setTitle(APP_NAME);
  });
  window.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      window.hide();
    }
  });
  window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    if (mainWindow === window) {
      mainWindow = undefined;
    }
  });

  await window.loadFile(LOADING_PAGE_PATH);
}

async function startApplication(): Promise<void> {
  createTray();
  await createMainWindow();
  await updateLoadingStatus(`正在启动 ${APP_NAME}…`);
  ensureProfilePlugins();

  const workingDirectory = app.isPackaged
    ? app.getPath("documents")
    : process.cwd();

  try {
    const port = await getAvailablePort(DSH_HOST);
    dshUrl = `http://${DSH_HOST}:${port}`;
    dshProcess = startDshServer({
      electronPath: process.execPath,
      cwd: workingDirectory,
      host: DSH_HOST,
      port
    });

    let dshOutput = "";
    let resolveDshUrl: ((url: string) => void) | undefined;
    const dshUrlReady = new Promise<string>((resolve) => {
      resolveDshUrl = resolve;
    });
    dshProcess.stdout?.on("data", (chunk: Buffer) => {
      appendLog("dsh", chunk);
      dshOutput += chunk.toString();
      const launchedUrl = extractDshUrl(dshOutput);
      if (launchedUrl) {
        dshUrl = launchedUrl;
        resolveDshUrl?.(launchedUrl);
      }
    });
    dshProcess.stderr?.on("data", (chunk: Buffer) =>
      appendLog("dsh:error", chunk)
    );
    dshProcess.on("error", (error) => {
      appendLog("process", Buffer.from(error.message));
      void showProcessError(`无法启动 ${APP_NAME}`, error);
    });
    dshProcess.on("exit", (code, signal) => {
      appendLog(
        "process",
        Buffer.from(
          `Exited with code ${code ?? "null"}, signal ${signal ?? "none"}`
        )
      );

      if (!isQuitting) {
        const message = hasLoadedDsh
          ? `dsh process exited (code ${code ?? "unknown"}).`
          : `dsh process exited before startup (code ${code ?? "unknown"}).`;
        void showProcessError(
          hasLoadedDsh ? `${APP_NAME} 已停止` : `${APP_NAME} 启动失败`,
          new Error(message)
        );
      }
    });

    await waitForDshStartup(dshProcess, dshUrl);
    if (!dshUrl.includes("?token=")) {
      await Promise.race([
        dshUrlReady,
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("dsh did not report its authenticated Web URL.")),
            5_000
          )
        )
      ]);
    }
    const window = mainWindow;
    if (!window || window.isDestroyed()) {
      return;
    }
    await window.loadURL(dshUrl);
    hasLoadedDsh = true;
  } catch (error) {
    stopDshServer();
    await showProcessError(`${APP_NAME} 启动失败`, error);
  }
}

Menu.setApplicationMenu(null);
app.setName(APP_NAME);

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (hasSingleInstanceLock) {
  app.on("second-instance", showMainWindow);
  void app.whenReady().then(startApplication).catch((error: unknown) => {
    console.error(error);
    app.quit();
  });
} else {
  app.quit();
}

app.on("activate", () => {
  showMainWindow();
});

app.on("before-quit", () => {
  isQuitting = true;
  tray?.destroy();
  tray = undefined;
  stopDshServer();
});

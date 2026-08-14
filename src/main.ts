import { app, BrowserWindow, Menu, shell } from "electron";
import type { ChildProcess } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  getAvailablePort,
  startDshServer,
  waitForDshStartup
} from "./dsh-server.js";

const DSH_HOST = "127.0.0.1";
const MAX_LOG_LINES = 80;
const LOADING_PAGE_PATH = path.join(app.getAppPath(), "src", "loading.html");
const LOADING_PAGE_URL = pathToFileURL(LOADING_PAGE_PATH).href;
const WINDOW_DRAG_REGION_CSS = `
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
`;

let mainWindow: BrowserWindow | undefined;
let dshProcess: ChildProcess | undefined;
let dshUrl: string | undefined;
let isQuitting = false;
let hasLoadedHarness = false;
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

function isHarnessUrl(url: string): boolean {
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
    if (isHarnessUrl(url)) {
      return { action: "allow" };
    }

    openExternalUrl(url);
    return { action: "deny" };
  });

  window.webContents.on("will-navigate", (event, url) => {
    if (!isHarnessUrl(url) && url !== LOADING_PAGE_URL) {
      event.preventDefault();
      openExternalUrl(url);
    }
  });
}

function configureWindowDragRegion(window: BrowserWindow): void {
  window.webContents.on("did-finish-load", () => {
    void window.webContents.insertCSS(WINDOW_DRAG_REGION_CSS).catch((error) => {
      console.error("Failed to install the window drag region.", error);
    });
  });
}

async function createMainWindow(): Promise<void> {
  const window = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 900,
    minHeight: 640,
    backgroundColor: "#15171a",
    show: false,
    title: "",
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
  configureWindowDragRegion(window);
  window.on("page-title-updated", (event) => {
    event.preventDefault();
    window.setTitle("");
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
  await createMainWindow();
  await updateLoadingStatus("正在启动 DeepSeek Harness…");

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

    dshProcess.stdout?.on("data", (chunk: Buffer) => appendLog("dsh", chunk));
    dshProcess.stderr?.on("data", (chunk: Buffer) =>
      appendLog("dsh:error", chunk)
    );
    dshProcess.on("error", (error) => {
      appendLog("process", Buffer.from(error.message));
      void showProcessError("无法启动 DeepSeek Harness", error);
    });
    dshProcess.on("exit", (code, signal) => {
      appendLog(
        "process",
        Buffer.from(
          `Exited with code ${code ?? "null"}, signal ${signal ?? "none"}`
        )
      );

      if (!isQuitting) {
        const message = hasLoadedHarness
          ? `dsh process exited (code ${code ?? "unknown"}).`
          : `dsh process exited before startup (code ${code ?? "unknown"}).`;
        void showProcessError(
          hasLoadedHarness
            ? "DeepSeek Harness 已停止"
            : "DeepSeek Harness 启动失败",
          new Error(message)
        );
      }
    });

    await waitForDshStartup(dshProcess, dshUrl);
    const window = mainWindow;
    if (!window || window.isDestroyed()) {
      return;
    }
    await window.loadURL(dshUrl);
    hasLoadedHarness = true;
  } catch (error) {
    stopDshServer();
    await showProcessError("DeepSeek Harness 启动失败", error);
  }
}

Menu.setApplicationMenu(null);

void app.whenReady().then(startApplication).catch((error: unknown) => {
  console.error(error);
  app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createMainWindow().then(async () => {
      if (dshUrl && mainWindow) {
        await mainWindow.loadURL(dshUrl);
      }
    });
  }
});

app.on("before-quit", () => {
  isQuitting = true;
  stopDshServer();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

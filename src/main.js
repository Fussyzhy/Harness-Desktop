import { app, BrowserWindow, Menu, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getAvailablePort,
  startDshServer,
  waitForDshStartup
} from "./dsh-server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DSH_HOST = "127.0.0.1";
const MAX_LOG_LINES = 80;

let mainWindow;
let dshProcess;
let dshUrl;
let isQuitting = false;
let hasLoadedHarness = false;
const recentLogs = [];

function appendLog(source, chunk) {
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

async function updateLoadingStatus(message) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  await mainWindow.webContents.executeJavaScript(
    `window.setStatus(${JSON.stringify(message)})`
  );
}

async function showStartupError(title, error) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  const details = [error?.message, ...recentLogs].filter(Boolean).join("\n");
  await mainWindow.webContents.executeJavaScript(
    `window.showError(${JSON.stringify(title)}, ${JSON.stringify(details)})`
  );
}

async function showProcessError(title, error) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  if (!mainWindow.webContents.getURL().startsWith("file:")) {
    await mainWindow.loadFile(path.join(__dirname, "loading.html"));
  }

  await showStartupError(title, error);
}

function stopDshServer() {
  if (!dshProcess || dshProcess.killed) {
    return;
  }

  dshProcess.kill();
  dshProcess = undefined;
}

function isHarnessUrl(url) {
  if (!dshUrl) {
    return false;
  }

  try {
    return new URL(url).origin === new URL(dshUrl).origin;
  } catch {
    return false;
  }
}

function openExternalUrl(url) {
  try {
    const protocol = new URL(url).protocol;
    if (protocol === "http:" || protocol === "https:") {
      void shell.openExternal(url);
    }
  } catch {
    // Ignore malformed or unsupported external URLs.
  }
}

function configureNavigation(window) {
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isHarnessUrl(url)) {
      return { action: "allow" };
    }

    openExternalUrl(url);
    return { action: "deny" };
  });

  window.webContents.on("will-navigate", (event, url) => {
    const isHarnessPage = isHarnessUrl(url);
    const isLoadingPage = url === new URL("loading.html", import.meta.url).href;

    if (!isHarnessPage && !isLoadingPage) {
      event.preventDefault();
      openExternalUrl(url);
    }
  });
}

async function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 900,
    minHeight: 640,
    backgroundColor: "#f6f7f9",
    show: false,
    title: "DeepSeek Harness",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  configureNavigation(mainWindow);
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("closed", () => {
    mainWindow = undefined;
  });

  await mainWindow.loadFile(path.join(__dirname, "loading.html"));
}

async function startApplication() {
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

    dshProcess.stdout.on("data", (chunk) => appendLog("dsh", chunk));
    dshProcess.stderr.on("data", (chunk) => appendLog("dsh:error", chunk));
    dshProcess.on("error", (error) => {
      appendLog("process", error.message);
      void showProcessError("无法启动 DeepSeek Harness", error);
    });
    dshProcess.on("exit", (code, signal) => {
      appendLog("process", `Exited with code ${code ?? "null"}, signal ${signal ?? "none"}`);

      if (!isQuitting) {
        const errorMessage = hasLoadedHarness
          ? `dsh process exited (code ${code ?? "unknown"}).`
          : `dsh process exited before startup (code ${code ?? "unknown"}).`;
        void showProcessError(
          hasLoadedHarness
            ? "DeepSeek Harness 已停止"
            : "DeepSeek Harness 启动失败",
          new Error(errorMessage)
        );
      }
    });

    await waitForDshStartup(dshProcess, dshUrl);
    await mainWindow.loadURL(dshUrl);
    hasLoadedHarness = true;
  } catch (error) {
    stopDshServer();
    await showProcessError("DeepSeek Harness 启动失败", error);
  }
}

Menu.setApplicationMenu(null);

app.whenReady().then(startApplication);

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createMainWindow().then(() => {
      if (dshUrl) {
        return mainWindow?.loadURL(dshUrl);
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

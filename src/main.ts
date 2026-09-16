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
import { BUNDLED_LOCAL_PROFILE_PLUGINS, ensureWebProfilePlugins } from "./dsh-profile.js";
import {
  DSH_RESTART_EXIT_CODE,
  preparePluginManagerEnvironment
} from "./dsh-plugins.js";
import { PetOverlayController } from "./pet-overlay.js";

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
 *
 * The strip is painted `WINDOW_CHROME_COLOR` and the native overlay is given
 * that same colour. Neither is optional: a reserved strip nobody paints shows
 * whatever the page happens to have behind it (dsh paints a light gradient
 * there), and the overlay is a second block around the buttons, so the window
 * ends up with a gradient band, a dark button block and the native glyphs — all
 * three unrelated. One colour makes the strip and its buttons read as a single
 * surface.
 */
const WINDOW_CHROME_HEIGHT = 32;
/** The surface dsh shows directly under the strip, so the two read as one. */
const WINDOW_CHROME_COLOR = "#232424";

const WINDOW_CHROME_CSS = `
  html::before {
    content: "";
    position: fixed;
    top: env(titlebar-area-y, 0px);
    left: env(titlebar-area-x, 0px);
    width: env(titlebar-area-width, calc(100% - 138px));
    height: env(titlebar-area-height, ${WINDOW_CHROME_HEIGHT}px);
    z-index: 2147483647;
    background: ${WINDOW_CHROME_COLOR};
    -webkit-app-region: drag;
  }

  body {
    box-sizing: border-box;
    padding-top: calc(
      env(titlebar-area-y, 0px) + env(titlebar-area-height, ${WINDOW_CHROME_HEIGHT}px)
    );
  }
`;

/**
 * Hides the in-window pet while the floating one is on screen.
 *
 * The live2d pet reaches the page as a plugin client, so the shell has no
 * handle on it; what it does have is a stable shape. The plugin renders into a
 * `popover` element it appends straight to `body` and puts its canvas inside
 * (`dsh-live2d-pets` client half, the top-layer container). Matching on that
 * shape keeps the settings panel — which is where the pet is configured — out
 * of the rule, and `:has()` is what distinguishes it from any other popover.
 *
 * Inserted only while the overlay is visible, so switching the overlay off from
 * the tray brings the in-window pet straight back.
 */
const IN_WINDOW_PET_HIDE_CSS = `
  body > div[popover]:has(canvas) {
    display: none !important;
  }
`;

let mainWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let dshProcess: ChildProcess | undefined;
let dshUrl: string | undefined;
let isQuitting = false;
let hasLoadedDsh = false;
const recentLogs: string[] = [];
/**
 * Bumped whenever the service is stopped or replaced. A start that is still
 * awaiting readiness compares its own generation and drops out instead of
 * loading a window that another start already owns.
 */
let dshGeneration = 0;
/** Prepared once after `ready`; `undefined` until then. */
let pluginManagerEnv: Record<string, string> | undefined;
let isRestartingDsh = false;
/** The floating desktop pet; `undefined` until the application starts. */
let petOverlay: PetOverlayController | undefined;
/**
 * Handle of the injected "hide the in-window pet" stylesheet. It dies with the
 * document, so every load starts from `undefined` again.
 */
let inWindowPetCssKey: string | undefined;

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
 * service starts. A launch has no package manager to call: Electron's Node
 * runtime ships neither npm nor corepack, and the bundled pnpm is only wired up
 * for the plugin manager's own installs. Failure is never fatal — the profile is
 * an enhancement, and the service still starts on whatever dsh finds.
 */
function ensureProfilePlugins(): void {
  try {
    const result = ensureWebProfilePlugins({
      localAdditions: BUNDLED_LOCAL_PROFILE_PLUGINS
    });
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

/**
 * Build the environment that lets the bundled plugin manager install plugins:
 * the pnpm shipped with this application, reached through a shim the dsh child
 * finds on `PATH`.
 *
 * Failure is not fatal — the service still starts, and the plugin card reports
 * that installation is unavailable — but it is worth a log line, because the
 * only realistic cause is a broken installation.
 */
function resolvePluginManagerEnv(): Record<string, string> {
  if (pluginManagerEnv !== undefined) {
    return pluginManagerEnv;
  }

  try {
    const { env, shimPath } = preparePluginManagerEnvironment({
      userDataDir: app.getPath("userData")
    });
    appendLog("plugins", Buffer.from(`pnpm shim: ${shimPath}`));
    pluginManagerEnv = env;
  } catch (error) {
    appendLog(
      "plugins",
      Buffer.from(`plugin installation unavailable: ${errorMessage(error)}`)
    );
    pluginManagerEnv = {};
  }

  return pluginManagerEnv;
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

/** Show the loading page and set its status line, whatever it currently shows. */
async function showLoadingPage(message: string): Promise<void> {
  const window = mainWindow;
  if (!window || window.isDestroyed()) {
    return;
  }

  if (window.webContents.getURL() !== LOADING_PAGE_URL) {
    await window.loadFile(LOADING_PAGE_PATH);
  }

  await updateLoadingStatus(message);
}

/**
 * Stop the service and invalidate any start still in flight.
 *
 * The reference is cleared before the kill so the exit handler can tell a
 * deliberate stop from a crash: the child it hears from is no longer the
 * current one, so it stays silent.
 */
function stopDshServer(): void {
  const child = dshProcess;
  dshProcess = undefined;
  dshGeneration += 1;

  // No service means no pet state: hide the floating pet until the next start
  // reports its URL. The window itself survives, so a restart is just a reload.
  void petOverlay?.setDshUrl(undefined);

  if (child && !child.killed) {
    child.kill();
  }
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
    // Inserted stylesheets do not survive a navigation, and installing a plugin
    // reloads this window onto a new origin.
    inWindowPetCssKey = undefined;
    void syncInWindowPet();
  });
}

/**
 * Keep the in-window pet hidden exactly while the floating one is showing.
 *
 * Both pets read the same plugin state, so leaving both visible would put two
 * copies of the same character on screen; hiding both would strand a user who
 * switched the overlay off in the tray.
 */
async function syncInWindowPet(): Promise<void> {
  const window = mainWindow;
  if (!window || window.isDestroyed()) {
    inWindowPetCssKey = undefined;
    return;
  }

  const shouldHide = petOverlay?.isVisible() === true;
  if (shouldHide && inWindowPetCssKey === undefined) {
    try {
      inWindowPetCssKey = await window.webContents.insertCSS(IN_WINDOW_PET_HIDE_CSS);
    } catch (error) {
      console.error("Failed to hide the in-window pet.", error);
    }
    return;
  }

  if (!shouldHide && inWindowPetCssKey !== undefined) {
    const key = inWindowPetCssKey;
    inWindowPetCssKey = undefined;
    try {
      await window.webContents.removeInsertedCSS(key);
    } catch {
      // The document that owned the key is gone; nothing left to remove.
    }
  }
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

/**
 * The tray menu owns the floating-pet switch.
 *
 * It is rebuilt on every toggle instead of mutating one item: `type: "checkbox"`
 * flips its own `checked` flag before the click handler runs, so reading the
 * controller afterwards is the only way to keep the checkbox and the actual
 * window state agreeing.
 */
function buildTrayMenu(): Menu {
  return Menu.buildFromTemplate([
    { label: "打开", click: showMainWindow },
    {
      label: "桌宠悬浮在桌面",
      type: "checkbox",
      checked: petOverlay?.isUserEnabled() === true,
      click: () => {
        if (!petOverlay) {
          return;
        }
        petOverlay.setUserEnabled(!petOverlay.isUserEnabled());
        tray?.setContextMenu(buildTrayMenu());
      }
    },
    { label: "关闭", click: quitApplication }
  ]);
}

function createTray(): void {
  const icon = nativeImage.createFromPath(APP_ICON_PATH);
  tray = new Tray(icon);
  tray.setToolTip(APP_NAME);
  tray.setContextMenu(buildTrayMenu());
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
      color: WINDOW_CHROME_COLOR,
      symbolColor: "#ffffff",
      height: WINDOW_CHROME_HEIGHT
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

/**
 * Start (or restart) the dsh service and load its Web UI into the window.
 *
 * Installing a plugin only takes effect at boot — a bundle joins the profile's
 * layer stack while dsh starts — so the plugin manager finishes by asking for a
 * restart, and this is the function that performs it. Every start captures a
 * generation token: one that has been superseded (by a restart, or by the user
 * quitting) stops touching shared state instead of racing the newer one.
 */
async function startDshService(): Promise<void> {
  const generation = (dshGeneration += 1);
  const workingDirectory = app.isPackaged
    ? app.getPath("documents")
    : process.cwd();

  // Re-ensure before every start, not only at application start: the profile is
  // what dsh composes its plugin layers from, and an install that replaced or
  // removed a managed plugin would otherwise only surface as a failed boot.
  ensureProfilePlugins();

  const port = await getAvailablePort(DSH_HOST);
  // Quitting can land while this start was waiting for a port, and a child
  // spawned after `before-quit` would outlive the application as an orphan
  // holding a port.
  if (isQuitting) {
    return;
  }

  dshUrl = `http://${DSH_HOST}:${port}`;
  const child = startDshServer({
    electronPath: process.execPath,
    cwd: workingDirectory,
    host: DSH_HOST,
    port,
    extraEnv: pluginManagerEnv
  });
  dshProcess = child;

  let dshOutput = "";
  let resolveDshUrl: ((url: string) => void) | undefined;
  const dshUrlReady = new Promise<string>((resolve) => {
    resolveDshUrl = resolve;
  });
  child.stdout?.on("data", (chunk: Buffer) => {
    appendLog("dsh", chunk);
    dshOutput += chunk.toString();
    const launchedUrl = extractDshUrl(dshOutput);
    if (launchedUrl) {
      dshUrl = launchedUrl;
      resolveDshUrl?.(launchedUrl);
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => appendLog("dsh:error", chunk));
  child.on("error", (error) => {
    if (child !== dshProcess) {
      return;
    }
    appendLog("process", Buffer.from(error.message));
    void showProcessError(`无法启动 ${APP_NAME}`, error);
  });
  child.on("exit", (code, signal) => {
    if (child !== dshProcess) {
      // A deliberate stop or a superseded start; neither is a failure.
      return;
    }
    dshProcess = undefined;
    appendLog(
      "process",
      Buffer.from(
        `Exited with code ${code ?? "null"}, signal ${signal ?? "none"}`
      )
    );

    if (isQuitting) {
      return;
    }

    if (code === DSH_RESTART_EXIT_CODE) {
      // The plugin manager asked for this: it answered the install request
      // first, then exited so the new bundle can be composed at boot.
      void restartDshService("已安装的插件需要重启服务");
      return;
    }

    const message = hasLoadedDsh
      ? `dsh process exited (code ${code ?? "unknown"}).`
      : `dsh process exited before startup (code ${code ?? "unknown"}).`;
    void showProcessError(
      hasLoadedDsh ? `${APP_NAME} 已停止` : `${APP_NAME} 启动失败`,
      new Error(message)
    );
  });

  await waitForDshStartup(child, dshUrl);
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
  if (generation !== dshGeneration) {
    return;
  }

  const window = mainWindow;
  if (!window || window.isDestroyed()) {
    return;
  }

  await window.loadURL(dshUrl);
  hasLoadedDsh = true;
  // Point the floating pet at this service. A restart takes a new port, so this
  // also reloads the overlay page onto the new origin.
  void petOverlay?.setDshUrl(dshUrl);
}

/**
 * Restart the service so an installed or removed plugin takes effect.
 *
 * The window returns to the loading page first: the old page's origin dies with
 * the child, and a renderer parked on a dead origin reads as a crash.
 */
async function restartDshService(reason: string): Promise<void> {
  if (isRestartingDsh || isQuitting) {
    return;
  }

  isRestartingDsh = true;
  appendLog("app", Buffer.from(`restarting the dsh service: ${reason}`));
  try {
    stopDshServer();
    await showLoadingPage(`正在重启 ${APP_NAME}…`);
    await startDshService();
  } catch (error) {
    appendLog("app", Buffer.from(`restart failed: ${errorMessage(error)}`));
    stopDshServer();
    if (!isQuitting) {
      await showProcessError(`${APP_NAME} 启动失败`, error);
    }
  } finally {
    isRestartingDsh = false;
  }
}

async function startApplication(): Promise<void> {
  createTray();

  petOverlay = new PetOverlayController({
    appRoot: app.getAppPath(),
    userDataDir: app.getPath("userData"),
    log: (message) => appendLog("pet", Buffer.from(message)),
    // Double click on the floating pet means "bring the client back".
    openClient: showMainWindow
  });
  petOverlay.onVisibilityChange(() => {
    void syncInWindowPet();
  });

  await createMainWindow();
  await updateLoadingStatus(`正在启动 ${APP_NAME}…`);
  // The profile and the plugin-manager environment are prepared inside
  // `startDshService`, so a restart after an install gets them again.
  resolvePluginManagerEnv();

  try {
    await startDshService();
  } catch (error) {
    stopDshServer();
    if (!isQuitting) {
      await showProcessError(`${APP_NAME} 启动失败`, error);
    }
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
  petOverlay?.dispose();
  petOverlay = undefined;
  stopDshServer();
});

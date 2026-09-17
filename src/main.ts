import { app, BrowserWindow, dialog, Menu, nativeImage, shell, Tray } from "electron";
import type { ChildProcess } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  getAvailablePort,
  extractDshUrl,
  startDshServer,
  waitForDshStartup
} from "./dsh-server.js";
import {
  BUNDLED_LOCAL_PROFILE_PLUGINS,
  ensureWebProfilePlugins,
  quarantineProfileBundles,
  readQuarantine,
  restoreQuarantinedBundles,
  thirdPartyProfileBundles
} from "./dsh-profile.js";
import {
  DSH_RESTART_EXIT_CODE,
  preparePluginManagerEnvironment
} from "./dsh-plugins.js";
import { PetOverlayController } from "./pet-overlay.js";

const DSH_HOST = "127.0.0.1";
const APP_NAME = "Harness Desktop";
const MAX_LOG_LINES = 80;
/**
 * How many plugin bundles one failing start chain may disable before the
 * failure is treated as this application's own.
 *
 * Each attempt costs one boot, and a failure that survives three of them is far
 * more likely to be this application's than the fourth plugin's. The budget is
 * per chain: a start that reaches the UI ends the chain and refills it, so a
 * later failure is not judged by how many plugins an earlier one ruled out.
 */
const MAX_QUARANTINE_ATTEMPTS = 3;
/**
 * How long a reachable dsh service has to report its authenticated URL.
 *
 * A healthy boot prints the URL the moment its port answers, so this ceiling is
 * never reached by one. A boot whose plugin layer stack cannot be composed
 * binds the port first and only then fails, and without this it would sit on the
 * loading page until {@link waitForDshStartup} — which has already accepted the
 * HTTP answer — ran out of its own, much longer, budget.
 */
const DSH_URL_GRACE_MS = 15_000;
/**
 * `--safe-mode` (or `HARNESS_DESKTOP_SAFE_MODE=1`) starts with every third-party
 * plugin bundle disabled — the escape hatch from a profile that cannot boot.
 * `--restore-plugins` puts back everything an earlier recovery disabled.
 */
const SAFE_MODE_REQUESTED =
  process.argv.includes("--safe-mode") ||
  process.env.HARNESS_DESKTOP_SAFE_MODE === "1";
const RESTORE_PLUGINS_REQUESTED =
  process.argv.includes("--restore-plugins") ||
  process.env.HARNESS_DESKTOP_RESTORE_PLUGINS === "1";
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
/** Whether this launch starts with third-party plugin bundles disabled. */
let safeMode = SAFE_MODE_REQUESTED;
let safeModeApplied = false;
/** Plugin bundles this launch disabled to get dsh up, and how many starts it took. */
let quarantinedThisRun: string[] = [];
/** Third-party bundles safe mode took out for this launch. */
let safeModeDisabledThisRun: string[] = [];
let quarantineAttempts = 0;
/**
 * Children whose failure the exit handler has taken over: the start that spawned
 * one of them must return quietly instead of racing the recovery with an error
 * page.
 */
const claimedFailures = new WeakSet<ChildProcess>();
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

    const quarantined = readQuarantine();
    if (quarantined !== undefined && quarantined.disabled.length > 0) {
      appendLog(
        "profile",
        Buffer.from(
          `disabled after an earlier start (${quarantined.reason}): ${quarantined.disabled.join(", ")}`
        )
      );
    }
  } catch (error) {
    appendLog(
      "profile",
      Buffer.from(`web profile plugin setup failed: ${errorMessage(error)}`)
    );
  }
}

/** The profile's third-party plugin bundles, or none when it cannot be read. */
function thirdPartyBundles(): string[] {
  try {
    return thirdPartyProfileBundles({
      localAdditions: BUNDLED_LOCAL_PROFILE_PLUGINS
    });
  } catch (error) {
    appendLog(
      "profile",
      Buffer.from(`could not read the profile's plugin bundles: ${errorMessage(error)}`)
    );
    return [];
  }
}

/**
 * Disable every third-party plugin bundle for this launch.
 *
 * A start that fails for a reason no single plugin explains still has an escape
 * hatch: dsh composes nothing but its own layers, which is enough to reach the
 * plugin manager and disable or remove whatever cannot be mounted.
 */
function applySafeMode(): void {
  if (!safeMode || safeModeApplied) {
    return;
  }

  safeModeApplied = true;
  const names = thirdPartyBundles();
  if (names.length === 0) {
    return;
  }

  const record = quarantineProfileBundles({
    names,
    reason: "safe-mode",
    localAdditions: BUNDLED_LOCAL_PROFILE_PLUGINS
  });
  if (record !== undefined) {
    // `names` is exactly what this call removed: they were read from the same
    // manifest moments ago, and safe mode removes every one of them.
    safeModeDisabledThisRun = names;
  }
  appendLog("profile", Buffer.from(`safe mode: disabled ${names.join(", ")}`));
}

/**
 * Take one third-party bundle out of the profile's layer stack and start again.
 *
 * dsh reports a plugin it cannot compose or import by failing to boot at all,
 * and the profile's layer list is the only lever this application has. Dropping
 * one bundle per attempt is what turns "dsh does not start" into "this plugin
 * does not start it" without guessing which one.
 *
 * @returns whether a retry was started.
 */
function retryWithoutOnePlugin(): boolean {
  if (isQuitting || quarantineAttempts >= MAX_QUARANTINE_ATTEMPTS) {
    return false;
  }

  const candidate = thirdPartyBundles()
    .filter((name) => !quarantinedThisRun.includes(name))
    .pop();
  if (candidate === undefined) {
    // Every candidate was already disabled and dsh still failed, so no plugin
    // explains this launch: leave the profile as the user had it.
    restoreRecoveryAttempts();
    return false;
  }

  const record = quarantineProfileBundles({
    names: [candidate],
    reason: "startup-failure",
    localAdditions: BUNDLED_LOCAL_PROFILE_PLUGINS
  });
  if (record === undefined) {
    return false;
  }

  quarantinedThisRun.push(candidate);
  quarantineAttempts += 1;
  appendLog(
    "profile",
    Buffer.from(
      `dsh failed before startup; disabled ${candidate} and retrying (${quarantineAttempts}/${MAX_QUARANTINE_ATTEMPTS})`
    )
  );
  void runDshRestart(`插件 ${candidate} 无法随当前 dsh 启动，已临时停用`);
  return true;
}

/**
 * Undo this launch's recoveries, for a failure no plugin candidate explains.
 *
 * Only the bundles this launch disabled are handed back: the record can also
 * hold removals an earlier launch made and reported, and those describe a
 * failure this launch never saw.
 */
function restoreRecoveryAttempts(): void {
  if (quarantinedThisRun.length === 0) {
    return;
  }

  const restored = restoreQuarantinedBundles({ names: quarantinedThisRun });
  appendLog(
    "profile",
    Buffer.from(
      `dsh failed with every candidate plugin disabled; restored ${restored.join(", ") || "nothing"}`
    )
  );
  quarantinedThisRun = [];
  quarantineAttempts = 0;
}

/**
 * Tell the user which plugins a start left behind.
 *
 * The removals are persisted, so silence would look like the plugins were
 * removed by something else. Reinstalling is the path back — `dsh plugin add`
 * puts a dependency's bundle back into the layer list — and it is also the
 * request whose declared peer ranges this application now restores.
 */
async function reportDisabledPlugins(): Promise<void> {
  const incompatible = [...quarantinedThisRun];
  const safeModeNames = [...safeModeDisabledThisRun];
  if (incompatible.length === 0 && safeModeNames.length === 0) {
    return;
  }

  quarantinedThisRun = [];
  safeModeDisabledThisRun = [];
  appendLog(
    "profile",
    Buffer.from(
      [
        incompatible.length > 0 ? `disabled to start: ${incompatible.join(", ")}` : "",
        safeModeNames.length > 0 ? `safe mode disabled: ${safeModeNames.join(", ")}` : ""
      ]
        .filter(Boolean)
        .join("; ")
    )
  );

  const detail: string[] = [];
  if (incompatible.length > 0) {
    detail.push(
      "以下插件无法随当前 dsh 启动，已从插件层里移除：",
      ...incompatible.map((name) => `  ${name}`),
      ""
    );
  }
  if (safeModeNames.length > 0) {
    detail.push(
      "本次以安全模式启动，以下插件层已全部停用：",
      ...safeModeNames.map((name) => `  ${name}`),
      ""
    );
  }
  detail.push(
    "重新安装插件即可再次尝试（安装时会自动补齐它声明的兼容依赖），"
      + "也可以用 --restore-plugins 一次恢复全部。"
  );

  const options = {
    type: "warning" as const,
    title: APP_NAME,
    message:
      incompatible.length > 0 ? "已停用无法随当前 dsh 启动的插件" : "已以安全模式启动",
    detail: detail.join("\n")
  };

  const window = mainWindow;
  if (window && !window.isDestroyed()) {
    await dialog.showMessageBox(window, options);
  } else {
    await dialog.showMessageBox(options);
  }
}

/**
 * Report a start no plugin candidate explains, and offer the safe-mode escape.
 *
 * The error page keeps the full log; the dialog is what makes the next step
 * obvious to someone who cannot read a stack trace.
 */
async function reportStartupFailure(code: number | null): Promise<void> {
  await showProcessError(
    `${APP_NAME} 启动失败`,
    new Error(`dsh process exited before startup (code ${code ?? "unknown"}).`)
  );

  if (isQuitting) {
    return;
  }

  const window = mainWindow;
  const options = {
    type: "error" as const,
    title: APP_NAME,
    message: `${APP_NAME} 无法启动`,
    detail: [
      ...recentLogs.slice(-12),
      "",
      "可以尝试以安全模式启动：本次启动会禁用全部第三方插件，之后能在插件管理器里逐个恢复。"
    ].join("\n"),
    buttons: ["以安全模式启动", "退出"],
    defaultId: 0,
    cancelId: 1
  };
  const { response } =
    window && !window.isDestroyed()
      ? await dialog.showMessageBox(window, options)
      : await dialog.showMessageBox(options);

  if (response !== 0 || isQuitting) {
    return;
  }

  safeMode = true;
  safeModeApplied = false;
  void runDshRestart("以安全模式启动");
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
  applySafeMode();

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

  // Per start, not per process: a plugin install restarts the service in the
  // same process, and the failure the recovery exists for is the *restart*
  // never reaching the UI. A flag that survives the restart would classify it
  // as a crash after startup and skip the recovery entirely.
  let uiLoaded = false;
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
    // The exit handler owns this failure from here on: the start that spawned
    // this child must not also report it while a recovery is starting again.
    claimedFailures.add(child);
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

    if (!uiLoaded) {
      // A failure before this start reported its URL is the shape a plugin that
      // cannot be composed or imported has; a crash after the UI loaded is not.
      if (retryWithoutOnePlugin()) {
        return;
      }
      void reportStartupFailure(code);
      return;
    }

    const message = `dsh process exited (code ${code ?? "unknown"}).`;
    void showProcessError(`${APP_NAME} 已停止`, new Error(message));
  });

  try {
    await waitForDshStartup(child, dshUrl);
  } catch (error) {
    // A claimed failure already has an owner: either a plugin restart, or a
    // recovery that is starting the service again. Reporting it here too would
    // race that new start with an error page.
    if (claimedFailures.has(child)) {
      return;
    }
    throw error;
  }
  if (!dshUrl.includes("?token=")) {
    try {
      await Promise.race([
        dshUrlReady,
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("dsh did not report its authenticated Web URL.")),
            DSH_URL_GRACE_MS
          )
        )
      ]);
    } catch (error) {
      // A reachable service that never reports its URL is the same failure as a
      // start that exits before startup, only reported later: the plugin layer
      // stack bound the port and then failed. It has to reach the recovery the
      // exit path runs, because the child is still alive here — nothing else
      // will notice its failure, and this used to end at an error page with the
      // offending plugin still in the profile.
      if (claimedFailures.has(child) || generation !== dshGeneration || isQuitting) {
        // The exit handler or a newer start owns this window already.
        return;
      }

      stopDshServer();
      if (retryWithoutOnePlugin()) {
        return;
      }

      throw error;
    }
  }
  if (generation !== dshGeneration) {
    return;
  }

  const window = mainWindow;
  if (!window || window.isDestroyed()) {
    return;
  }

  await window.loadURL(dshUrl);
  uiLoaded = true;
  // This chain ended: a later failure gets the full recovery budget again.
  quarantineAttempts = 0;
  // The UI is up: say which plugins this start had to leave behind.
  void reportDisabledPlugins();
  // Point the floating pet at this service. A restart takes a new port, so this
  // also reloads the overlay page onto the new origin.
  void petOverlay?.setDshUrl(dshUrl);
}

/**
 * Restart the service so an installed or removed plugin takes effect.
 *
 * The window returns to the loading page first: the old page's origin dies with
 * the child, and a renderer parked on a dead origin reads as a crash.
 *
 * This guard covers this caller alone. A recovery retry restarts through
 * {@link runDshRestart} directly, because the attempt it recovers from *is* the
 * restart that failed — a guard shared with it would stop the second plugin of
 * a failed start from ever being ruled out.
 */
async function restartDshService(reason: string): Promise<void> {
  if (isRestartingDsh || isQuitting) {
    return;
  }

  isRestartingDsh = true;
  try {
    await runDshRestart(reason);
  } finally {
    isRestartingDsh = false;
  }
}

/** Stop, show the loading page, and start again: every restart path shares this. */
async function runDshRestart(reason: string): Promise<void> {
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

  if (RESTORE_PLUGINS_REQUESTED) {
    try {
      const restored = restoreQuarantinedBundles();
      appendLog(
        "profile",
        Buffer.from(
          `restored plugin bundles: ${restored.join(", ") || "(none were disabled)"}`
        )
      );
    } catch (error) {
      appendLog(
        "profile",
        Buffer.from(`restoring plugin bundles failed: ${errorMessage(error)}`)
      );
    }
  }

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

import path from "node:path";
import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from "electron";
import { resolveDshHome } from "./dsh-profile.js";
import {
  buildModlensConfigArgs,
  describeModlensDoctor,
  normalizeModlensChanges,
  resolveModlensCliCandidates,
  runModlensCli,
  type ModlensDoctor
} from "./modlens-cli.js";

/**
 * The settings window for the vision plugin this application pre-installs.
 *
 * The plugin ships its own settings card, but that card is a browser-side slot
 * registration, and this dsh release replaced the seat it registered into
 * (`settings.plugin.item` became feature-owned `settings.plugins.tab`), so the
 * card no longer mounts anywhere. Its *host* half is unaffected — the read-image
 * tool, the vision provider, and the paste-to-path route all come up without a
 * warning — so what is missing is only a way to reach the settings.
 *
 * Those settings are a JSON file the plugin owns, and this window never touches
 * it: the page renders what `modlens doctor --json` reports and writes through
 * `modlens config set`, both on this application's Electron binary (a packaged
 * build has no system Node), the same way the pnpm shim runs pnpm.
 */

/** What the page renders: the report, the masked settings, and where they live. */
export interface ModlensLoadResult {
  available: boolean;
  /** Why the page cannot do anything, when `available` is false. */
  reason?: string;
  /** The CLI this page drives, so the window can say which copy answered. */
  cliPath?: string;
  /** `config show` output, already masked by the CLI. */
  settings?: string;
  doctor?: ModlensDoctor;
  /** The raw report, when this module could not read it into a view. */
  raw?: string;
}

export interface ModlensSaveResult {
  /** Keys the CLI accepted, in order. */
  applied: string[];
  /** Keys it refused, with what it printed. */
  failed: { key: string; detail: string }[];
  reload?: ModlensLoadResult;
}

export interface ModlensConfigDeps {
  /** Application root; the page and its preload live in `<appRoot>/src`. */
  appRoot: string;
  /** dsh home holding the profile whose copy of the plugin is running. */
  home?: string;
  /** Executable that runs the CLI as Node; defaults to the current process. */
  electronPath?: string;
  /** Diagnostic sink, wired to the application's log buffer. */
  log: (message: string) => void;
}

/**
 * Owns the window: the CLI it drives, the page, and its IPC.
 *
 * One instance per application, opened from the tray. The window is destroyed
 * when it closes, so every open re-reads the report instead of showing a stale
 * one.
 */
export class ModlensConfigWindow {
  private readonly deps: ModlensConfigDeps;
  private window: BrowserWindow | undefined;
  /** The CLI copy that answered last, so a save writes with the one that read. */
  private cliPath: string | undefined;
  private readonly ipcHandlers: Array<
    [string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown]
  > = [];

  constructor(deps: ModlensConfigDeps) {
    this.deps = deps;
    this.registerIpc();
  }

  /** The window, reusing the open one so a second tray click only focuses it. */
  open(): void {
    if (this.window !== undefined && !this.window.isDestroyed()) {
      this.window.show();
      this.window.focus();
      return;
    }

    const window = new BrowserWindow({
      width: 720,
      height: 780,
      minWidth: 560,
      minHeight: 520,
      title: "视觉引擎（ModLens）",
      backgroundColor: "#15171a",
      show: false,
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(this.deps.appRoot, "src", "modlens-config-preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });

    this.window = window;
    window.once("ready-to-show", () => window.show());
    window.on("closed", () => {
      if (this.window === window) {
        this.window = undefined;
      }
    });
    window.webContents.on("render-process-gone", (_event, details) => {
      this.deps.log(`modlens config: renderer gone (${details.reason})`);
    });

    void window.loadFile(path.join(this.deps.appRoot, "src", "modlens-config.html"));
  }

  dispose(): void {
    for (const [channel, handler] of this.ipcHandlers) {
      ipcMain.removeHandler(channel);
      ipcMain.removeListener(channel, handler);
    }
    this.ipcHandlers.length = 0;

    const window = this.window;
    this.window = undefined;
    if (window !== undefined && !window.isDestroyed()) {
      window.destroy();
    }
  }

  // ------------------------------------------------------------------- ipc --

  private registerIpc(): void {
    const handle = (
      channel: string,
      handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>
    ): void => {
      const wrapped = (event: IpcMainInvokeEvent, ...args: unknown[]): Promise<unknown> => {
        const window = this.window;
        if (window === undefined || window.isDestroyed() || event.sender !== window.webContents) {
          return Promise.reject(new Error(`${channel} came from outside this window`));
        }
        return handler(event, ...args);
      };
      ipcMain.handle(channel, wrapped);
      this.ipcHandlers.push([channel, wrapped]);
    };

    handle("modlens:load", () => this.load());
    handle("modlens:save", (_event, changes) => this.save(changes));
    handle("modlens:close", () => {
      this.window?.close();
      return Promise.resolve(undefined);
    });
  }

  private cliCandidates(): string[] {
    return resolveModlensCliCandidates({ home: this.deps.home ?? resolveDshHome() });
  }

  /**
   * The report and the masked settings, as one load for the page.
   *
   * The copies are tried in order and the first one that answers is kept: a
   * profile copy this application wrote by hand has no dependencies beside it
   * until pnpm has run there, so on a first launch only the bundled copy can
   * start. A failure is remembered as a short tail rather than the whole Node
   * stack the CLI prints.
   */
  private async load(): Promise<ModlensLoadResult> {
    const electronPath = this.deps.electronPath ?? process.execPath;
    const candidates = this.cliCandidates();
    if (candidates.length === 0) {
      return {
        available: false,
        reason: "找不到 @liustack/modlens 的命令行入口（既不在 profile 里，也不是本应用的依赖）。"
      };
    }

    let lastFailure = "";
    for (const candidate of candidates) {
      try {
        const [settings, doctor] = await Promise.all([
          runModlensCli(["config", "show"], { cliPath: candidate, electronPath }),
          runModlensCli(["doctor", "--json"], { cliPath: candidate, electronPath })
        ]);
        if (doctor.code !== 0) {
          lastFailure = tail(doctor.output);
          this.deps.log(
            `modlens config: ${candidate} could not report (exit ${String(doctor.code)})`
          );
          continue;
        }

        const report = describeModlensDoctor(doctor.output);
        if (report === undefined) {
          lastFailure = tail(doctor.output);
          this.deps.log(`modlens config: ${candidate} did not answer with JSON`);
          continue;
        }

        this.cliPath = candidate;
        return { available: true, cliPath: candidate, settings: settings.output.trim(), doctor: report };
      } catch (error) {
        lastFailure = describe(error);
        this.deps.log(`modlens config: running ${candidate} failed (${describe(error)})`);
      }
    }

    return {
      available: false,
      reason: `modlens 命令行没有可用副本。最后一次输出：${lastFailure || "(空)"}`,
      raw: lastFailure
    };
  }

  /** Write the changed settings, then report the state they produced. */
  private async save(value: unknown): Promise<ModlensSaveResult> {
    const electronPath = this.deps.electronPath ?? process.execPath;
    const changes = normalizeModlensChanges(value);
    const applied: string[] = [];
    const failed: { key: string; detail: string }[] = [];

    // A save before a load writes with the copy the page is showing; without
    // one, the same order the load uses decides.
    if (this.cliPath === undefined) {
      const loaded = await this.load();
      if (!loaded.available || loaded.cliPath === undefined) {
        return { applied, failed: [{ key: "", detail: loaded.reason ?? "找不到可用的 modlens 命令行。" }] };
      }
    }

    const cliPath = this.cliPath as string;
    for (const change of changes) {
      try {
        const result = await runModlensCli(buildModlensConfigArgs(change), {
          cliPath,
          electronPath,
          secret: change.secret === true ? change.value : undefined
        });
        if (result.code === 0) {
          // The key only: a secret never reaches the log.
          applied.push(change.key);
        } else {
          failed.push({
            key: change.key,
            detail: tail(result.output) || `退出码 ${String(result.code)}`
          });
        }
      } catch (error) {
        failed.push({ key: change.key, detail: describe(error) });
      }
    }

    if (applied.length > 0) {
      this.deps.log(`modlens config: saved ${applied.join(", ")}`);
    }
    if (failed.length > 0) {
      this.deps.log(`modlens config: refused ${failed.map((entry) => entry.key).join(", ")}`);
    }

    return { applied, failed, reload: await this.load() };
  }
}

/** The end of a failed command's output: the message, not the whole stack. */
function tail(output: string, limit = 400): string {
  const text = output.trim();
  return text.length > limit ? `…${text.slice(text.length - limit)}` : text;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

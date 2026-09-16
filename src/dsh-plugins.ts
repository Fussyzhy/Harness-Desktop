import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { WEB_PROFILE_NAME, resolveDshHome } from "./dsh-profile.js";
import { resolveAsarUnpackedPath, resolveDshCliPath } from "./dsh-server.js";

/**
 * Installing a plugin is the one thing this application cannot do on its own:
 * `dsh plugin` is a thin pnpm forwarder, and neither npm nor corepack — let
 * alone a `pnpm` on PATH — exists on a user's machine. The pieces here make the
 * official `dsh plugin` command runnable inside a packaged build:
 *
 * 1. resolve the pnpm shipped in this application's dependencies,
 * 2. write a `pnpm` shim (Windows: `pnpm.cmd`) that starts it on Electron's
 *    Node runtime, and
 * 3. hand the bundled plugin manager the environment it needs to call that
 *    shim, so the work itself stays upstream's (`initProfile` + pnpm +
 *    `dsh.profile.bundles` reconciliation).
 *
 * Nothing here touches the network or the profile: it only prepares paths.
 */

/**
 * Exit code the dsh child uses to ask the desktop shell for a clean restart.
 *
 * A plugin only becomes a profile layer when the dsh process starts, so the
 * plugin manager cannot finish its job by itself. It responds to the install
 * request first and then exits with this code; the shell restarts the service
 * instead of showing the "unexpected exit" error page.
 */
export const DSH_RESTART_EXIT_CODE = 77;

/**
 * Environment keys the shell passes to the dsh child. The bundled plugin
 * manager reads them and falls back to clear errors when it runs outside this
 * application (a plain `dsh` on PATH has no bundled pnpm to call).
 */
export const PLUGIN_MANAGER_ENV_KEYS = {
  /** Absolute path of pnpm's CLI entry (`pnpm/bin/pnpm.cjs`). */
  pnpmScript: "HARNESS_DESKTOP_PNPM_SCRIPT",
  /** Absolute path of `@deepseek-ai/dsh`'s CLI entry (`lib/bin.js`). */
  dshCli: "HARNESS_DESKTOP_DSH_CLI",
  /** Electron executable that runs both of the above as Node. */
  electron: "HARNESS_DESKTOP_ELECTRON",
  /** Content-addressed pnpm store, kept inside the dsh home. */
  storeDir: "HARNESS_DESKTOP_PNPM_STORE_DIR",
  /** Directory holding the `pnpm` shim, prepended to `PATH`. */
  shimDir: "HARNESS_DESKTOP_PNPM_SHIM_DIR",
  /** Restart handshake; mirrors {@link DSH_RESTART_EXIT_CODE}. */
  restartExitCode: "HARNESS_DESKTOP_RESTART_EXIT_CODE"
} as const;

/** What `dsh plugin` may be asked to do with the `web` profile. */
export type DshPluginAction = "add" | "remove" | "update";

/** A `require` function, narrowed for testability. */
export interface RequireLike {
  resolve: (id: string) => string;
}

/** Environment and paths handed to the bundled plugin manager. */
export interface PluginManagerEnvironment {
  /** Extra environment for the dsh child process. */
  env: Record<string, string>;
  /** pnpm CLI entry point, already mapped into `app.asar.unpacked`. */
  pnpmScript: string;
  /** The `pnpm` shim the dsh child finds on `PATH`. */
  shimPath: string;
  /** pnpm store, shared by every plugin installation. */
  storeDir: string;
}

export interface PreparePluginManagerOptions {
  /** Writable application data directory; the shim lives in `<dir>/bin`. */
  userDataDir: string;
  /** Executable that runs pnpm as Node; defaults to the current process. */
  electronPath?: string;
  /** dsh CLI entry; defaults to the installed package's. */
  dshCliPath?: string;
  /** pnpm CLI entry; defaults to the bundled package's. */
  pnpmScript?: string;
  /** dsh home holding the `web` profile; defaults to dsh's own resolution. */
  dshHome?: string;
  /** Platform selector, so the shim can be tested on any host. */
  platform?: NodeJS.Platform;
  /** Value prepended with the shim directory; defaults to `process.env.PATH`. */
  currentPath?: string;
  /** Environment whose `PATH` casing is reused; defaults to `process.env`. */
  baseEnv?: NodeJS.ProcessEnv;
}

/**
 * pnpm's manifest exports only `"."` → `./package.json`, so the package
 * directory is resolved through the bare specifier and the CLI entry is joined
 * onto it. The result is mapped into `app.asar.unpacked`, because the shim runs
 * it as a real file in a child process.
 */
export function resolvePnpmScriptPath(
  requireFn: RequireLike = createRequire(import.meta.url)
): string {
  let resolved: string;
  try {
    resolved = requireFn.resolve("pnpm");
  } catch (error) {
    throw new Error(
      "The bundled pnpm package is missing from this installation.",
      { cause: error }
    );
  }

  const scriptPath =
    path.basename(resolved) === "pnpm.cjs"
      ? resolved
      : path.join(path.dirname(resolved), "bin", "pnpm.cjs");

  if (!existsSync(scriptPath)) {
    throw new Error(`The bundled pnpm CLI entry is missing at ${scriptPath}.`);
  }

  return resolveAsarUnpackedPath(scriptPath);
}

/**
 * Write the `pnpm` shim that makes `spawnSync("pnpm", …)` — which is exactly
 * what `dsh plugin` does, with `shell: true` on Windows — resolve to the
 * bundled pnpm on Electron's Node runtime.
 *
 * The shim is written outside the application directory: a packaged install
 * lives under `Program Files`, and `app.asar` is not a directory a shell can
 * execute from.
 *
 * @returns the absolute path of the written shim.
 */
export function createPnpmShim(
  shimDir: string,
  {
    pnpmScript,
    electronPath,
    platform = process.platform
  }: {
    pnpmScript: string;
    electronPath: string;
    platform?: NodeJS.Platform;
  }
): string {
  mkdirSync(shimDir, { recursive: true });

  const windows = platform === "win32";
  const shimPath = path.join(shimDir, windows ? "pnpm.cmd" : "pnpm");
  const contents = windows
    ? [
        "@echo off",
        'set "ELECTRON_RUN_AS_NODE=1"',
        `"${electronPath}" "${pnpmScript}" %*`,
        ""
      ].join("\r\n")
    : [
        "#!/bin/sh",
        `ELECTRON_RUN_AS_NODE=1 exec "${electronPath}" "${pnpmScript}" "$@"`,
        ""
      ].join("\n");

  let current: string | undefined;
  try {
    current = readFileSync(shimPath, "utf8");
  } catch {
    current = undefined;
  }

  if (current !== contents) {
    writeFileSync(shimPath, contents);
  }
  if (!windows) {
    chmodSync(shimPath, 0o755);
  }

  return shimPath;
}

/** Build the environment handed to the dsh child process. */
export function buildPluginManagerEnv({
  pnpmScript,
  dshCliPath,
  electronPath,
  storeDir,
  shimDir,
  restartExitCode = DSH_RESTART_EXIT_CODE
}: {
  pnpmScript: string;
  dshCliPath: string;
  electronPath: string;
  storeDir: string;
  shimDir: string;
  restartExitCode?: number;
}): Record<string, string> {
  return {
    [PLUGIN_MANAGER_ENV_KEYS.pnpmScript]: pnpmScript,
    [PLUGIN_MANAGER_ENV_KEYS.dshCli]: dshCliPath,
    [PLUGIN_MANAGER_ENV_KEYS.electron]: electronPath,
    [PLUGIN_MANAGER_ENV_KEYS.storeDir]: storeDir,
    [PLUGIN_MANAGER_ENV_KEYS.shimDir]: shimDir,
    [PLUGIN_MANAGER_ENV_KEYS.restartExitCode]: String(restartExitCode)
  };
}

/**
 * Prepare everything the dsh child needs to run `dsh plugin`: the shim on disk,
 * the store directory inside the dsh home, and the environment block that
 * carries both to the bundled plugin manager (with the shim directory first on
 * `PATH`).
 */
export function preparePluginManagerEnvironment({
  userDataDir,
  electronPath = process.execPath,
  dshCliPath = resolveDshCliPath(),
  pnpmScript = resolvePnpmScriptPath(),
  dshHome = resolveDshHome(),
  platform = process.platform,
  currentPath,
  baseEnv = process.env
}: PreparePluginManagerOptions): PluginManagerEnvironment {
  const shimDir = path.join(userDataDir, "bin");
  const storeDir = path.join(dshHome, ".pnpm-store");
  const shimPath = createPnpmShim(shimDir, {
    pnpmScript,
    electronPath,
    platform
  });

  // Windows environment variables are case-insensitive but Node's env object is
  // not, so the existing spelling wins: `Path` and `PATH` as two entries would
  // silently drop one of them.
  const pathKey =
    Object.keys(baseEnv).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const inherited = currentPath ?? baseEnv[pathKey] ?? "";
  const env = buildPluginManagerEnv({
    pnpmScript,
    dshCliPath,
    electronPath,
    storeDir,
    shimDir
  });
  env[pathKey] = inherited
    ? `${shimDir}${path.delimiter}${inherited}`
    : shimDir;

  return { env, pnpmScript, shimPath, storeDir };
}

/**
 * Arguments for one `dsh plugin` invocation.
 *
 * `--workspace-root` is not optional: a profile is a pnpm workspace root (its
 * generated `pnpm-workspace.yaml` lists `packages: - .`), and pnpm refuses to
 * add a registry package to a workspace root unless it is asked explicitly. dsh
 * passes every argument after the profile through to pnpm verbatim, so the flag
 * has to be built here — without it every install from the registry fails with
 * `ERR_PNPM_ADDING_TO_ROOT`. Local paths and `link:` specs are exempt from that
 * check, so a probe that installs a local plugin does not catch the omission.
 *
 * `--store-dir` is forwarded the same way, which keeps the profile's store
 * inside the dsh home instead of a pnpm installation the user may not have.
 *
 * `specs` arrives already split and validated by the card (one entry per item);
 * every entry becomes one pnpm argument, so a single run can install a plugin
 * together with the `link:` companions its peers need.
 *
 * The bundled `@harness-desktop/dsh-plugin-manager` builds this same command
 * inside the dsh process and is what the settings card actually calls; this is
 * the shell-side spelling of it, kept as the written contract for the argument
 * shape (and exercised by tests) so the two cannot drift apart unnoticed.
 */
export function buildDshPluginArguments(
  {
    action,
    specs,
    storeDir
  }: { action: DshPluginAction; specs?: readonly string[]; storeDir?: string },
  profileName: string = WEB_PROFILE_NAME
): string[] {
  const forwarded: string[] = [action, "--workspace-root", ...(specs ?? [])];
  if (storeDir !== undefined && storeDir.length > 0) {
    forwarded.push("--store-dir", storeDir);
  }

  return ["plugin", "--profile", profileName, ...forwarded];
}

export interface RunDshPluginOptions {
  electronPath: string;
  dshCliPath: string;
  /** Environment carrying the pnpm shim on `PATH`; see {@link preparePluginManagerEnvironment}. */
  env: Record<string, string>;
  /** Kill the command after this long; defaults to five minutes. */
  timeoutMs?: number;
  /** Working directory; defaults to the profile's parent expectations (cwd). */
  cwd?: string;
}

export interface DshPluginRunResult {
  code: number | null;
  /** Everything the command wrote, stdout and stderr interleaved. */
  output: string;
  timedOut: boolean;
}

/**
 * Run one `dsh plugin` command to completion.
 *
 * `windowsHide` is not optional: the desktop process has no console, so without
 * it Windows gives every console-subsystem child a brand-new visible one.
 *
 * Installations go through the bundled plugin manager inside the dsh process, so
 * nothing calls this today; it is the shell-side counterpart of that call, for
 * the day a boot that a bad plugin broke has to be repaired from the error page,
 * where the settings card is out of reach.
 */
export function runDshPluginCommand(
  args: readonly string[],
  {
    electronPath,
    dshCliPath,
    env,
    timeoutMs = 300_000,
    cwd
  }: RunDshPluginOptions
): Promise<DshPluginRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(electronPath, [dshCliPath, ...args], {
      cwd,
      env: {
        ...process.env,
        ...env,
        ELECTRON_RUN_AS_NODE: "1",
        NO_COLOR: "1"
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });

    let output = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output, timedOut });
    });
  });
}

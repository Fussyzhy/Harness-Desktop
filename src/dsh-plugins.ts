import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { resolveDshHome } from "./dsh-profile.js";
import { resolveAsarUnpackedPath } from "./dsh-server.js";

/**
 * Installing a plugin is the one thing this application cannot do on its own:
 * dsh's plugin manager is a thin pnpm forwarder, and neither npm nor corepack —
 * let alone a `pnpm` on PATH — exists on a user's machine. The pieces here make
 * that forwarder runnable inside a packaged build:
 *
 * 1. resolve the pnpm shipped in this application's dependencies,
 * 2. write a `pnpm` shim (Windows: `pnpm.cmd`) that starts it on Electron's
 *    Node runtime, and
 * 3. hand the dsh child the environment that puts that shim on `PATH` together
 *    with the pnpm settings a profile install needs.
 *
 * Nothing here touches the network or the profile: it only prepares paths.
 */

/**
 * Exit code a dsh child uses to ask the desktop shell for a clean restart.
 *
 * A new bundle only becomes a profile layer when the dsh process starts, so a
 * child that changed one answers its caller first and then exits with this code;
 * the shell restarts the service instead of showing the "unexpected exit" error
 * page.
 */
export const DSH_RESTART_EXIT_CODE = 77;

/**
 * pnpm configuration the shell adds to the dsh child's environment, which dsh's
 * plugin manager hands on to pnpm by inheritance.
 *
 * `auto-install-peers=false` is the setting dsh's own profile template asks for
 * in `pnpm-workspace.yaml`, repeated here because that is not a file pnpm reads
 * it from: the bundled pnpm 10.4.0 ignores `autoInstallPeers` in a workspace
 * file and takes the value only from `.npmrc` or the `npm_config_*`
 * environment. Without it, an install satisfies every missing peer from the
 * registry by its `latest` tag — so a plugin that declares the framework
 * packages it peers on as `"*"` resolves them to the prerelease line's stale
 * `latest`, whose own dependencies are no longer published, and the install
 * fails with `ERR_PNPM_FETCH_404` before it adds anything. Those peers are
 * provided by the running installation, so pnpm must not look for them.
 *
 * `ignore-workspace-root-check=true` answers a different refusal: every profile
 * is a pnpm workspace root (its `pnpm-workspace.yaml` lists `packages: - .`),
 * and pnpm adds a *registry* package to a workspace root only when it is asked
 * to explicitly. The official plugin manager runs `pnpm add <spec>` with no
 * such flag, so without this setting every install from a registry fails with
 * `ERR_PNPM_ADDING_TO_ROOT`. Only a local, `link:`, or `file:` spec is exempt —
 * which is why an install of a local probe never met the rule. The switch is
 * turned off here rather than by patching the upstream command line, which is
 * shared with `remove` and `view`, where `--workspace-root` means nothing.
 *
 * This environment is the lever that reaches every profile, including ones this
 * application does not prepare: the manager runs pnpm with
 * `scrubbedParentEnv()`, which strips only `DSH_*` and names matching
 * `/KEY|PASSWORD|SECRET|TOKEN/i`, so `npm_config_*` survives. The profile's own
 * `.npmrc` carries the same two settings for a pnpm that never sees this
 * environment (a `dsh plugin` typed into a terminal).
 */
export const PNPM_CONFIG_ENV: Readonly<Record<string, string>> = {
  "npm_config_auto_install_peers": "false",
  "npm_config_ignore_workspace_root_check": "true"
};

/** A `require` function, narrowed for testability. */
export interface RequireLike {
  resolve: (id: string) => string;
}

/** Environment and paths handed to the dsh child process. */
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
 * what dsh's plugin manager does, with `shell: true` on Windows — resolve to the
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

/**
 * Prepare everything the dsh child needs to run a plugin install: the shim on
 * disk, the store directory inside the dsh home, and the environment block that
 * carries both to pnpm (with the shim directory first on `PATH`).
 *
 * The store is passed as a setting rather than a command-line flag because the
 * plugin manager builds its own argument list and this application cannot add
 * to it: without `npm_config_store_dir`, installs would land in whatever store
 * pnpm picks for itself, re-unpacking every package the previous store already
 * held.
 */
export function preparePluginManagerEnvironment({
  userDataDir,
  electronPath = process.execPath,
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

  const env: Record<string, string> = {
    ...PNPM_CONFIG_ENV,
    "npm_config_store_dir": storeDir
  };

  // Windows environment variables are case-insensitive but Node's env object is
  // not, so the existing spelling wins: `Path` and `PATH` as two entries would
  // silently drop one of them.
  const pathKey =
    Object.keys(baseEnv).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const inherited = currentPath ?? baseEnv[pathKey] ?? "";
  env[pathKey] = inherited
    ? `${shimDir}${path.delimiter}${inherited}`
    : shimDir;

  return { env, pnpmScript, shimPath, storeDir };
}

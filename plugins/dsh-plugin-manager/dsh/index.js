/**
 * Harness Desktop's plugin manager — host half.
 *
 * A packaged Harness Desktop has no npm, no corepack, and no `pnpm` on PATH, so
 * `dsh plugin` cannot run on a user's machine by itself. The desktop shell
 * therefore ships pnpm in its own dependencies, writes a `pnpm` shim into its
 * user-data directory, puts that directory first on this process's PATH, and
 * passes the paths below through the environment (see `src/dsh-plugins.ts` in
 * the application repository).
 *
 * This half does no package management of its own. It spawns the official
 * `dsh plugin` command, which initialises the profile if needed, forwards the
 * arguments to pnpm, and reconciles `dsh.profile.bundles` against what is
 * actually installed — so aliases, tarballs, local paths, git specs, transitive
 * dependencies and version conflicts all behave exactly as they do on the
 * command line.
 *
 * Installing a plugin rewrites the profile manifest, and dsh reads that manifest
 * exactly once, while it boots: a plugin only becomes a profile layer after the
 * dsh process restarts. That restart belongs to the shell, so the last thing
 * this half does is answer the request and then exit with the restart code the
 * shell recognises.
 *
 * @module @harness-desktop/dsh-plugin-manager
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const name = "harness-desktop-plugin-manager";

/** Both services this plugin needs are optional and taken by scoped injection. */
export const inject = [];

/**
 * The settings namespace the browser half's card is dispatched by.
 *
 * dsh renders a plugin card only when its `key` matches a settings namespace the
 * host answers for, so this constant is a contract with `dsh/client.js`: one
 * value, two files.
 */
const SETTINGS_NAMESPACE = "harness-desktop-plugins";

/** Where the browser half talks to this half. */
const ROUTE_PATH = "/harness-desktop/plugins";

/** The package directory: this file is `<package>/dsh/index.js`. */
const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The profile this plugin was installed into: the shell copies the package to
 * `<profile>/node_modules/@harness-desktop/dsh-plugin-manager`.
 *
 * Deriving it beats hardcoding `web`: the profile name is what dsh is asked to
 * manage, and the package already knows which one it is mounted from.
 */
const PROFILE_DIR = resolve(PACKAGE_DIR, "..", "..", "..");
const PROFILE_NAME = basename(PROFILE_DIR) || "web";

/** How long one package-manager run may take before it is killed. */
const COMMAND_TIMEOUT_MS = 300_000;

/**
 * Package specs are forwarded verbatim, so they may not look like flags. One
 * install often needs several (`link:` companions satisfy peers a registry
 * install cannot resolve), which is why the input is split before this check
 * runs: every item is still validated on its own.
 */
const PACKAGE_SPEC = /^(?!-)[^\s]{1,200}$/;

/** One input box, several specs: separated by whitespace or commas. */
const SPEC_SEPARATOR = /[\s,]+/;

function splitSpecs(value) {
  return value
    .split(SPEC_SEPARATOR)
    .filter((spec) => spec.length > 0);
}

const SPEC_REQUIRED =
  "a package name, version, path, or URL is required";
const SPEC_SHAPE = "a package name, version, path, or URL";

function environment() {
  return {
    pnpmScript: process.env.HARNESS_DESKTOP_PNPM_SCRIPT ?? "",
    dshCli: process.env.HARNESS_DESKTOP_DSH_CLI ?? "",
    electron: process.env.HARNESS_DESKTOP_ELECTRON ?? process.execPath,
    storeDir: process.env.HARNESS_DESKTOP_PNPM_STORE_DIR ?? "",
    shimDir: process.env.HARNESS_DESKTOP_PNPM_SHIM_DIR ?? "",
    restartExitCode: Number(
      process.env.HARNESS_DESKTOP_RESTART_EXIT_CODE ?? "77"
    )
  };
}

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return undefined;
  }
}

function readProfileManifest() {
  return readJson(join(PROFILE_DIR, "package.json")) ?? {};
}

/** What is known about one plugin, from the manifest and its installed copy. */
function describePlugin(packageName, dependencies, bundles) {
  const manifest = readJson(
    join(PROFILE_DIR, "node_modules", packageName, "package.json")
  );

  return {
    name: packageName,
    version: typeof manifest?.version === "string" ? manifest.version : null,
    /** A bundle joins the profile's layer stack; a plain dependency does not. */
    bundle: manifest?.dsh?.bundle?.patch !== undefined,
    installed: manifest !== undefined,
    /**
     * pnpm writes a dependency entry for everything it installs. The bundles
     * this application ships itself are copied into the profile instead, so a
     * mounted plugin without a dependency entry is a built-in one.
     */
    builtIn: !dependencies.includes(packageName),
    /** Only a dependency this profile owns can be removed or updated. */
    removable: dependencies.includes(packageName),
    mounted: bundles.includes(packageName)
  };
}

function listPlugins() {
  const manifest = readProfileManifest();
  const dependencies = Object.keys(manifest.dependencies ?? {});
  const bundles = Array.isArray(manifest.dsh?.profile?.bundles)
    ? manifest.dsh.profile.bundles.filter((entry) => typeof entry === "string")
    : [];

  const names = [...new Set([...dependencies, ...bundles])];

  return {
    profile: PROFILE_NAME,
    profileDir: PROFILE_DIR,
    packages: names.map((packageName) =>
      describePlugin(packageName, dependencies, bundles)
    )
  };
}

/**
 * Run one `dsh plugin` command to completion.
 *
 * `windowsHide` is required, not cosmetic: the desktop process has no console,
 * so a console-subsystem child would otherwise be given a brand-new visible one.
 */
function runDshPluginCommand(args) {
  const env = environment();

  // Windows treats environment names case-insensitively, but Node's `process.env`
  // keeps the spelling the parent used. Reusing that exact key is what preserves
  // the inherited search path; a second `PATH` entry would silently drop it.
  const pathKey =
    Object.keys(process.env).find((key) => key.toLowerCase() === "path") ??
    "PATH";
  const childEnv = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    NO_COLOR: "1"
  };
  if (env.shimDir) {
    childEnv[pathKey] = `${env.shimDir}${delimiter}${process.env[pathKey] ?? ""}`;
  }

  return new Promise((settle) => {
    const child = spawn(env.electron, [env.dshCli, ...args], {
      cwd: PROFILE_DIR,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });

    let output = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, COMMAND_TIMEOUT_MS);

    child.stdout?.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      settle({
        ok: false,
        code: null,
        timedOut: false,
        output: output.trim(),
        error: String(error?.message ?? error)
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      settle({
        ok: code === 0 && !timedOut,
        code,
        timedOut,
        output: output.trim()
      });
    });
  });
}

/**
 * Arguments for one `dsh plugin` invocation.
 *
 * `--workspace-root` is not optional: a profile is a pnpm workspace root (the
 * generated `pnpm-workspace.yaml` lists `packages: - .`), and pnpm refuses to
 * add a registry package to a workspace root unless it is asked explicitly.
 * `dsh plugin` forwards these arguments to pnpm verbatim, so the flag has to
 * come from here — without it every install from the registry fails with
 * `ERR_PNPM_ADDING_TO_ROOT`. Local paths and `link:` specs are exempt from that
 * check, which is why an end-to-end run that installs a local probe plugin does
 * not catch the omission.
 *
 * Every spec becomes one pnpm argument, so one run can install a plugin and the
 * `link:` companions its peers need.
 *
 * Exported so the argument shape is testable; the loader only reads `name`,
 * `inject` and `apply`.
 */
export function pluginArguments(action, specs, storeDir) {
  const args = [
    "plugin",
    "--profile",
    PROFILE_NAME,
    action,
    "--workspace-root",
    ...specs
  ];
  if (storeDir) {
    args.push("--store-dir", storeDir);
  }
  return args;
}

/**
 * Same-origin, loopback-only fence — the same posture dsh gives its own `/api`
 * transport. This route can install arbitrary code, so it must never be
 * reachable from another origin or from a page that a remote host served.
 */
function isTrusted(request) {
  const host = request.headers?.host;
  if (typeof host !== "string" || host.length === 0) {
    return false;
  }

  let hostUrl;
  try {
    hostUrl = new URL(`http://${host}`);
  } catch {
    return false;
  }

  const hostname = hostUrl.hostname;
  const loopback =
    hostname === "localhost" ||
    hostname === "[::1]" ||
    /^127(\.\d{1,3}){3}$/.test(hostname);
  if (!loopback) {
    return false;
  }

  if (request.headers?.["sec-fetch-site"] === "cross-site") {
    return false;
  }

  const origin = request.headers?.origin;
  if (origin === undefined) {
    return true;
  }

  try {
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
}

function readBody(request, limit = 64 * 1024) {
  return new Promise((settle, fail) => {
    const chunks = [];
    let size = 0;

    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        fail(new Error(`request body over the ${limit}-byte limit`));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => settle(Buffer.concat(chunks).toString("utf8")));
    request.on("error", fail);
  });
}

export function apply(ctx) {
  if (typeof ctx.inject !== "function") {
    return;
  }

  // The card is only rendered for a settings namespace the host answers for.
  // The desktop app owns the plugin's configuration, so the namespace carries
  // nothing: it exists to make the card dispatchable.
  ctx.inject(["settings"], (scope) => {
    try {
      const passThrough = (value) => ({ ...(value ?? {}) });
      passThrough.toJSON = () => ({
        uid: 0,
        refs: { 0: { type: "object", meta: { default: {} }, dict: {} } }
      });
      scope.settings.register(SETTINGS_NAMESPACE, passThrough, { base: {} });
    } catch (error) {
      console.error(`[plugin-manager] settings namespace skipped: ${error}`);
    }
  });

  ctx.inject(["webServer"], (scope) => {
    scope.webServer.register({
      kind: "exact",
      path: ROUTE_PATH,
      handler: async (request, response) => {
        const send = (status, body) => {
          response.writeHead(status, { "content-type": "application/json" });
          response.end(JSON.stringify(body));
        };

        if (!isTrusted(request)) {
          return send(403, { error: "request refused: same-origin loopback only" });
        }

        const env = environment();
        const available = env.pnpmScript.length > 0 && env.dshCli.length > 0;

        if (request.method === "GET") {
          return send(200, { ...listPlugins(), available });
        }

        if (request.method !== "POST") {
          response.writeHead(405);
          return response.end();
        }

        let payload;
        try {
          payload = JSON.parse(await readBody(request));
        } catch (error) {
          return send(400, { error: String(error?.message ?? error) });
        }

        const action = payload?.action;
        const specs =
          typeof payload?.spec === "string" ? splitSpecs(payload.spec.trim()) : [];

        if (action === "restart") {
          // Answer first, then exit: the shell sees the restart code, restarts
          // the service, and reloads the window on the new authenticated URL.
          send(200, { ok: true, restarting: true });
          setTimeout(() => process.exit(env.restartExitCode), 250).unref?.();
          return;
        }

        if (action !== "add" && action !== "remove" && action !== "update") {
          return send(400, { error: `unknown action: ${String(action)}` });
        }

        // `update` alone means "update everything", so it is the one action
        // that may carry no spec at all.
        if (specs.length === 0 && action !== "update") {
          return send(400, { error: SPEC_REQUIRED });
        }

        const rejected = specs.find((spec) => !PACKAGE_SPEC.test(spec));
        if (rejected !== undefined) {
          return send(400, {
            error: `${JSON.stringify(rejected)} is not ${SPEC_SHAPE} (one spec per item; never a flag)`
          });
        }

        if (!available) {
          return send(503, {
            error:
              "this build cannot install plugins: it was not started by Harness Desktop"
          });
        }

        const result = await runDshPluginCommand(
          pluginArguments(action, specs, env.storeDir)
        );

        // A failed command still answers 200: the exit code and the output are
        // what the card has to show, and an error status would throw the output
        // away before it ever reached the user.
        return send(200, {
          ok: result.ok,
          output: result.output,
          restartRequired: result.ok,
          error: result.ok
            ? undefined
            : (result.error ??
              (result.timedOut
                ? `the command was stopped after ${Math.round(COMMAND_TIMEOUT_MS / 1000)}s`
                : `dsh plugin exited with code ${result.code ?? "null"}`)),
          plugins: listPlugins()
        });
      }
    });
  });
}

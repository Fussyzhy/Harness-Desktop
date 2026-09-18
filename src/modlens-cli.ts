import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { WEB_PROFILE_NAME, resolveDshHome } from "./dsh-profile.js";
import { resolveAsarUnpackedPath } from "./dsh-server.js";

/**
 * The plugin CLI the vision-engine settings window drives.
 *
 * The plugin owns its configuration file and its schema; its command line is the
 * documented writer for both (`modlens config set` validates each key, masks
 * secrets on read, and `modlens doctor --json` reports what every provider still
 * needs). Going through it keeps the page from parsing or rewriting the file,
 * and keeps secret handling in one place. Nothing here imports Electron: the
 * window is a separate module, so this layer stays testable outside the app —
 * the same split `dsh-plugins.ts` and `pet-overlay.ts` follow.
 */

/** The plugin package whose CLI owns the configuration file. */
const MODLENS_PACKAGE = "@liustack/modlens";
const MODLENS_CLI_RELATIVE = path.join("dist", "main.js");

/** One `modlens config set` the window asked for. */
export interface ModlensConfigChange {
  /** A key the CLI accepts: `provider`, `proxy`, or `<provider>.<field>`. */
  key: string;
  /** The value to write; an empty string is what the CLI reads as "clear". */
  value: string;
  /**
   * Whether the value is a credential. A secret travels on the CLI's stdin
   * instead of its command line, so it reaches neither the process list nor a
   * log — the same reason the CLI itself prompts without echo.
   */
  secret?: boolean;
}

/** One provider row of a `doctor --json` report, as the page renders it. */
export interface ModlensProviderRow {
  name: string;
  kind?: string;
  ready: boolean;
  status?: string;
  detail?: string;
  /** The CLI's own suggestion for what to run to fix this provider. */
  fix?: string;
  settings: { field: string; present: boolean }[];
}

/** The parts of a `doctor --json` report this page reads. */
export interface ModlensDoctor {
  nodeVersion?: string;
  nodeMeetsMinimum?: boolean;
  nodeSqlite?: boolean;
  configPath?: string;
  /** The provider the plugin would try first. */
  selection?: string;
  providers: ModlensProviderRow[];
  cooldownEnabled?: boolean;
  /** Per-harness decisions about reusing a locally logged-in CLI. */
  reuse: { harness: string; decision: string }[];
}

export interface ModlensCliResult {
  code: number | null;
  /** Everything the CLI wrote, stdout and stderr in the order it arrived. */
  output: string;
}

/** The CLI entry of the plugin whose settings the window edits. */
export interface ResolveModlensCliOptions {
  /** dsh home; defaults to the value dsh itself would resolve. */
  home?: string;
  /** Module resolution used for the packaged fallback; test seam. */
  requireFn?: { resolve: (id: string) => string };
}

/**
 * The CLI entries to try, in the order that keeps the running plugin in charge.
 *
 * The profile copy comes first because it is the version dsh mounts, so it is
 * the one whose key set the running plugin reads — a key added by a newer
 * release is accepted there and refused by an older CLI.
 *
 * It is only a preference: the copy this application writes into a profile is
 * the package directory alone, without the dependencies pnpm would install
 * beside it, so its CLI cannot start until pnpm has run in that profile. The
 * copy this package depends on is complete by construction and answers for it,
 * which is what lets the settings window work on the very first launch.
 */
export function resolveModlensCliCandidates({
  home = resolveDshHome(),
  requireFn = createRequire(import.meta.url)
}: ResolveModlensCliOptions = {}): string[] {
  const candidates: string[] = [];

  const profilesCopy = resolveAsarUnpackedPath(
    path.join(
      home,
      "profiles",
      WEB_PROFILE_NAME,
      "node_modules",
      ...MODLENS_PACKAGE.split("/"),
      MODLENS_CLI_RELATIVE
    )
  );
  if (existsSync(profilesCopy)) {
    candidates.push(profilesCopy);
  }

  try {
    const manifestPath = requireFn.resolve(`${MODLENS_PACKAGE}/package.json`);
    const bundled = resolveAsarUnpackedPath(
      path.join(path.dirname(manifestPath), MODLENS_CLI_RELATIVE)
    );
    if (existsSync(bundled) && !candidates.includes(bundled)) {
      candidates.push(bundled);
    }
  } catch {
    // Not a dependency of this package; the profile copy is all there is.
  }

  return candidates;
}

/**
 * Arguments for one `config set`.
 *
 * A secret is left off the command line; every other value is passed as the
 * argument the CLI expects, an empty string included — that is how the CLI is
 * told to clear a setting rather than leave it alone.
 */
export function buildModlensConfigArgs(change: ModlensConfigChange): string[] {
  const args = ["config", "set", change.key];
  return change.secret === true ? args : [...args, change.value];
}

/**
 * Keys and values the renderer may hand to the CLI.
 *
 * The window is local and sandboxed, but a value here becomes an argument of a
 * spawned process, so the shape is checked at the boundary: a key that could be
 * read as a flag, or a value that could introduce one, is refused instead of
 * being forwarded.
 */
export function normalizeModlensChanges(value: unknown): ModlensConfigChange[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const changes: ModlensConfigChange[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const { key, value: raw, secret } = entry as {
      key?: unknown;
      value?: unknown;
      secret?: unknown;
    };
    if (typeof key !== "string" || !/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(key)) {
      continue;
    }
    const text = typeof raw === "string" ? raw : "";
    if (text.length > 4096 || (secret !== true && text.startsWith("-"))) {
      continue;
    }
    changes.push({ key, value: text, secret: secret === true });
  }

  return changes;
}

/**
 * Run one CLI invocation to completion.
 *
 * `windowsHide` is not optional: the desktop process has no console, so without
 * it Windows gives the console-subsystem child a brand-new visible one.
 */
export function runModlensCli(
  args: readonly string[],
  {
    cliPath,
    electronPath,
    secret
  }: {
    cliPath: string;
    electronPath: string;
    secret?: string;
  }
): Promise<ModlensCliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(electronPath, [cliPath, ...args], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });

    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output }));
    // The CLI reads a secret as one line of stdin. Ending the stream also
    // answers the commands that never ask for one.
    child.stdin?.on("error", () => {});
    child.stdin?.end(secret === undefined ? "" : `${secret}\n`);
  });
}

/** Narrow an unknown JSON value to a plain object. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/**
 * Read a `doctor --json` report into the view the page renders.
 *
 * Every field is optional on purpose: the report belongs to the plugin, and a
 * release that renames or adds one must leave the page usable rather than
 * broken. Whatever is not recognised is simply absent.
 *
 * @returns the view, or `undefined` when the output is not a JSON object.
 */
export function describeModlensDoctor(output: string): ModlensDoctor | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return undefined;
  }

  const report = asRecord(parsed);
  if (report === undefined) {
    return undefined;
  }

  const providers: ModlensProviderRow[] = [];
  for (const entry of Array.isArray(report.providers) ? report.providers : []) {
    const provider = asRecord(entry);
    const name = asString(provider?.name);
    if (provider === undefined || name === undefined) {
      continue;
    }
    const settings: { field: string; present: boolean }[] = [];
    for (const setting of Array.isArray(provider.settings) ? provider.settings : []) {
      const record = asRecord(setting);
      const field = asString(record?.field);
      if (field !== undefined) {
        settings.push({ field, present: record?.present === true });
      }
    }
    providers.push({
      name,
      kind: asString(provider.kind),
      ready: provider.ready === true,
      status: asString(provider.status),
      detail: asString(provider.detail),
      fix: asString(provider.fix),
      settings
    });
  }

  const reuse: { harness: string; decision: string }[] = [];
  const decisions = asRecord(asRecord(report.reuse)?.decisions);
  for (const [harness, decision] of Object.entries(decisions ?? {})) {
    const text = asString(decision);
    if (text !== undefined) {
      reuse.push({ harness, decision: text });
    }
  }

  return {
    nodeVersion: asString(asRecord(report.node)?.version),
    nodeMeetsMinimum: asBoolean(asRecord(report.node)?.meetsMinimum),
    nodeSqlite: asBoolean(asRecord(report.nodeSqlite)?.available),
    configPath: asString(asRecord(report.config)?.path),
    selection: asString(asRecord(report.selection)?.provider),
    providers,
    cooldownEnabled: asBoolean(asRecord(report.cooldown)?.enabled),
    reuse
  };
}

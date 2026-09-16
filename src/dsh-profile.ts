import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAsarUnpackedPath, resolveDshPackageJsonPath } from "./dsh-server.js";

/**
 * Plugin bundles this application installs into the dsh `web` profile so they
 * are present on every machine without a runtime package manager.
 *
 * The dsh process is Electron's Node runtime, which ships neither npm nor
 * corepack, and a packaged build has no `dsh` on PATH either. `dsh plugin add`
 * therefore cannot run on a user's machine, so a plugin only reaches a fresh
 * install by being listed here and shipped in this package's dependencies.
 */
export const BUNDLED_PROFILE_PLUGINS: readonly string[] = ["@liustack/modlens"];

/** A plugin bundle shipped as a plain directory inside this application. */
export interface LocalProfilePlugin {
  /** Package name, exactly as dsh must see it in `dsh.profile.bundles`. */
  name: string;
  /** Directory holding the package, relative to the application root. */
  directory: string;
}

/**
 * Plugin bundles that travel with the application itself instead of coming from
 * a registry.
 *
 * A local bundle is deliberately *not* a dependency of this package: dsh
 * resolves a bundle from the installation anchor first and from the profile
 * second, so a name that exists in both places takes its patch layer from one
 * copy and its runtime module from the other. Keeping the manager out of
 * `node_modules` leaves exactly one copy — the one this module writes into the
 * profile — for both halves to resolve.
 */
export const BUNDLED_LOCAL_PROFILE_PLUGINS: readonly LocalProfilePlugin[] = [
  {
    name: "@harness-desktop/dsh-plugin-manager",
    directory: path.join("plugins", "dsh-plugin-manager")
  }
];

/**
 * The dsh release whose shipped `web` profile template this module mirrors.
 * A `web` profile that does not exist yet is only created while the installed
 * dsh matches, because inventing a template for an unknown release risks
 * writing a composition that release cannot mount.
 *
 * A stale value does not fail loudly — it turns profile creation into a silent
 * no-op, so a fresh machine boots without any bundled plugin (the template
 * check above is the only thing that would have written them). The value is
 * therefore asserted against the pinned `@deepseek-ai/dsh` dependency and the
 * installed package by `test/dsh-version-drift.test.ts`.
 *
 * `0.1.6-alpha.1` was verified against the release itself: a profile that dsh
 * creates from its own template carries `["@deepseek-ai/dsh-base",
 * "@deepseek-ai/dsh-web-app"]`, `patchReload: "live"`, and the same
 * `pnpm-workspace.yaml` this module writes.
 */
export const SUPPORTED_DSH_VERSION = "0.1.6-alpha.1";

/** Environment variable that overrides the default dsh home. */
export const DSH_HOME_ENV = "DSH_HOME";

/** The profile every `dsh web` surface mounts. */
export const WEB_PROFILE_NAME = "web";

/** Directory under the dsh home holding every profile. */
const PROFILES_DIR = "profiles";
const PROFILE_MANIFEST_FILENAME = "package.json";
const PROFILE_PATCH_FILENAME = "cordis.patch.yml";
const PROFILE_PNPM_WORKSPACE_FILENAME = "pnpm-workspace.yaml";
const MODULES_DIR_NAME = "node_modules";
/** Staging directory for the copy-then-swap install; never a real package name. */
const STAGING_DIR_NAME = ".harness-desktop-staging";

/** Mirrors `PROFILE_TEMPLATES.web.bundles` in `@deepseek-ai/dsh-app-boot`. */
const WEB_PROFILE_TEMPLATE_BUNDLES: readonly string[] = [
  "@deepseek-ai/dsh-base",
  "@deepseek-ai/dsh-web-app"
];

/** Mirrors `PROFILE_TEMPLATES.web.patchReload`. */
const WEB_PROFILE_PATCH_RELOAD = "live";

/** Mirrors `PROFILE_PATCH_TEMPLATE` in `@deepseek-ai/dsh-app-boot`. */
const PROFILE_PATCH_TEMPLATE = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
[]
`;

/** Mirrors `PROFILE_PNPM_WORKSPACE` in `@deepseek-ai/dsh-app-boot`. */
const PROFILE_PNPM_WORKSPACE = `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
`;

/** What {@link ensureWebProfilePlugins} did, for logging and tests. */
export type ProfilePluginStatus =
  | "created"
  | "updated"
  | "unchanged"
  | "skipped";

export interface ProfilePluginResult {
  status: ProfilePluginStatus;
  profileDir: string;
  /** The bundle list left in the profile manifest; empty when skipped. */
  bundles: string[];
  /** Bundled plugins (re)installed into the profile's `node_modules`. */
  installed: string[];
  /** Why the profile was skipped, when `status` is `skipped`. */
  reason?: string;
}

export interface EnsureWebProfileOptions {
  /** Managed bundles to guarantee; defaults to {@link BUNDLED_PROFILE_PLUGINS}. */
  additions?: readonly string[];
  /** Application-local bundles to guarantee; defaults to {@link BUNDLED_LOCAL_PROFILE_PLUGINS}. */
  localAdditions?: readonly LocalProfilePlugin[];
  /** Application root holding local bundles; defaults to this module's own. */
  appRoot?: string;
  /** dsh home; defaults to the value dsh itself would resolve. */
  home?: string;
  /** File inside the dsh installation used as the first resolution anchor. */
  installAnchor?: string;
  /** Installed dsh version; read from the install anchor when omitted. */
  installedDshVersion?: string;
}

/** Resolve the dsh home exactly as `@deepseek-ai/dsh-home-paths` does. */
export function resolveDshHome(
  env: NodeJS.ProcessEnv = process.env,
  osHome: string = homedir()
): string {
  const configured = env[DSH_HOME_ENV];
  const fromEnv =
    configured !== undefined && configured.trim().length > 0
      ? configured.trim()
      : path.join(osHome, ".dsh");

  return path.resolve(expandHomePath(fromEnv, osHome));
}

/** Expand the `~` forms dsh accepts against the operating-system home. */
export function expandHomePath(value: string, osHome: string = homedir()): string {
  if (value === "~") {
    return osHome;
  }
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(osHome, value.slice(2));
  }
  return value;
}

/** Absolute path of the `web` profile directory for one dsh home. */
export function resolveWebProfileDir(home: string): string {
  return path.join(home, PROFILES_DIR, WEB_PROFILE_NAME);
}

/** Read the installed dsh version, or `undefined` when it cannot be read. */
export function readInstalledDshVersion(
  installAnchor: string = resolveDshPackageJsonPath()
): string | undefined {
  const version = readManifest(installAnchor)?.version;
  return typeof version === "string" ? version : undefined;
}

/**
 * Guarantee that every managed plugin bundle is present in the `web` profile:
 * importable from the profile's own `node_modules` and listed in
 * `dsh.profile.bundles`.
 *
 * Both halves are required. `dsh.profile.bundles` is what makes dsh compose the
 * bundle's patch layer — dsh resolves that name from its installation anchor,
 * so a plugin shipped in this package's dependencies is found. The composed row
 * is then *imported* by the loader from the profile directory, and neither the
 * installation fallback (`$DSH_HOME/profiles/node_modules` mirrors dsh's own
 * dependency closure, which a third-party plugin is not part of) nor dsh's
 * profile-local link projection (it deliberately drops each bundle's own
 * package) puts the plugin there. A plugin installed by `dsh plugin add` lands
 * in `<profile>/node_modules`; this function reproduces exactly that.
 *
 * Membership is decided by resolution rather than intent, because listing a
 * bundle dsh cannot resolve aborts the whole boot: an addition joins the list
 * only when it resolves to a package declaring `dsh.bundle.patch`, and a
 * managed name that stopped resolving is dropped instead of left behind to
 * break the next launch. Bundles this application does not manage are never
 * added, reordered, or removed.
 *
 * The caller is expected to treat failures as non-fatal: a profile that cannot
 * be prepared still boots with whatever dsh finds on disk.
 */
export function ensureWebProfilePlugins({
  additions = BUNDLED_PROFILE_PLUGINS,
  // Empty by default so this function stays a pure function of its arguments:
  // the application passes {@link BUNDLED_LOCAL_PROFILE_PLUGINS} explicitly, and
  // a test that passes none never reads this repository's own `plugins/` tree.
  localAdditions = [],
  appRoot = defaultAppRoot(),
  home = resolveDshHome(),
  installAnchor = resolveDshPackageJsonPath(),
  installedDshVersion
}: EnsureWebProfileOptions = {}): ProfilePluginResult {
  const profileDir = resolveWebProfileDir(home);
  const manifestPath = path.join(profileDir, PROFILE_MANIFEST_FILENAME);

  const mountable: { name: string; sourceDir: string; local?: boolean }[] = [];
  const unmountable: string[] = [];
  for (const name of additions) {
    const sourceDir = resolveBundleDir(name, installAnchor, profileDir);
    // Resolving is not enough: dsh aborts the boot on a listed bundle whose
    // manifest declares no `dsh.bundle`, so that case must stay out too.
    if (
      sourceDir === undefined ||
      readBundlePatch(path.join(sourceDir, PROFILE_MANIFEST_FILENAME)) === undefined
    ) {
      unmountable.push(name);
    } else {
      mountable.push({ name, sourceDir });
    }
  }

  for (const plugin of localAdditions) {
    const sourceDir = resolveLocalBundleDir(plugin, appRoot);
    if (
      sourceDir === undefined ||
      readBundlePatch(path.join(sourceDir, PROFILE_MANIFEST_FILENAME)) === undefined
    ) {
      unmountable.push(plugin.name);
    } else {
      // Local bundles ship with the application, so the profile copy is always
      // refreshed: a client half that lags the shipped one is a boot failure,
      // not a stale feature.
      mountable.push({ name: plugin.name, sourceDir, local: true });
    }
  }

  if (unmountable.length > 0) {
    console.warn(
      `Bundled profile plugins unavailable from this installation, left out: ${unmountable.join(", ")}`
    );
  }

  const manifestExists = existsSync(manifestPath);
  const manifest = manifestExists ? readManifest(manifestPath) : undefined;
  if (manifestExists && manifest === undefined) {
    return {
      status: "skipped",
      profileDir,
      bundles: [],
      installed: [],
      reason: `${manifestPath} is not a JSON object`
    };
  }

  let outcome: Omit<ProfilePluginResult, "profileDir" | "installed"> = {
    status: "skipped",
    bundles: []
  };

  if (manifest === undefined) {
    outcome = createWebProfile({
      profileDir,
      manifestPath,
      bundles: mountable.map((entry) => entry.name),
      installedDshVersion:
        installedDshVersion ?? readInstalledDshVersion(installAnchor)
    });
  } else {
    const current = readBundles(manifest);
    const desired = current.filter((name) => !unmountable.includes(name));
    for (const entry of mountable) {
      if (!desired.includes(entry.name)) {
        desired.push(entry.name);
      }
    }

    const removed = current.filter((name) => !desired.includes(name));
    if (removed.length === 0 && desired.length === current.length) {
      outcome = { status: "unchanged", bundles: desired };
    } else {
      writeManifest(manifestPath, withBundles(manifest, desired));
      if (removed.length > 0) {
        console.warn(
          `Dropped profile bundles that no longer resolve: ${removed.join(", ")}`
        );
      }
      outcome = { status: "updated", bundles: desired };
    }
  }

  // Copy only what this run actually listed: a profile this application
  // declines to manage (an unknown dsh version) must not collect modules for
  // bundles nobody composed.
  const installed =
    outcome.status === "skipped"
      ? []
      : installProfileModules(
          profileDir,
          mountable,
          new Set(Object.keys(manifest?.dependencies ?? {}))
        );

  return { ...outcome, profileDir, installed };
}

/** Write a fresh profile from the shipped `web` template plus the additions. */
function createWebProfile({
  profileDir,
  manifestPath,
  bundles,
  installedDshVersion
}: {
  profileDir: string;
  manifestPath: string;
  bundles: readonly string[];
  installedDshVersion: string | undefined;
}): Omit<ProfilePluginResult, "installed"> {
  if (installedDshVersion !== SUPPORTED_DSH_VERSION) {
    return {
      status: "skipped",
      profileDir,
      bundles: [],
      reason: `installed dsh ${installedDshVersion ?? "(unknown)"} is not the supported ${SUPPORTED_DSH_VERSION}`
    };
  }

  if (bundles.length === 0) {
    return {
      status: "skipped",
      profileDir,
      bundles: [],
      reason: "no bundled plugin resolves from this installation"
    };
  }

  const list = [...WEB_PROFILE_TEMPLATE_BUNDLES, ...bundles];
  mkdirSync(profileDir, { recursive: true });
  writeManifest(manifestPath, {
    name: `dsh-profile-${WEB_PROFILE_NAME}`,
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: list, patchReload: WEB_PROFILE_PATCH_RELOAD } }
  });
  writeIfAbsent(path.join(profileDir, PROFILE_PATCH_FILENAME), PROFILE_PATCH_TEMPLATE);
  writeIfAbsent(
    path.join(profileDir, PROFILE_PNPM_WORKSPACE_FILENAME),
    PROFILE_PNPM_WORKSPACE
  );

  return { status: "created", profileDir, bundles: list };
}

/**
 * Copy each managed plugin into the profile's `node_modules`, returning the
 * names actually (re)written.
 *
 * The copy is what makes the composed row importable, and it mirrors the
 * hoisted layout the profile's `pnpm-workspace.yaml` asks pnpm for. A registry
 * plugin whose copy already carries the installed version is left alone, so a
 * warm launch pays one manifest read; a plugin this application ships itself is
 * always refreshed (see {@link installProfileModule}).
 */
function installProfileModules(
  profileDir: string,
  packages: readonly { name: string; sourceDir: string; local?: boolean }[],
  userOwned: ReadonlySet<string> = new Set()
): string[] {
  const modulesDir = path.join(profileDir, MODULES_DIR_NAME);
  const installed: string[] = [];

  for (const entry of packages) {
    try {
      const written = installProfileModule(entry.name, entry.sourceDir, modulesDir, {
        force: entry.local === true
      });
      if (!written) {
        continue;
      }

      installed.push(entry.name);
      if (entry.local !== true && userOwned.has(entry.name)) {
        // A user-installed copy of a built-in plugin is the one case where the
        // profile holds a version this application did not put there, and it
        // cannot be honoured: a bundle's patch layer resolves from the
        // installation anchor first, so two versions would mix one copy's patch
        // file with the other copy's code. The application's copy stands, and
        // the log says which plugin it replaced.
        console.warn(
          `Restored the bundled ${entry.name} over the copy in ${modulesDir}: bundles this application manages are version-locked to it.`
        );
      }
    } catch (error) {
      console.warn(
        `Failed to install bundled plugin ${entry.name} into ${modulesDir}: ${String(error)}`
      );
    }
  }

  return installed;
}

/** Install one plugin directory; returns whether anything was written. */
function installProfileModule(
  packageName: string,
  sourceDir: string,
  modulesDir: string,
  { force = false }: { force?: boolean } = {}
): boolean {
  const targetDir = path.join(modulesDir, packageName);
  if (path.resolve(sourceDir) === path.resolve(targetDir)) {
    return false;
  }

  const sourceVersion = readManifest(path.join(sourceDir, PROFILE_MANIFEST_FILENAME))
    ?.version;
  const installedVersion = readManifest(
    path.join(targetDir, PROFILE_MANIFEST_FILENAME)
  )?.version;
  if (!force && installedVersion !== undefined && installedVersion === sourceVersion) {
    return false;
  }

  // Stage then swap, so an interrupted copy can never leave a half-written
  // package where Node would import it.
  const stagingRoot = path.join(modulesDir, STAGING_DIR_NAME);
  const stagedDir = path.join(stagingRoot, packageName);
  rmSync(stagingRoot, { recursive: true, force: true });
  try {
    mkdirSync(path.dirname(stagedDir), { recursive: true });
    cpSync(sourceDir, stagedDir, { recursive: true });
    rmSync(targetDir, { recursive: true, force: true });
    mkdirSync(path.dirname(targetDir), { recursive: true });
    renameSync(stagedDir, targetDir);
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }

  return true;
}

/**
 * The directory an application-local bundle lives in, mapped out of `app.asar`
 * because the copy reads it as a real file tree.
 *
 * Local bundles never resolve through `node_modules`: they are not dependencies
 * of this package, and dsh finds them in the profile directory this module
 * writes them to.
 */
export function resolveLocalBundleDir(
  plugin: LocalProfilePlugin,
  appRoot: string
): string | undefined {
  const dir = resolveAsarUnpackedPath(path.join(appRoot, plugin.directory));
  return existsSync(path.join(dir, PROFILE_MANIFEST_FILENAME)) ? dir : undefined;
}

/** This application's root: `<root>/dist/dsh-profile.js` is one level down. */
export function defaultAppRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

/**
 * The package directory dsh would resolve for `packageName`.
 *
 * Mirrors `resolveBundleDir` in `@deepseek-ai/dsh-app-boot`: the installation
 * anchor is searched first and the profile directory second, and the first
 * package directory found is the one dsh uses.
 */
export function resolveBundleDir(
  packageName: string,
  installAnchor: string,
  profileDir: string
): string | undefined {
  const anchors = [installAnchor, path.join(profileDir, PROFILE_MANIFEST_FILENAME)];

  for (const anchor of anchors) {
    let searchPaths: string[] | undefined;
    try {
      searchPaths = createRequire(anchor).resolve.paths(packageName) ?? undefined;
    } catch {
      continue;
    }

    for (const searchPath of searchPaths ?? []) {
      const dir = path.join(searchPath, packageName);
      if (existsSync(path.join(dir, PROFILE_MANIFEST_FILENAME))) {
        return dir;
      }
    }
  }

  return undefined;
}

/**
 * Whether dsh could both compose and mount `packageName`.
 *
 * A package that resolves but declares no `dsh.bundle.patch` is a boot failure
 * for dsh, so it counts as unmountable rather than as a reason to keep looking.
 */
export function isBundleMountable(
  packageName: string,
  installAnchor: string,
  profileDir: string
): boolean {
  const dir = resolveBundleDir(packageName, installAnchor, profileDir);
  return (
    dir !== undefined &&
    readBundlePatch(path.join(dir, PROFILE_MANIFEST_FILENAME)) !== undefined
  );
}

/** The `dsh.bundle.patch` entry of a package directory, when declared. */
function readBundlePatch(manifestPath: string): string | undefined {
  const manifest = readManifest(manifestPath);
  const dsh = asRecord(manifest?.dsh);
  const bundle = asRecord(dsh?.bundle);
  return typeof bundle?.patch === "string" ? bundle.patch : undefined;
}

/** Parse a manifest, returning `undefined` for unreadable or non-object JSON. */
function readManifest(manifestPath: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
    return asRecord(parsed);
  } catch {
    return undefined;
  }
}

/** Persist a manifest the way dsh's `writeProfileManifest` does. */
function writeManifest(manifestPath: string, manifest: Record<string, unknown>): void {
  writeFileSync(manifestPath, JSON.stringify(manifest, undefined, 2) + "\n");
}

/** Write a template file only when the profile does not carry one already. */
function writeIfAbsent(filePath: string, contents: string): void {
  if (!existsSync(filePath)) {
    writeFileSync(filePath, contents);
  }
}

/** The `dsh.profile.bundles` list of a manifest, keeping only strings. */
function readBundles(manifest: Record<string, unknown>): string[] {
  const profile = asRecord(asRecord(manifest.dsh)?.profile);
  const bundles = profile?.bundles;
  return Array.isArray(bundles)
    ? bundles.filter((name): name is string => typeof name === "string")
    : [];
}

/** Copy a manifest with a replacement `dsh.profile.bundles` list. */
function withBundles(
  manifest: Record<string, unknown>,
  bundles: readonly string[]
): Record<string, unknown> {
  const dsh = asRecord(manifest.dsh) ?? {};
  const profile = asRecord(dsh.profile) ?? {};
  return {
    ...manifest,
    dsh: { ...dsh, profile: { ...profile, bundles: [...bundles] } }
  };
}

/** Narrow an unknown JSON value to a plain object. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { resolveDshPackageJsonPath } from "./dsh-server.js";

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

/**
 * The dsh release whose shipped `web` profile template this module mirrors.
 * A `web` profile that does not exist yet is only created while the installed
 * dsh matches, because inventing a template for an unknown release risks
 * writing a composition that release cannot mount.
 */
export const SUPPORTED_DSH_VERSION = "0.1.5-rc.2";

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
  home = resolveDshHome(),
  installAnchor = resolveDshPackageJsonPath(),
  installedDshVersion
}: EnsureWebProfileOptions = {}): ProfilePluginResult {
  const profileDir = resolveWebProfileDir(home);
  const manifestPath = path.join(profileDir, PROFILE_MANIFEST_FILENAME);

  const mountable: { name: string; sourceDir: string }[] = [];
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
      : installProfileModules(profileDir, mountable);

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
 * hoisted layout the profile's `pnpm-workspace.yaml` asks pnpm for. An
 * unchanged copy is left alone, so a warm launch pays one manifest read.
 */
function installProfileModules(
  profileDir: string,
  packages: readonly { name: string; sourceDir: string }[]
): string[] {
  const modulesDir = path.join(profileDir, MODULES_DIR_NAME);
  const installed: string[] = [];

  for (const entry of packages) {
    try {
      if (installProfileModule(entry.name, entry.sourceDir, modulesDir)) {
        installed.push(entry.name);
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
  modulesDir: string
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
  if (installedVersion !== undefined && installedVersion === sourceVersion) {
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

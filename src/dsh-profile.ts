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
 *
 * A stale value does not fail loudly — it turns profile creation into a silent
 * no-op, so a fresh machine boots without any bundled plugin (the template
 * check above is the only thing that would have written them). The value is
 * therefore asserted against the pinned `@deepseek-ai/dsh` dependency and the
 * installed package by `test/dsh-version-drift.test.ts`.
 *
 * `0.1.6-alpha.2` was verified against the release itself: a profile that dsh
 * creates from its own template carries `["@deepseek-ai/dsh-base",
 * "@deepseek-ai/dsh-web-app"]` and the same `pnpm-workspace.yaml` this module
 * writes. That release moved profile reload out of the manifest: the template
 * no longer carries a `patchReload` key, and reload is now the `hmr` row the
 * base bundle mounts (`root: []`), so this module no longer writes one either.
 * A `patchReload` left in a profile created by an earlier release is ignored —
 * `readProfileManifest` only checks that the file is a JSON object.
 */
export const SUPPORTED_DSH_VERSION = "0.1.6-alpha.2";

/** Environment variable that overrides the default dsh home. */
export const DSH_HOME_ENV = "DSH_HOME";

/** The profile every `dsh web` surface mounts. */
export const WEB_PROFILE_NAME = "web";

/** Directory under the dsh home holding every profile. */
const PROFILES_DIR = "profiles";
const PROFILE_MANIFEST_FILENAME = "package.json";
const PROFILE_PATCH_FILENAME = "cordis.patch.yml";
const PROFILE_PNPM_WORKSPACE_FILENAME = "pnpm-workspace.yaml";
const PROFILE_NPMRC_FILENAME = ".npmrc";
const MODULES_DIR_NAME = "node_modules";
/** Staging directory for the copy-then-swap install; never a real package name. */
const STAGING_DIR_NAME = ".harness-desktop-staging";

/** Mirrors `PROFILE_TEMPLATES.web.bundles` in `@deepseek-ai/dsh-app-boot`. */
const WEB_PROFILE_TEMPLATE_BUNDLES: readonly string[] = [
  "@deepseek-ai/dsh-base",
  "@deepseek-ai/dsh-web-app"
];

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

/**
 * The settings this application guarantees in every profile's `.npmrc`, as the
 * lines written when the file is missing.
 */
const PROFILE_NPMRC_SETTINGS: readonly string[] = [
  "auto-install-peers=false",
  "ignore-workspace-root-check=true"
];

/**
 * The `.npmrc` a profile created by this application gets, in the one place the
 * pnpm this application bundles reads these settings from.
 *
 * `auto-install-peers=false`: the workspace template above is dsh's own, and
 * pnpm 10.4.0 ignores an `autoInstallPeers` field there — it takes the value
 * only from `.npmrc` or the `npm_config_*` environment. Left unset, an install
 * satisfies every missing peer of a plugin from the registry by its `latest`
 * tag, and the framework packages a plugin peers on are published as a
 * prerelease line whose `latest` is older than what this application runs: a
 * peer range of `"*"` resolves to a version whose own dependencies are no longer
 * published, and the whole install fails with `ERR_PNPM_FETCH_404` before it
 * adds anything. dsh provides those peers at runtime and never mounts a profile
 * dependency as a layer, so an install must not go to the registry for them.
 *
 * `ignore-workspace-root-check=true`: a profile is a pnpm workspace root (the
 * workspace template above lists `packages: - .`), and pnpm adds a *registry*
 * package to a workspace root only when it is asked to explicitly. Local,
 * `link:`, and `file:` specs are exempt, which is why an install of a local
 * probe never met this rule. The official plugin manager runs
 * `pnpm add <spec>` with no such flag, so without this setting every install
 * from a registry fails with `ERR_PNPM_ADDING_TO_ROOT`.
 */
const PROFILE_NPMRC = `# Written by Harness Desktop. A dsh plugin's peer dependencies are provided by
# the running installation, so pnpm must not resolve them from the registry,
# where the framework packages are published as a prerelease line whose latest
# tag is stale. pnpm reads these here, not from pnpm-workspace.yaml.
#
# A profile is a pnpm workspace root, so pnpm adds a registry package to it only
# when the check is off; the official plugin manager always installs this way.
${PROFILE_NPMRC_SETTINGS.join("\n")}
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

/** A bundled plugin that resolves from this installation, with its version. */
interface MountableBundle {
  name: string;
  sourceDir: string;
  /** What the package declares, when it declares a version at all. */
  version: string | undefined;
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

  const mountable: MountableBundle[] = [];
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
      mountable.push({
        name,
        sourceDir,
        version: readBundleVersion(sourceDir)
      });
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
      bundles: mountable,
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

    // A bundled plugin is also a profile dependency, pinned to the version this
    // installation ships: the Plugins page decides what to list from that set,
    // so a bundle that is only named in `dsh.profile.bundles` is composed but
    // shown nowhere. Only entries for plugins this run can mount are written —
    // an entry the user installed is never removed here.
    const pins = managedDependencies(mountable);
    const existingDependencies = asRecord(manifest.dependencies) ?? {};
    const stalePins = Object.entries(pins).filter(
      ([name, version]) => existingDependencies[name] !== version
    );

    const removed = current.filter((name) => !desired.includes(name));
    if (removed.length === 0 && desired.length === current.length && stalePins.length === 0) {
      outcome = { status: "unchanged", bundles: desired };
    } else {
      writeManifest(manifestPath, withBundles(manifest, desired, pins));
      if (removed.length > 0) {
        console.warn(
          `Dropped profile bundles that no longer resolve: ${removed.join(", ")}`
        );
      }
      outcome = { status: "updated", bundles: desired };
    }
  }

  // A profile dsh created itself — `dsh web` before this application ever ran,
  // or one from a release that predates this file — carries dsh's workspace
  // template but not the `.npmrc` pnpm reads these settings from, so the file is
  // guaranteed for every profile this application manages and not only for the
  // ones it creates.
  if (outcome.status !== "skipped") {
    ensureProfileNpmrc(path.join(profileDir, PROFILE_NPMRC_FILENAME));
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

/**
 * A start that fails before dsh reports its Web URL may be one plugin's fault,
 * and the lever this application has is the profile's layer list: a bundle left
 * out of `dsh.profile.bundles` is never composed, imported, or mounted.
 *
 * The names removed that way are recorded rather than forgotten — the next
 * launch must not simply compose them again (it would fail again), the plugin
 * manager reports them as installed but not mounted, and one action puts them
 * back.
 */
export const PROFILE_QUARANTINE_FILENAME = ".harness-desktop-quarantine.json";

/** Why a bundle left the profile's layer stack. */
export type QuarantineReason = "startup-failure" | "safe-mode";

export type QuarantineRecord = {
  /** Bundles removed from `dsh.profile.bundles`, in the order they were removed. */
  disabled: string[];
  reason: QuarantineReason;
  /** ISO timestamp of the last write. */
  at: string;
};

export interface ProfileQuarantineOptions {
  /** dsh home; defaults to the value dsh itself would resolve. */
  home?: string;
  /** File inside the dsh installation used as the first resolution anchor. */
  installAnchor?: string;
  /** Managed bundles that are never candidates; defaults to {@link BUNDLED_PROFILE_PLUGINS}. */
  additions?: readonly string[];
}

/** The bundle names this application ships or manages itself. */
function managedBundleNames(additions: readonly string[]): Set<string> {
  return new Set([...WEB_PROFILE_TEMPLATE_BUNDLES, ...additions]);
}

/**
 * The profile's bundles that came from a user or a third-party install, in
 * layer order: everything this application does not itself ship or manage.
 */
export function thirdPartyProfileBundles({
  home = resolveDshHome(),
  additions = BUNDLED_PROFILE_PLUGINS
}: ProfileQuarantineOptions = {}): string[] {
  const profileDir = resolveWebProfileDir(home);
  const manifest = readManifest(path.join(profileDir, PROFILE_MANIFEST_FILENAME));
  if (manifest === undefined) {
    return [];
  }

  const managed = managedBundleNames(additions);
  return readBundles(manifest).filter((name) => !managed.has(name));
}

/** The quarantine record of a profile, when one is present and well formed. */
export function readQuarantine(
  home: string = resolveDshHome()
): QuarantineRecord | undefined {
  const record = readManifest(
    path.join(resolveWebProfileDir(home), PROFILE_QUARANTINE_FILENAME)
  );
  const disabled = record?.disabled;
  if (
    !Array.isArray(disabled) ||
    !disabled.every((name) => typeof name === "string")
  ) {
    return undefined;
  }

  return {
    disabled: disabled.filter((name): name is string => typeof name === "string"),
    reason: record?.reason === "safe-mode" ? "safe-mode" : "startup-failure",
    at: typeof record?.at === "string" ? record.at : ""
  };
}

/**
 * Take bundles out of the profile's layer stack and record the removal.
 *
 * A bundle this application manages is never a candidate: it is copied back on
 * every start, so removing one would only be undone at the next launch.
 *
 * @returns the record after the removal, or `undefined` when there is no
 *   profile manifest to edit.
 */
export function quarantineProfileBundles({
  home = resolveDshHome(),
  names,
  reason,
  additions = BUNDLED_PROFILE_PLUGINS
}: ProfileQuarantineOptions & {
  names: readonly string[];
  reason: QuarantineReason;
}): QuarantineRecord | undefined {
  const profileDir = resolveWebProfileDir(home);
  const manifestPath = path.join(profileDir, PROFILE_MANIFEST_FILENAME);
  const manifest = readManifest(manifestPath);
  if (manifest === undefined) {
    return undefined;
  }

  const existing = readQuarantine(home);
  const managed = managedBundleNames(additions);
  const candidates = names.filter((name) => !managed.has(name));
  const current = readBundles(manifest);
  const removed = current.filter((name) => candidates.includes(name));
  if (removed.length === 0) {
    return existing;
  }

  writeManifest(
    manifestPath,
    withBundles(
      manifest,
      current.filter((name) => !removed.includes(name))
    )
  );

  const record: QuarantineRecord = {
    disabled: [...new Set([...(existing?.disabled ?? []), ...removed])],
    reason,
    at: new Date().toISOString()
  };
  writeManifest(path.join(profileDir, PROFILE_QUARANTINE_FILENAME), { ...record });
  return record;
}

export interface RestoreQuarantineOptions extends ProfileQuarantineOptions {
  /**
   * The recorded names to restore; every recorded name when omitted.
   *
   * A subset keeps the record for everything it did not cover, so one launch
   * undoing its own recovery cannot hand back a bundle an earlier launch had
   * already found unmountable.
   */
  names?: readonly string[];
}

/**
 * Put recorded bundles back into the layer stack.
 *
 * A recorded name that no longer resolves is dropped instead of restored: a
 * listed bundle dsh cannot resolve aborts the boot this exists to repair.
 *
 * @returns the names actually restored.
 */
export function restoreQuarantinedBundles({
  home = resolveDshHome(),
  installAnchor = resolveDshPackageJsonPath(),
  names
}: RestoreQuarantineOptions = {}): string[] {
  const profileDir = resolveWebProfileDir(home);
  const record = readQuarantine(home);
  if (record === undefined) {
    return [];
  }

  const selected =
    names === undefined
      ? record.disabled
      : record.disabled.filter((name) => names.includes(name));
  if (selected.length === 0) {
    return [];
  }

  const manifestPath = path.join(profileDir, PROFILE_MANIFEST_FILENAME);
  const manifest = readManifest(manifestPath);
  const mountable = selected.filter(
    (name) =>
      manifest !== undefined && isBundleMountable(name, installAnchor, profileDir)
  );

  if (manifest !== undefined && mountable.length > 0) {
    const desired = readBundles(manifest);
    for (const name of mountable) {
      if (!desired.includes(name)) {
        desired.push(name);
      }
    }
    writeManifest(manifestPath, withBundles(manifest, desired));
  }

  const remaining = record.disabled.filter((name) => !selected.includes(name));
  const recordPath = path.join(profileDir, PROFILE_QUARANTINE_FILENAME);
  if (remaining.length === 0) {
    rmSync(recordPath, { force: true });
  } else {
    writeManifest(recordPath, {
      disabled: remaining,
      reason: record.reason,
      at: new Date().toISOString()
    });
  }

  const dropped = selected.filter((name) => !mountable.includes(name));
  if (dropped.length > 0) {
    console.warn(
      `Restored quarantined profile bundles, left out the ones that no longer resolve: ${dropped.join(", ")}`
    );
  }

  return mountable;
}

/**
 * Write a fresh profile from the shipped `web` template plus the additions.
 *
 * The additions are written as dependencies as well as layers, so the Plugins
 * page sees them as installed plugins from the first launch on (see
 * {@link managedDependencies}).
 */
function createWebProfile({
  profileDir,
  manifestPath,
  bundles,
  installedDshVersion
}: {
  profileDir: string;
  manifestPath: string;
  bundles: readonly MountableBundle[];
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

  const list = [
    ...WEB_PROFILE_TEMPLATE_BUNDLES,
    ...bundles.map((entry) => entry.name)
  ];
  mkdirSync(profileDir, { recursive: true });
  writeManifest(manifestPath, {
    name: `dsh-profile-${WEB_PROFILE_NAME}`,
    private: true,
    dependencies: managedDependencies(bundles),
    dsh: { profile: { bundles: list } }
  });
  writeIfAbsent(path.join(profileDir, PROFILE_PATCH_FILENAME), PROFILE_PATCH_TEMPLATE);
  writeIfAbsent(
    path.join(profileDir, PROFILE_PNPM_WORKSPACE_FILENAME),
    PROFILE_PNPM_WORKSPACE
  );

  return { status: "created", profileDir, bundles: list };
}

/**
 * Guarantee the settings a plugin install needs in the profile's `.npmrc`.
 *
 * A file that does not exist gets the whole template. One dsh created itself,
 * or one the user has edited, gets only the settings it is missing: a registry
 * or mirror the user added is theirs, and is never rewritten.
 *
 * The file alone is not enough — see {@link PNPM_CONFIG_ENV} for the copy that
 * reaches a profile this application does not prepare.
 */
function ensureProfileNpmrc(filePath: string): void {
  let current: string | undefined;
  try {
    current = readFileSync(filePath, "utf8");
  } catch {
    current = undefined;
  }

  if (current === undefined) {
    writeFileSync(filePath, PROFILE_NPMRC);
    return;
  }

  const keys = new Set(
    current
      .split(/\r?\n/)
      .map((line) => line.split("=")[0].trim())
      .filter((key) => key.length > 0)
  );
  const missing = PROFILE_NPMRC_SETTINGS.filter(
    (setting) => !keys.has(setting.split("=")[0].trim())
  );
  if (missing.length === 0) {
    return;
  }

  const separator = current.endsWith("\n") ? "" : "\n";
  writeFileSync(filePath, `${current}${separator}${missing.join("\n")}\n`);
}

/**
 * Copy each managed plugin into the profile's `node_modules`, returning the
 * names actually (re)written.
 *
 * The copy is what makes the composed row importable, and it mirrors the
 * hoisted layout the profile's `pnpm-workspace.yaml` asks pnpm for. A plugin
 * whose copy already carries the installed version is left alone, so a warm
 * launch pays one manifest read.
 */
function installProfileModules(
  profileDir: string,
  packages: readonly { name: string; sourceDir: string }[],
  userOwned: ReadonlySet<string> = new Set()
): string[] {
  const modulesDir = path.join(profileDir, MODULES_DIR_NAME);
  const installed: string[] = [];

  for (const entry of packages) {
    try {
      const written = installProfileModule(entry.name, entry.sourceDir, modulesDir);
      if (!written) {
        continue;
      }

      installed.push(entry.name);
      if (userOwned.has(entry.name)) {
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

/** The version a package directory declares, when it declares one. */
function readBundleVersion(sourceDir: string): string | undefined {
  const version = readManifest(path.join(sourceDir, PROFILE_MANIFEST_FILENAME))?.version;
  return typeof version === "string" ? version : undefined;
}

/**
 * The profile dependency entries this application manages: one per bundled
 * plugin, pinned to the version it ships.
 *
 * A plugin reaches the profile by being named in `dsh.profile.bundles` and
 * copied into its `node_modules`, which is enough to compose and import it but
 * leaves it invisible on the Plugins page — that page lists a package only when
 * the profile declares it as a dependency, when this dsh installation offers it
 * as an optional bundle, or when the bundle has a problem. Writing the pin is
 * what makes a plugin this application ships show up there like any other
 * installed one, at the version the copy actually holds.
 */
function managedDependencies(
  bundles: readonly MountableBundle[]
): Record<string, string> {
  const dependencies: Record<string, string> = {};
  for (const entry of bundles) {
    // A package without a version cannot be pinned; it stays a layer only.
    if (entry.version !== undefined) {
      dependencies[entry.name] = entry.version;
    }
  }

  return dependencies;
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

/**
 * Copy a manifest with a replacement `dsh.profile.bundles` list, and with
 * `dependencies` entries merged in when the caller manages any.
 */
function withBundles(
  manifest: Record<string, unknown>,
  bundles: readonly string[],
  dependencies?: Readonly<Record<string, string>>
): Record<string, unknown> {
  const dsh = asRecord(manifest.dsh) ?? {};
  const profile = asRecord(dsh.profile) ?? {};
  return {
    ...manifest,
    ...(dependencies === undefined
      ? {}
      : { dependencies: { ...asRecord(manifest.dependencies), ...dependencies } }),
    dsh: { ...dsh, profile: { ...profile, bundles: [...bundles] } }
  };
}

/** Narrow an unknown JSON value to a plain object. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

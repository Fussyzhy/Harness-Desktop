import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  BUNDLED_PROFILE_PLUGINS,
  SUPPORTED_DSH_VERSION,
  ensureWebProfilePlugins,
  isBundleMountable,
  quarantineProfileBundles,
  readInstalledDshVersion,
  readQuarantine,
  resolveDshHome,
  resolveWebProfileDir,
  restoreQuarantinedBundles,
  thirdPartyProfileBundles
} from "../src/dsh-profile.js";

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));

interface ScratchInstall {
  root: string;
  anchor: string;
}

/** Create a throwaway dsh installation whose anchor resolves `packages`. */
function createScratchInstall(
  packages: readonly { name: string; declaresBundle: boolean }[]
): ScratchInstall {
  const root = mkdtempSync(path.join(tmpdir(), "dsh-profile-install-"));
  const anchor = path.join(root, "dsh", "package.json");
  mkdirSync(path.dirname(anchor), { recursive: true });
  writeFileSync(anchor, JSON.stringify({ name: "dsh", version: SUPPORTED_DSH_VERSION }));

  for (const entry of packages) {
    const dir = path.join(root, "node_modules", entry.name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({
        name: entry.name,
        version: "1.0.0",
        ...(entry.declaresBundle
          ? { dsh: { bundle: { patch: "./cordis.patch.yml" } } }
          : {})
      })
    );
  }

  return { root, anchor };
}

function createScratchHome(): string {
  return mkdtempSync(path.join(tmpdir(), "dsh-profile-home-"));
}

function readProfileManifest(profileDir: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(path.join(profileDir, "package.json"), "utf8")
  ) as Record<string, unknown>;
}

function readManifestVersion(packageDir: string): unknown {
  return (
    JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8")) as {
      version?: unknown;
    }
  ).version;
}

test("resolveDshHome prefers DSH_HOME and ignores a blank override", () => {
  assert.equal(
    resolveDshHome({ DSH_HOME: "C:\\custom\\dsh" }, "C:\\Users\\me"),
    path.resolve("C:\\custom\\dsh")
  );
  assert.equal(
    resolveDshHome({ DSH_HOME: "   " }, "C:\\Users\\me"),
    path.resolve(path.join("C:\\Users\\me", ".dsh"))
  );
  assert.equal(
    resolveDshHome({}, "C:\\Users\\me"),
    path.resolve(path.join("C:\\Users\\me", ".dsh"))
  );
});

test("resolveDshHome expands the tilde forms dsh accepts", () => {
  assert.equal(
    resolveDshHome({ DSH_HOME: "~/elsewhere" }, "C:\\Users\\me"),
    path.resolve(path.join("C:\\Users\\me", "elsewhere"))
  );
});

test("isBundleMountable follows the installation anchor first", (t) => {
  const install = createScratchInstall([
    { name: "@liustack/modlens", declaresBundle: true }
  ]);
  t.after(() => rmSync(install.root, { recursive: true, force: true }));

  const profileDir = path.join(createScratchHome(), "profiles", "web");
  t.after(() => rmSync(path.dirname(path.dirname(profileDir)), { recursive: true, force: true }));

  assert.equal(isBundleMountable("@liustack/modlens", install.anchor, profileDir), true);
  assert.equal(isBundleMountable("not-installed", install.anchor, profileDir), false);
});

test("isBundleMountable rejects a package that declares no dsh.bundle", (t) => {
  const install = createScratchInstall([
    { name: "plain-library", declaresBundle: false }
  ]);
  t.after(() => rmSync(install.root, { recursive: true, force: true }));

  const profileDir = path.join(createScratchHome(), "profiles", "web");
  t.after(() => rmSync(path.dirname(path.dirname(profileDir)), { recursive: true, force: true }));

  // dsh aborts the whole boot on a listed bundle without dsh.bundle, so this
  // must read as unmountable rather than as a usable layer.
  assert.equal(isBundleMountable("plain-library", install.anchor, profileDir), false);
});

test("isBundleMountable finds a bundle installed inside the profile", (t) => {
  const install = createScratchInstall([]);
  t.after(() => rmSync(install.root, { recursive: true, force: true }));
  const home = createScratchHome();
  t.after(() => rmSync(home, { recursive: true, force: true }));

  const profileDir = resolveWebProfileDir(home);
  const pluginDir = path.join(profileDir, "node_modules", "@liustack", "modlens");
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(
    path.join(pluginDir, "package.json"),
    JSON.stringify({ name: "@liustack/modlens", dsh: { bundle: { patch: "./cordis.patch.yml" } } })
  );

  assert.equal(isBundleMountable("@liustack/modlens", install.anchor, profileDir), true);
});

test("ensureWebProfilePlugins creates the profile from the shipped template", (t) => {
  const install = createScratchInstall([
    { name: "@liustack/modlens", declaresBundle: true }
  ]);
  const home = createScratchHome();
  t.after(() => {
    rmSync(install.root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  const result = ensureWebProfilePlugins({ home, installAnchor: install.anchor });

  assert.equal(result.status, "created");
  assert.deepEqual(result.bundles, [
    "@deepseek-ai/dsh-base",
    "@deepseek-ai/dsh-web-app",
    "@liustack/modlens"
  ]);
  assert.deepEqual(readProfileManifest(result.profileDir), {
    name: "dsh-profile-web",
    private: true,
    // A bundled plugin is a profile dependency as well as a layer: the official
    // Plugins page lists a package only when the profile declares it as one, so
    // the pin is what makes a plugin this application ships visible there.
    dependencies: { "@liustack/modlens": "1.0.0" },
    dsh: {
      profile: {
        bundles: [
          "@deepseek-ai/dsh-base",
          "@deepseek-ai/dsh-web-app",
          "@liustack/modlens"
        ]
      }
    }
  });
  // Byte-identical to @deepseek-ai/dsh-app-boot's PROFILE_PATCH_TEMPLATE, so a
  // profile this application creates is indistinguishable from dsh's own.
  assert.equal(
    readFileSync(path.join(result.profileDir, "cordis.patch.yml"), "utf8"),
    `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
[]
`
  );
  assert.match(
    readFileSync(path.join(result.profileDir, "pnpm-workspace.yaml"), "utf8"),
    /nodeLinker: hoisted/
  );
  // pnpm 10.4.0 ignores `autoInstallPeers` in that workspace file, so the
  // setting only reaches pnpm through the profile's own `.npmrc` — and the same
  // file is where the workspace-root check is turned off, since a profile is a
  // pnpm workspace root and the plugin manager installs without asking.
  const npmrc = readFileSync(path.join(result.profileDir, ".npmrc"), "utf8");
  assert.match(npmrc, /^auto-install-peers=false$/m);
  assert.match(npmrc, /^ignore-workspace-root-check=true$/m);
  // The composed row is imported by the loader from the profile directory, so
  // the plugin has to exist there — composing the layer alone is not enough.
  assert.deepEqual(result.installed, ["@liustack/modlens"]);
  assert.equal(
    readManifestVersion(
      path.join(result.profileDir, "node_modules", "@liustack", "modlens")
    ),
    "1.0.0"
  );
  assert.equal(
    existsSync(path.join(result.profileDir, "node_modules", ".harness-desktop-staging")),
    false
  );
});

test("ensureWebProfilePlugins leaves a matching profile installation alone", (t) => {
  const install = createScratchInstall([
    { name: "@liustack/modlens", declaresBundle: true }
  ]);
  const home = createScratchHome();
  t.after(() => {
    rmSync(install.root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  const installedDir = path.join(
    resolveWebProfileDir(home),
    "node_modules",
    "@liustack",
    "modlens"
  );
  mkdirSync(installedDir, { recursive: true });
  writeFileSync(
    path.join(installedDir, "package.json"),
    JSON.stringify({ name: "@liustack/modlens", version: "1.0.0" })
  );
  writeFileSync(path.join(installedDir, "keep.txt"), "keep");

  const result = ensureWebProfilePlugins({ home, installAnchor: install.anchor });

  assert.deepEqual(result.installed, []);
  assert.equal(readFileSync(path.join(installedDir, "keep.txt"), "utf8"), "keep");
});

test("ensureWebProfilePlugins replaces an outdated profile installation", (t) => {
  const install = createScratchInstall([
    { name: "@liustack/modlens", declaresBundle: true }
  ]);
  const home = createScratchHome();
  t.after(() => {
    rmSync(install.root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  const installedDir = path.join(
    resolveWebProfileDir(home),
    "node_modules",
    "@liustack",
    "modlens"
  );
  mkdirSync(installedDir, { recursive: true });
  writeFileSync(
    path.join(installedDir, "package.json"),
    JSON.stringify({ name: "@liustack/modlens", version: "0.0.1" })
  );
  writeFileSync(path.join(installedDir, "stale.txt"), "stale");

  const result = ensureWebProfilePlugins({ home, installAnchor: install.anchor });

  assert.deepEqual(result.installed, ["@liustack/modlens"]);
  assert.equal(readManifestVersion(installedDir), "1.0.0");
  assert.equal(existsSync(path.join(installedDir, "stale.txt")), false);
});

test("ensureWebProfilePlugins installs nothing for an unresolvable plugin", (t) => {
  const install = createScratchInstall([]);
  const home = createScratchHome();
  t.after(() => {
    rmSync(install.root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  const result = ensureWebProfilePlugins({ home, installAnchor: install.anchor });

  assert.equal(result.status, "skipped");
  assert.deepEqual(result.installed, []);
});

test("ensureWebProfilePlugins refuses to invent a template for another dsh", (t) => {
  const install = createScratchInstall([
    { name: "@liustack/modlens", declaresBundle: true }
  ]);
  const home = createScratchHome();
  t.after(() => {
    rmSync(install.root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  const result = ensureWebProfilePlugins({
    home,
    installAnchor: install.anchor,
    installedDshVersion: "0.1.6"
  });

  assert.equal(result.status, "skipped");
  assert.match(result.reason ?? "", /not the supported/);
  assert.equal(readInstalledDshVersion(install.anchor), SUPPORTED_DSH_VERSION);
  assert.throws(() => readProfileManifest(result.profileDir));
  // A profile this application declines to manage collects no files from it.
  assert.equal(existsSync(path.join(result.profileDir, ".npmrc")), false);
});

test("ensureWebProfilePlugins appends to an existing profile and preserves it", (t) => {
  const install = createScratchInstall([
    { name: "@liustack/modlens", declaresBundle: true }
  ]);
  const home = createScratchHome();
  t.after(() => {
    rmSync(install.root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  const profileDir = resolveWebProfileDir(home);
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(
    path.join(profileDir, "package.json"),
    JSON.stringify({
      name: "dsh-profile-web",
      private: true,
      dependencies: { "user-plugin": "^2.0.0" },
      customField: { keep: true },
      dsh: {
        profile: {
          bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "user-plugin"],
          patchReload: "startup"
        }
      }
    })
  );

  const result = ensureWebProfilePlugins({ home, installAnchor: install.anchor });

  assert.equal(result.status, "updated");
  assert.deepEqual(readProfileManifest(profileDir), {
    name: "dsh-profile-web",
    private: true,
    dependencies: { "user-plugin": "^2.0.0", "@liustack/modlens": "1.0.0" },
    customField: { keep: true },
    dsh: {
      profile: {
        bundles: [
          "@deepseek-ai/dsh-base",
          "@deepseek-ai/dsh-web-app",
          "user-plugin",
          "@liustack/modlens"
        ],
        patchReload: "startup"
      }
    }
  });
});

test("a bundled plugin is pinned to the version this installation ships", (t) => {
  const install = createScratchInstall([
    { name: "@liustack/modlens", declaresBundle: true }
  ]);
  const home = createScratchHome();
  t.after(() => {
    rmSync(install.root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  const profileDir = resolveWebProfileDir(home);
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(
    path.join(profileDir, "package.json"),
    JSON.stringify({
      name: "dsh-profile-web",
      private: true,
      // A copy the user pinned themselves, at a version this application does
      // not ship.
      dependencies: { "@liustack/modlens": "^0.9.0" },
      dsh: { profile: { bundles: ["@deepseek-ai/dsh-base"] } }
    })
  );

  const result = ensureWebProfilePlugins({ home, installAnchor: install.anchor });

  assert.equal(result.status, "updated");
  // The recorded version follows the copy, not the user's range: the profile
  // copy is replaced with the shipped one, so a range that names a version the
  // profile does not hold would describe a state that is not on disk.
  assert.equal(
    (readProfileManifest(profileDir).dependencies as Record<string, string>)[
      "@liustack/modlens"
    ],
    "1.0.0"
  );
});

test("ensureWebProfilePlugins writes the peer setting into a profile dsh created", (t) => {
  const install = createScratchInstall([
    { name: "@liustack/modlens", declaresBundle: true }
  ]);
  const home = createScratchHome();
  t.after(() => {
    rmSync(install.root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  // `dsh web` on its own writes the workspace template but no `.npmrc`, and a
  // profile installed from a release before that file existed looks the same.
  // Without it pnpm resolves a plugin's peers from the registry instead of
  // leaving them to the installation that provides them.
  const profileDir = resolveWebProfileDir(home);
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(
    path.join(profileDir, "package.json"),
    JSON.stringify({
      name: "dsh-profile-web",
      private: true,
      dsh: {
        profile: {
          bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"],
          patchReload: "live"
        }
      }
    })
  );

  const result = ensureWebProfilePlugins({ home, installAnchor: install.anchor });

  assert.equal(result.status, "updated");
  assert.match(
    readFileSync(path.join(profileDir, ".npmrc"), "utf8"),
    /^auto-install-peers=false$/m
  );
});

test("ensureWebProfilePlugins adds only the settings a profile's own .npmrc lacks", (t) => {
  const install = createScratchInstall([
    { name: "@liustack/modlens", declaresBundle: true }
  ]);
  const home = createScratchHome();
  t.after(() => {
    rmSync(install.root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  const profileDir = resolveWebProfileDir(home);
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(
    path.join(profileDir, "package.json"),
    JSON.stringify({
      name: "dsh-profile-web",
      private: true,
      dsh: { profile: { bundles: ["@deepseek-ai/dsh-base"] } }
    })
  );
  writeFileSync(
    path.join(profileDir, ".npmrc"),
    "registry=https://registry.npmmirror.com\nauto-install-peers=true\n"
  );

  ensureWebProfilePlugins({ home, installAnchor: install.anchor });

  // The file configures the user's own pnpm: a setting it already carries is
  // theirs, even when this application would have written another value, and
  // one it lacks is appended rather than the file being rewritten.
  assert.equal(
    readFileSync(path.join(profileDir, ".npmrc"), "utf8"),
    "registry=https://registry.npmmirror.com\nauto-install-peers=true\nignore-workspace-root-check=true\n"
  );

  // A second run has nothing left to add.
  ensureWebProfilePlugins({ home, installAnchor: install.anchor });
  assert.equal(
    readFileSync(path.join(profileDir, ".npmrc"), "utf8"),
    "registry=https://registry.npmmirror.com\nauto-install-peers=true\nignore-workspace-root-check=true\n"
  );
});

test("ensureWebProfilePlugins is idempotent", (t) => {
  const install = createScratchInstall([
    { name: "@liustack/modlens", declaresBundle: true }
  ]);
  const home = createScratchHome();
  t.after(() => {
    rmSync(install.root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  const first = ensureWebProfilePlugins({ home, installAnchor: install.anchor });
  const manifestPath = path.join(first.profileDir, "package.json");
  const afterFirst = readFileSync(manifestPath, "utf8");

  const second = ensureWebProfilePlugins({ home, installAnchor: install.anchor });

  assert.equal(second.status, "unchanged");
  assert.deepEqual(second.installed, []);
  assert.equal(readFileSync(manifestPath, "utf8"), afterFirst);
});

test("ensureWebProfilePlugins drops a managed bundle that stopped resolving", (t) => {
  const install = createScratchInstall([]);
  const home = createScratchHome();
  t.after(() => {
    rmSync(install.root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  const profileDir = resolveWebProfileDir(home);
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(
    path.join(profileDir, "package.json"),
    JSON.stringify({
      name: "dsh-profile-web",
      dsh: {
        profile: {
          bundles: [
            "@deepseek-ai/dsh-base",
            "@deepseek-ai/dsh-web-app",
            "@liustack/modlens",
            "user-plugin"
          ],
          patchReload: "live"
        }
      }
    })
  );

  const result = ensureWebProfilePlugins({ home, installAnchor: install.anchor });

  // Left in place, the unresolvable entry would abort the next boot; the
  // user's own bundle is untouched.
  assert.equal(result.status, "updated");
  assert.deepEqual(result.bundles, [
    "@deepseek-ai/dsh-base",
    "@deepseek-ai/dsh-web-app",
    "user-plugin"
  ]);
});

test("ensureWebProfilePlugins leaves a malformed manifest alone", (t) => {
  const install = createScratchInstall([
    { name: "@liustack/modlens", declaresBundle: true }
  ]);
  const home = createScratchHome();
  t.after(() => {
    rmSync(install.root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  const profileDir = resolveWebProfileDir(home);
  mkdirSync(profileDir, { recursive: true });
  const manifestPath = path.join(profileDir, "package.json");
  writeFileSync(manifestPath, "{ not json");

  const result = ensureWebProfilePlugins({ home, installAnchor: install.anchor });

  assert.equal(result.status, "skipped");
  assert.equal(readFileSync(manifestPath, "utf8"), "{ not json");
});

test("every bundled plugin is a pinned dependency of this package", () => {
  const manifest = JSON.parse(
    readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8")
  ) as { dependencies?: Record<string, string> };

  for (const plugin of BUNDLED_PROFILE_PLUGINS) {
    const declared = manifest.dependencies?.[plugin];
    assert.ok(declared, `${plugin} must be a dependency so packaging ships it`);
    assert.match(declared, /^\d+\.\d+\.\d+/, `${plugin} must be pinned exactly`);
  }
});

/**
 * A profile whose third-party plugins are in place, and the scratch install
 * that resolves them. `plugins` names the third-party bundles the profile
 * carries; the managed additions come from `ensureWebProfilePlugins` itself.
 */
function createProfileWithPlugins(
  t: { after: (fn: () => void) => void },
  plugins: readonly string[]
): { home: string; anchor: string; profileDir: string } {
  const install = createScratchInstall([
    { name: "@liustack/modlens", declaresBundle: true },
    ...plugins.map((name) => ({ name, declaresBundle: true }))
  ]);
  const home = createScratchHome();
  t.after(() => {
    rmSync(install.root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  const created = ensureWebProfilePlugins({
    home,
    installAnchor: install.anchor,
    additions: ["@liustack/modlens"]
  });
  assert.equal(created.status, "created");

  // What `dsh plugin add` leaves behind: the installed name joins the layer
  // list, which is the list a failed start has to prune.
  const profileDir = resolveWebProfileDir(home);
  const manifestPath = path.join(profileDir, "package.json");
  const manifest = readProfileManifest(profileDir);
  const profile = (manifest.dsh as { profile: { bundles: string[] } }).profile;
  profile.bundles.push(...plugins);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  return { home, anchor: install.anchor, profileDir };
}

function readBundles(profileDir: string): string[] {
  const manifest = readProfileManifest(profileDir);
  return (manifest.dsh as { profile: { bundles: string[] } }).profile.bundles;
}

test("third-party bundles are the ones this application does not manage", (t) => {
  const { home, anchor } = createProfileWithPlugins(t, ["dsh-free-search"]);

  assert.deepEqual(
    thirdPartyProfileBundles({ home, installAnchor: anchor, additions: ["@liustack/modlens"] }),
    ["dsh-free-search"]
  );
});

/**
 * dsh fails to boot at all when a plugin cannot be composed or imported, and
 * the profile's layer list is the only lever this application has. The removal
 * has to be recorded, or the next launch composes the same failing plugin again.
 */
test("a failed start drops one plugin bundle and can hand it back", (t) => {
  const { home, anchor, profileDir } = createProfileWithPlugins(t, [
    "dsh-free-search",
    "dsh-dream-skin"
  ]);
  const options = { home, installAnchor: anchor, additions: ["@liustack/modlens"] };

  const record = quarantineProfileBundles({
    ...options,
    names: ["dsh-dream-skin"],
    reason: "startup-failure"
  });

  assert.equal(record?.reason, "startup-failure");
  assert.deepEqual(record?.disabled, ["dsh-dream-skin"]);
  assert.deepEqual(readBundles(profileDir), [
    "@deepseek-ai/dsh-base",
    "@deepseek-ai/dsh-web-app",
    "@liustack/modlens",
    "dsh-free-search"
  ]);
  assert.deepEqual(readQuarantine(home)?.disabled, ["dsh-dream-skin"]);

  // A bundle this application manages is copied back on every start, so it can
  // never be a candidate: the request leaves the record exactly as it was.
  const unchanged = quarantineProfileBundles({
    ...options,
    names: ["@liustack/modlens"],
    reason: "safe-mode"
  });
  assert.deepEqual(unchanged?.disabled, ["dsh-dream-skin"]);
  assert.ok(readBundles(profileDir).includes("@liustack/modlens"));

  assert.deepEqual(restoreQuarantinedBundles(options), ["dsh-dream-skin"]);
  assert.ok(readBundles(profileDir).includes("dsh-dream-skin"));
  assert.equal(readQuarantine(home), undefined);
});

/**
 * The record outlives the launch that wrote it, and a launch that undoes its own
 * recovery knows nothing about the removals before it: handing those back would
 * reinstate a bundle another launch already found unmountable.
 */
test("restoring this launch's removals leaves an earlier launch's alone", (t) => {
  const { home, anchor, profileDir } = createProfileWithPlugins(t, [
    "dsh-free-search",
    "dsh-dream-skin"
  ]);
  const options = { home, installAnchor: anchor, additions: ["@liustack/modlens"] };

  quarantineProfileBundles({
    ...options,
    names: ["dsh-free-search"],
    reason: "startup-failure"
  });
  quarantineProfileBundles({
    ...options,
    names: ["dsh-dream-skin"],
    reason: "startup-failure"
  });

  assert.deepEqual(
    restoreQuarantinedBundles({ ...options, names: ["dsh-dream-skin"] }),
    ["dsh-dream-skin"]
  );
  assert.ok(readBundles(profileDir).includes("dsh-dream-skin"));
  assert.ok(!readBundles(profileDir).includes("dsh-free-search"));
  assert.deepEqual(readQuarantine(home)?.disabled, ["dsh-free-search"]);

  // A name the record does not hold restores nothing, so the record stands.
  assert.deepEqual(
    restoreQuarantinedBundles({ ...options, names: ["dsh-not-installed"] }),
    []
  );
  assert.deepEqual(readQuarantine(home)?.disabled, ["dsh-free-search"]);
});

test("a restored bundle that no longer resolves stays out of the layer list", (t) => {
  const { home, profileDir } = createProfileWithPlugins(t, ["dsh-live2d-pets"]);
  quarantineProfileBundles({ home, names: ["dsh-live2d-pets"], reason: "startup-failure" });

  // The same profile, but the plugin is gone from the installation: restoring it
  // would abort the boot this recovery exists to repair.
  const replacement = createScratchInstall([{ name: "@liustack/modlens", declaresBundle: true }]);
  t.after(() => {
    rmSync(replacement.root, { recursive: true, force: true });
  });

  assert.deepEqual(
    restoreQuarantinedBundles({ home, installAnchor: replacement.anchor }),
    []
  );
  assert.ok(!readBundles(profileDir).includes("dsh-live2d-pets"));
  assert.equal(readQuarantine(home), undefined);
});

test("safe mode records why the plugins went away", (t) => {
  const { home, anchor, profileDir } = createProfileWithPlugins(t, [
    "dsh-free-search",
    "dsh-dream-skin"
  ]);

  const record = quarantineProfileBundles({
    home,
    installAnchor: anchor,
    additions: ["@liustack/modlens"],
    names: ["dsh-free-search", "dsh-dream-skin"],
    reason: "safe-mode"
  });

  assert.equal(record?.reason, "safe-mode");
  assert.deepEqual(readQuarantine(home), record);
  assert.deepEqual(readBundles(profileDir), [
    "@deepseek-ai/dsh-base",
    "@deepseek-ai/dsh-web-app",
    "@liustack/modlens"
  ]);
});

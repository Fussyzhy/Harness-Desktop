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
  readInstalledDshVersion,
  resolveDshHome,
  resolveWebProfileDir
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
    dependencies: {},
    dsh: {
      profile: {
        bundles: [
          "@deepseek-ai/dsh-base",
          "@deepseek-ai/dsh-web-app",
          "@liustack/modlens"
        ],
        patchReload: "live"
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
    dependencies: { "user-plugin": "^2.0.0" },
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

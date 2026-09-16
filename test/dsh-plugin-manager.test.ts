import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  BUNDLED_LOCAL_PROFILE_PLUGINS,
  SUPPORTED_DSH_VERSION,
  ensureWebProfilePlugins,
  resolveLocalBundleDir
} from "../src/dsh-profile.js";
import { PLUGIN_MANAGER_ENV_KEYS } from "../src/dsh-plugins.js";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_DIR = path.join(repoRoot, "plugins", "dsh-plugin-manager");

function readPluginFile(...parts: string[]): string {
  return readFileSync(path.join(PLUGIN_DIR, ...parts), "utf8");
}

function readPluginManifest(): {
  name: string;
  exports: Record<string, string>;
  dsh: {
    bundle: { patch: string };
    client: { platform: string; inject: string[]; immediately?: boolean };
  };
} {
  return JSON.parse(readPluginFile("package.json"));
}

/**
 * A bundle that dsh cannot fully resolve does not degrade — it fails the boot.
 * `dsh-client-modules` throws when a package declares `dsh.client` but ships no
 * `exports["./client"]`, and the client bundle in turn must be a classic script
 * that registers its own package name. These tests hold the shipped package to
 * that contract, because nothing else runs it until an application boots.
 */
test("the plugin manager declares both halves of a dsh bundle", () => {
  const manifest = readPluginManifest();

  assert.equal(manifest.name, "@harness-desktop/dsh-plugin-manager");
  assert.equal(manifest.dsh.bundle.patch, "./cordis.patch.yml");
  assert.equal(manifest.dsh.client.platform, "web");

  // Every declared path must exist in the published files, or dsh finds a
  // declaration without the file behind it.
  for (const relative of [
    manifest.dsh.bundle.patch,
    manifest.exports["."],
    manifest.exports["./client"]
  ]) {
    assert.doesNotThrow(
      () => readPluginFile(relative),
      `${relative} must exist in the package`
    );
  }
});

test("the bundle patch mounts the package by its own name", () => {
  const manifest = readPluginManifest();
  const patch = readPluginFile(manifest.dsh.bundle.patch);

  assert.match(patch, /- insert:/);
  assert.ok(
    patch.includes(`name: '${manifest.name}'`) ||
      patch.includes(`name: "${manifest.name}"`),
    "the inserted row must name the package exactly"
  );
});

test("the client half is a classic script that registers the package name", () => {
  const manifest = readPluginManifest();
  const client = readPluginFile(manifest.exports["./client"]);

  assert.ok(client.includes("__ModuleLoader__.load"));
  assert.ok(client.includes(`id: '${manifest.name}'`));
  // A client bundle is served as a classic script; module syntax would never run.
  assert.ok(
    !/(^|\n)\s*(import|export)\s/.test(client),
    "the client half must not use ESM syntax"
  );
});

test("the card and the host half agree on the settings namespace and route", () => {
  const host = readPluginFile("dsh", "index.js");
  const client = readPluginFile("dsh", "client.js");

  // The card is dispatched by key: a namespace the host does not serve leaves a
  // card that never renders, and a route mismatch leaves one that never answers.
  const hostNamespace = /const SETTINGS_NAMESPACE = "([^"]+)"/.exec(host)?.[1];
  const clientNamespace = /var NAMESPACE = '([^']+)'/.exec(client)?.[1];
  assert.ok(hostNamespace, "the host half must declare its settings namespace");
  assert.equal(clientNamespace, hostNamespace);

  const hostRoute = /const ROUTE_PATH = "([^"]+)"/.exec(host)?.[1];
  const clientRoute = /var ROUTE = '([^']+)'/.exec(client)?.[1];
  assert.ok(hostRoute, "the host half must declare its route");
  assert.equal(clientRoute, hostRoute);
});

interface ClientRegistration {
  id: string;
  factory: (loadModule: (specifier: string) => unknown) => any;
}

/**
 * Evaluate the client bundle the way the browser does — as a classic script, not
 * as a module — and hand back what it registered.
 *
 * A syntax error or a throw at load time in this file takes the whole settings
 * page down with it, and no compiler ever looks at it: it is only ever served to
 * a browser as text.
 */
function loadClientBundle(): ClientRegistration[] {
  const manifest = readPluginManifest();
  const source = readPluginFile(manifest.exports["./client"]);
  const registrations: ClientRegistration[] = [];
  const fakeWindow = {
    __ModuleLoader__: {
      load: (entry: ClientRegistration) => {
        registrations.push(entry);
      }
    }
  };
  const fakeFetch = () =>
    Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });

  new Function("window", "document", "navigator", "fetch", source)(
    fakeWindow,
    { documentElement: { lang: "zh-CN" } },
    { language: "zh-CN" },
    fakeFetch
  );

  return registrations;
}

test("the client bundle loads as a classic script and registers its factory", () => {
  const registrations = loadClientBundle();

  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].id, "@harness-desktop/dsh-plugin-manager");

  // The module table answers bare specifiers; anything else throws. Only `react`
  // is asked for, and only when the plugin is applied.
  const plugin = registrations[0].factory((request) => {
    throw new Error(`unexpected module request: ${request}`);
  });
  assert.equal(typeof plugin.apply, "function");
  assert.deepEqual(plugin.inject, ["slots"]);
});

test("the client half registers a card the settings page can dispatch", async () => {
  const registrations = loadClientBundle();
  // `createElement` is read while the component is built; the component itself
  // is never rendered here.
  const plugin = registrations[0].factory(() => ({ createElement: () => null }));

  const registered: { options: unknown; component: unknown }[] = [];
  plugin.apply({
    slots: {
      inject: (_name: string, generator: () => Iterator<unknown>) => {
        generator().next();
      },
      register: (options: unknown, component: unknown) => {
        registered.push({ options, component });
        return () => {};
      }
    }
  });

  // Registration rides the route probe, which is a promise.
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(registered.length, 1);
  // The key is the settings namespace the host half serves; a card keyed to a
  // namespace nobody answers for is never rendered.
  assert.deepEqual(registered[0].options, {
    name: "settings.plugin.item",
    key: "harness-desktop-plugins"
  });
  assert.equal(typeof registered[0].component, "function");
});

test("the host half reads exactly the environment the shell injects", () => {
  const host = readPluginFile("dsh", "index.js");

  // The shell owns these paths — pnpm, the dsh CLI, the shim, the store — and
  // the plugin owns the package-manager call. A rename on either side would
  // otherwise only show up as "installation is unavailable" at runtime.
  for (const key of Object.values(PLUGIN_MANAGER_ENV_KEYS)) {
    assert.ok(host.includes(key), `the host half must read ${key}`);
  }
});

test("the local bundle list matches the package it points at", () => {
  assert.ok(
    BUNDLED_LOCAL_PROFILE_PLUGINS.length > 0,
    "the plugin manager must be a bundled local plugin"
  );

  for (const plugin of BUNDLED_LOCAL_PROFILE_PLUGINS) {
    const manifest = JSON.parse(
      readFileSync(path.join(repoRoot, plugin.directory, "package.json"), "utf8")
    );
    // dsh mounts the bundle by this name, so a rename that misses the list
    // silently drops the plugin from every fresh profile.
    assert.equal(manifest.name, plugin.name);
  }
});

test("a local bundle resolves out of app.asar into the unpacked tree", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "harness-desktop-local-bundle-"));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const relative = path.join("plugins", "dsh-plugin-manager");
  const unpacked = path.join(dir, "app.asar.unpacked", relative);
  mkdirSync(unpacked, { recursive: true });
  writeFileSync(
    path.join(unpacked, "package.json"),
    JSON.stringify({ name: "@harness-desktop/dsh-plugin-manager" })
  );

  assert.equal(
    resolveLocalBundleDir(
      { name: "@harness-desktop/dsh-plugin-manager", directory: relative },
      path.join(dir, "app.asar")
    ),
    unpacked
  );
});

test("a local bundle that is not shipped resolves to nothing", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "harness-desktop-local-bundle-"));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  assert.equal(
    resolveLocalBundleDir(
      { name: "@harness-desktop/dsh-plugin-manager", directory: "plugins/absent" },
      dir
    ),
    undefined
  );
});

/** A throwaway dsh installation whose anchor reports the supported version. */
function createScratchInstall(t: { after: (fn: () => void) => void }): string {
  const root = mkdtempSync(path.join(tmpdir(), "harness-desktop-manager-install-"));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const anchor = path.join(root, "dsh", "package.json");
  mkdirSync(path.dirname(anchor), { recursive: true });
  writeFileSync(anchor, JSON.stringify({ name: "dsh", version: SUPPORTED_DSH_VERSION }));
  return anchor;
}

function createScratchHome(t: { after: (fn: () => void) => void }): string {
  const home = mkdtempSync(path.join(tmpdir(), "harness-desktop-manager-home-"));
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
  });
  return home;
}

test("the application's own plugin joins a fresh profile with both halves", (t) => {
  const result = ensureWebProfilePlugins({
    home: createScratchHome(t),
    installAnchor: createScratchInstall(t),
    // No registry plugins: this is about the local tree only.
    additions: [],
    localAdditions: BUNDLED_LOCAL_PROFILE_PLUGINS,
    appRoot: repoRoot
  });

  assert.equal(result.status, "created");
  assert.deepEqual(result.bundles, [
    "@deepseek-ai/dsh-base",
    "@deepseek-ai/dsh-web-app",
    "@harness-desktop/dsh-plugin-manager"
  ]);
  assert.deepEqual(result.installed, ["@harness-desktop/dsh-plugin-manager"]);

  // The profile copy is what dsh composes and imports, so both halves have to
  // arrive: a package that declares dsh.client and ships no client bundle stops
  // the whole boot rather than losing a feature.
  const copied = path.join(
    result.profileDir,
    "node_modules",
    "@harness-desktop",
    "dsh-plugin-manager"
  );
  for (const relative of [
    "package.json",
    "cordis.patch.yml",
    path.join("dsh", "index.js"),
    path.join("dsh", "client.js")
  ]) {
    assert.ok(
      existsSync(path.join(copied, relative)),
      `${relative} must be copied into the profile`
    );
  }
});

test("a damaged local bundle is restored on the next launch", (t) => {
  const home = createScratchHome(t);
  const installAnchor = createScratchInstall(t);
  const options = {
    home,
    installAnchor,
    additions: [],
    localAdditions: BUNDLED_LOCAL_PROFILE_PLUGINS,
    appRoot: repoRoot
  };

  const first = ensureWebProfilePlugins(options);
  const copied = path.join(
    first.profileDir,
    "node_modules",
    "@harness-desktop",
    "dsh-plugin-manager"
  );
  const clientHalf = path.join(copied, "dsh", "client.js");
  assert.ok(existsSync(clientHalf));
  rmSync(clientHalf);

  // Local bundles ship with the application rather than from a registry, so the
  // version cannot be trusted to say whether the copy is current: it is always
  // rewritten.
  const second = ensureWebProfilePlugins(options);

  assert.deepEqual(second.installed, ["@harness-desktop/dsh-plugin-manager"]);
  assert.ok(existsSync(clientHalf), "the missing client half must come back");
});

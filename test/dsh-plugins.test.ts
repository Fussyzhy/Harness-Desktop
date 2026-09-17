import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DSH_RESTART_EXIT_CODE,
  PLUGIN_MANAGER_ENV_KEYS,
  PNPM_CONFIG_ENV,
  buildDshPluginArguments,
  buildPluginManagerEnv,
  createPnpmShim,
  preparePluginManagerEnvironment,
  resolvePnpmScriptPath
} from "../src/dsh-plugins.js";

function makeTempDir(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(path.join(tmpdir(), "harness-desktop-plugins-"));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test("pnpm resolves through its package.json export into app.asar.unpacked", (t) => {
  const dir = makeTempDir(t);
  const packageDir = path.join(dir, "resources", "app.asar", "node_modules", "pnpm");
  const packageJsonPath = path.join(packageDir, "package.json");
  const scriptPath = path.join(packageDir, "bin", "pnpm.cjs");
  mkdirSync(path.dirname(scriptPath), { recursive: true });
  writeFileSync(packageJsonPath, "{}");
  writeFileSync(scriptPath, "// probe");

  // pnpm's manifest maps "." to ./package.json, so the bare specifier is all a
  // caller may resolve; the CLI entry is joined onto it.
  assert.equal(
    resolvePnpmScriptPath({
      resolve: (id: string) => {
        assert.equal(id, "pnpm");
        return packageJsonPath;
      }
    }),
    scriptPath.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`)
  );
});

test("pnpm resolution accepts a require that already points at the CLI entry", (t) => {
  const dir = makeTempDir(t);
  const scriptPath = path.join(dir, "bin", "pnpm.cjs");
  mkdirSync(path.dirname(scriptPath), { recursive: true });
  writeFileSync(scriptPath, "// probe");

  assert.equal(resolvePnpmScriptPath({ resolve: () => scriptPath }), scriptPath);
});

test("pnpm resolution fails loudly when the package is missing", () => {
  assert.throws(
    () =>
      resolvePnpmScriptPath({
        resolve: () => {
          throw new Error("MODULE_NOT_FOUND");
        }
      }),
    /bundled pnpm package is missing/
  );
});

test("pnpm resolution fails when the package ships no CLI entry", () => {
  assert.throws(
    () =>
      resolvePnpmScriptPath({
        resolve: () => path.join(tmpdir(), "pnpm-that-is-not-there", "package.json")
      }),
    /CLI entry is missing/
  );
});

test("the Windows shim runs pnpm on Electron's Node runtime", (t) => {
  const dir = makeTempDir(t);
  const shimPath = createPnpmShim(dir, {
    pnpmScript: "C:\\Program Files\\Harness Desktop\\pnpm.cjs",
    electronPath: "C:\\Program Files\\Harness Desktop\\electron.exe",
    platform: "win32"
  });

  assert.equal(shimPath, path.join(dir, "pnpm.cmd"));
  const contents = readFileSync(shimPath, "utf8");
  assert.match(contents, /^@echo off/);
  assert.match(contents, /set "ELECTRON_RUN_AS_NODE=1"/);
  assert.match(
    contents,
    /"C:\\Program Files\\Harness Desktop\\electron\.exe" "C:\\Program Files\\Harness Desktop\\pnpm\.cjs" %\*/
  );

  // a second call must leave the file untouched rather than rewriting it
  const before = readFileSync(shimPath, "utf8");
  createPnpmShim(dir, {
    pnpmScript: "C:\\Program Files\\Harness Desktop\\pnpm.cjs",
    electronPath: "C:\\Program Files\\Harness Desktop\\electron.exe",
    platform: "win32"
  });
  assert.equal(readFileSync(shimPath, "utf8"), before);
});

test("the POSIX shim execs pnpm with the caller's arguments", (t) => {
  const dir = makeTempDir(t);
  const shimPath = createPnpmShim(dir, {
    pnpmScript: "/opt/harness/pnpm.cjs",
    electronPath: "/opt/harness/electron",
    platform: "linux"
  });

  assert.equal(shimPath, path.join(dir, "pnpm"));
  const contents = readFileSync(shimPath, "utf8");
  assert.match(contents, /^#!\/bin\/sh/);
  assert.match(
    contents,
    /ELECTRON_RUN_AS_NODE=1 exec "\/opt\/harness\/electron" "\/opt\/harness\/pnpm\.cjs" "\$@"/
  );
});

test("dsh plugin arguments forward pnpm's own flags through the profile", () => {
  assert.deepEqual(
    buildDshPluginArguments({
      action: "add",
      specs: ["@liustack/modlens@3.26.1"],
      storeDir: "C:\\Users\\me\\.dsh\\.pnpm-store"
    }),
    [
      "plugin",
      "--profile",
      "web",
      "add",
      "--workspace-root",
      "@liustack/modlens@3.26.1",
      "--store-dir",
      "C:\\Users\\me\\.dsh\\.pnpm-store"
    ]
  );

  assert.deepEqual(buildDshPluginArguments({ action: "remove", specs: ["@liustack/modlens"] }), [
    "plugin",
    "--profile",
    "web",
    "remove",
    "--workspace-root",
    "@liustack/modlens"
  ]);

  assert.deepEqual(buildDshPluginArguments({ action: "update" }), [
    "plugin",
    "--profile",
    "web",
    "update",
    "--workspace-root"
  ]);
});

test("several specs in one run become several pnpm arguments", () => {
  // A registry plugin whose peers cannot be resolved needs a local companion
  // link in the same run, so one install may carry more than one spec.
  assert.deepEqual(
    buildDshPluginArguments({
      action: "add",
      specs: [
        "@hellosz/dsh-pets",
        "@deepseek-ai/dsh-tools@link:C:/app/node_modules/@deepseek-ai/dsh-tools"
      ]
    }),
    [
      "plugin",
      "--profile",
      "web",
      "add",
      "--workspace-root",
      "@hellosz/dsh-pets",
      "@deepseek-ai/dsh-tools@link:C:/app/node_modules/@deepseek-ai/dsh-tools"
    ]
  );
});

test("an install targets the profile's workspace root explicitly", () => {
  // A profile is a pnpm workspace root, and pnpm refuses a registry install
  // there without `--workspace-root` (ERR_PNPM_ADDING_TO_ROOT). `dsh plugin`
  // forwards arguments verbatim, so nothing else can add the flag.
  const args = buildDshPluginArguments({
    action: "add",
    specs: ["@hellosz/dsh-pets"]
  });

  assert.equal(args.filter((argument) => argument === "--workspace-root").length, 1);
  assert.ok(
    args.indexOf("--workspace-root") > args.indexOf("add"),
    "the flag belongs to the pnpm subcommand"
  );
});

test("the plugin manager environment carries every path the card needs", () => {
  const env = buildPluginManagerEnv({
    pnpmScript: "C:\\app\\pnpm.cjs",
    dshCliPath: "C:\\app\\dsh\\bin.js",
    electronPath: "C:\\app\\electron.exe",
    storeDir: "C:\\Users\\me\\.dsh\\.pnpm-store",
    shimDir: "C:\\Users\\me\\AppData\\Harness Desktop\\bin"
  });

  assert.deepEqual(env, {
    [PLUGIN_MANAGER_ENV_KEYS.pnpmScript]: "C:\\app\\pnpm.cjs",
    [PLUGIN_MANAGER_ENV_KEYS.dshCli]: "C:\\app\\dsh\\bin.js",
    [PLUGIN_MANAGER_ENV_KEYS.electron]: "C:\\app\\electron.exe",
    [PLUGIN_MANAGER_ENV_KEYS.storeDir]: "C:\\Users\\me\\.dsh\\.pnpm-store",
    [PLUGIN_MANAGER_ENV_KEYS.shimDir]: "C:\\Users\\me\\AppData\\Harness Desktop\\bin",
    [PLUGIN_MANAGER_ENV_KEYS.restartExitCode]: String(DSH_RESTART_EXIT_CODE),
    // The literal pnpm reads, not our constant's name: pnpm takes the setting
    // from this environment entry, which `dsh plugin` passes on by inheritance.
    "npm_config_auto_install_peers": "false"
  });
});

test("preparing the environment disables pnpm's peer auto-install", (t) => {
  const dir = makeTempDir(t);
  const prepared = preparePluginManagerEnvironment({
    userDataDir: path.join(dir, "userData"),
    dshHome: path.join(dir, "dsh-home"),
    pnpmScript: path.join(dir, "pnpm", "bin", "pnpm.cjs"),
    dshCliPath: path.join(dir, "dsh", "lib", "bin.js"),
    electronPath: "C:\\app\\electron.exe",
    platform: "win32",
    baseEnv: {}
  });

  // pnpm 10.4.0 ignores `autoInstallPeers` in pnpm-workspace.yaml, so a plugin
  // whose peers are declared as `"*"` would otherwise be resolved from the
  // registry's stale `latest` tag — an install that ends in
  // ERR_PNPM_FETCH_404 (a framework package that names a dependency which was
  // never published) instead of in an installed plugin.
  assert.equal(prepared.env["npm_config_auto_install_peers"], "false");
  assert.deepEqual(PNPM_CONFIG_ENV, { "npm_config_auto_install_peers": "false" });
});

test("preparing the environment puts the shim first on PATH without losing its spelling", (t) => {
  const dir = makeTempDir(t);
  const userDataDir = path.join(dir, "userData");
  const dshHome = path.join(dir, "dsh-home");
  const baseEnv = { Path: "C:\\Windows;C:\\Windows\\System32", KEEP: "me" };

  const prepared = preparePluginManagerEnvironment({
    userDataDir,
    dshHome,
    pnpmScript: path.join(dir, "pnpm", "bin", "pnpm.cjs"),
    dshCliPath: path.join(dir, "dsh", "lib", "bin.js"),
    electronPath: "C:\\app\\electron.exe",
    platform: "win32",
    baseEnv
  });

  assert.equal(prepared.shimPath, path.join(userDataDir, "bin", "pnpm.cmd"));
  assert.equal(prepared.storeDir, path.join(dshHome, ".pnpm-store"));
  // Windows decides by spelling-insensitive name, so the shim must join the
  // entry the shell actually has instead of adding a second spelling of PATH.
  assert.equal(
    prepared.env.Path,
    `${path.join(userDataDir, "bin")}${path.delimiter}${baseEnv.Path}`
  );
  assert.equal(prepared.env.PATH, undefined);
  assert.equal(baseEnv.Path, "C:\\Windows;C:\\Windows\\System32");
});

test("preparing the environment works without an inherited PATH", (t) => {
  const dir = makeTempDir(t);
  const prepared = preparePluginManagerEnvironment({
    userDataDir: path.join(dir, "userData"),
    dshHome: path.join(dir, "dsh-home"),
    pnpmScript: path.join(dir, "pnpm", "bin", "pnpm.cjs"),
    dshCliPath: path.join(dir, "dsh", "lib", "bin.js"),
    electronPath: "/opt/harness/electron",
    platform: "linux",
    baseEnv: {}
  });

  assert.equal(prepared.env.PATH, path.join(dir, "userData", "bin"));
});

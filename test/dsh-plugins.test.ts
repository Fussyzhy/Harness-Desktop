import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { scrubbedParentEnv } from "@deepseek-ai/dsh-subprocess";
import {
  PNPM_CONFIG_ENV,
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

test("preparing the environment disables pnpm's peer auto-install", (t) => {
  const dir = makeTempDir(t);
  const prepared = preparePluginManagerEnvironment({
    userDataDir: path.join(dir, "userData"),
    dshHome: path.join(dir, "dsh-home"),
    pnpmScript: path.join(dir, "pnpm", "bin", "pnpm.cjs"),
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
  assert.deepEqual(PNPM_CONFIG_ENV, {
    "npm_config_auto_install_peers": "false",
    "npm_config_ignore_workspace_root_check": "true"
  });
});

test("preparing the environment turns off pnpm's workspace-root check", (t) => {
  const dir = makeTempDir(t);
  const dshHome = path.join(dir, "dsh-home");
  const prepared = preparePluginManagerEnvironment({
    userDataDir: path.join(dir, "userData"),
    dshHome,
    pnpmScript: path.join(dir, "pnpm", "bin", "pnpm.cjs"),
    electronPath: "C:\\app\\electron.exe",
    platform: "win32",
    baseEnv: {}
  });

  // The official plugin manager runs `pnpm add <spec>` with no --workspace-root
  // flag, and a profile is a pnpm workspace root: without this setting every
  // registry install fails with ERR_PNPM_ADDING_TO_ROOT. The switch travels as
  // the environment entry pnpm reads, because the manager's argument list is
  // built upstream and this application cannot add to it.
  assert.equal(prepared.env["npm_config_ignore_workspace_root_check"], "true");
  // The manager passes no --store-dir either, so the store the previous
  // implementations used is preserved the same way.
  assert.equal(prepared.env["npm_config_store_dir"], path.join(dshHome, ".pnpm-store"));
});

/**
 * The settings above only reach pnpm if they survive the environment the plugin
 * manager starts it with — `scrubbedParentEnv()`, not the dsh child's own
 * environment. `npm_config_*` is where pnpm reads a setting from, and `DSH_*` is
 * what that filter drops, which is why the profile's `.npmrc` has to carry the
 * same settings for a profile this application does not prepare.
 */
test("the pnpm settings survive the environment a service install runs under", (t) => {
  const keys = ["npm_config_ignore_workspace_root_check", "npm_config_store_dir", "DSH_HOME"];
  const saved = keys.map((key) => [key, process.env[key]] as const);
  t.after(() => {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  process.env["npm_config_ignore_workspace_root_check"] = "true";
  process.env["npm_config_store_dir"] = "C:\\probe\\.pnpm-store";
  process.env["DSH_HOME"] = "C:\\probe\\dsh-home";

  const scrubbed = scrubbedParentEnv();

  assert.equal(scrubbed["npm_config_ignore_workspace_root_check"], "true");
  assert.equal(scrubbed["npm_config_store_dir"], "C:\\probe\\.pnpm-store");
  assert.equal(scrubbed["DSH_HOME"], undefined);
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
    electronPath: "/opt/harness/electron",
    platform: "linux",
    baseEnv: {}
  });

  assert.equal(prepared.env.PATH, path.join(dir, "userData", "bin"));
});

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);

/**
 * 安装插件时那个黑色控制台窗口（本仓库曾经用
 * `scripts/patch-dsh-plugin-console-window.cjs` 修掉）在 `0.1.6-alpha.2` 里由上游
 * 自己消失了，所以那个补丁已经退役。
 *
 * 旧形状是 `dsh` 直接转发 pnpm：
 *
 * ```js
 * spawnSync("pnpm", args, { cwd, stdio: "inherit", shell: process.platform === "win32" })
 * ```
 *
 * `shell: true` 起的 `cmd.exe` 是控制台子系统程序，父进程（Electron 主进程）没有控制台，
 * Windows 于是给它新建一个可见控制台。
 *
 * 新形状是 `dsh` 把包管理交给 `@deepseek-ai/dsh-plugin-manager`，后者用 `execa` 启动
 * pnpm；execa 的 `addDefaultOptions` 把 `windowsHide` 默认成 `true`，并且自己解析
 * `pnpm.cmd` 后用 `cmd.exe /d /s /c` 执行（不是 `shell: true`），所以不会再出现黑框。
 *
 * 这些断言就是那条结论的守卫：哪天上游又改回“自己 spawn、或者显式让窗口可见”，这里先失败，
 * 提示把补丁请回来。
 */

function resolvePackageDir(packageName: string): string {
  return path.dirname(require.resolve(`${packageName}/package.json`));
}

/** The single `lib/plugin-*.js` chunk of the installed dsh, if the layout still matches. */
function findDshPluginChunk(dshDir: string): string {
  const libDir = path.join(dshDir, "lib");
  const matches = readdirSync(libDir).filter((name) => /^plugin-.*\.js$/.test(name));
  assert.equal(
    matches.length,
    1,
    `expected exactly one lib/plugin-*.js chunk in ${libDir}, found ${matches.length}`
  );
  return path.join(libDir, matches[0]!);
}

test("the installed dsh no longer forwards pnpm itself", () => {
  const source = readFileSync(
    findDshPluginChunk(resolvePackageDir("@deepseek-ai/dsh")),
    "utf8"
  );

  // `shell: true` on a console-subsystem child is what made the window appear;
  // without a spawn at all there is nothing left to hide.
  assert.ok(
    !source.includes("spawnSync("),
    "dsh forwards pnpm itself again; the plugin console-window patch has to come back"
  );
  assert.match(source, /dsh-plugin-manager\/operations/);
});

test("the plugin manager launches pnpm through execa with its default hidden window", () => {
  const operationsPath = path.join(
    resolvePackageDir("@deepseek-ai/dsh-plugin-manager"),
    "lib",
    "types",
    "operations.js"
  );
  assert.ok(existsSync(operationsPath), `${operationsPath} is missing`);

  const source = readFileSync(operationsPath, "utf8");
  assert.match(source, /from 'execa'/);
  assert.match(source, /execa\(/);

  // execa hides the console by default (`windowsHide = true` in
  // addDefaultOptions) and resolves `pnpm.cmd` without a shell. Either of these
  // would put the black window back.
  assert.ok(
    !/windowsHide\s*:/.test(source),
    "the pnpm spawn overrides windowsHide; check that it stays true"
  );
  assert.ok(
    !/\bshell\s*:/.test(source),
    "the pnpm spawn asks for a shell; that reintroduces the console window"
  );
});

const fs = require("node:fs");
const path = require("node:path");

const SUPPORTED_VERSION = "0.1.6-alpha.1";
const DSH_PACKAGE = "@deepseek-ai/dsh";

/** Default dsh dependency tree: this repository's own `node_modules`. */
const DEFAULT_MODULES_DIR = path.join(__dirname, "..", "node_modules");

/**
 * 用户安装插件时会弹出一个黑色控制台窗口。
 *
 * `dsh plugin --profile <name> <pnpm args>` 是 pnpm 的转发器：它在 profile 目录里
 * `spawnSync("pnpm", args, { cwd, stdio: "inherit", shell: process.platform === "win32" })`。
 * 本应用把 dsh 跑在 Electron 里，而 Electron 主进程是 **GUI 子系统、没有控制台**；
 * 于是 `shell: true` 起的 cmd.exe 是控制台子系统程序、父进程又没有控制台，Windows 给它
 * **新建一个自己的可见控制台**：点一次“安装插件”就闪一个黑框，和 agent 执行命令那批黑框
 * 同源（见 patch-dsh-win32-process-console-window.cjs）。
 *
 * 修法是给这次 `spawnSync` 的 options 加上 `windowsHide: true`：Node 据此传
 * `CREATE_NO_WINDOW`，cmd.exe 不再有可见控制台，`stdio: "inherit"` 转发到 dsh 自己的管道，
 * 输出与退出码不变。
 *
 * 只改这一个 `spawnSync`：文件在 `lib/plugin-<hash>.js`（名字带内容哈希，随版本变化），
 * 所以按目录扫描定位；补丁锁定 dsh 版本，并在替换前先校验原始代码。
 */
const PATCH_MARKER = "/* harness-desktop: no console window */";

/**
 * `stdio: "inherit"` 紧跟 `shell: <win32>` 的那个 options 对象，只可能属于 pnpm 转发那次
 * `spawnSync`。缩进单独捕获，好让插入的行与原文件对齐。
 */
const PNPM_SPAWN_OPTIONS =
  /(stdio:\s*"inherit",)(\r?\n)([ \t]*)(shell:\s*process\.platform === "win32")/g;

/** Add `windowsHide: true` to `dsh plugin`'s pnpm spawn. */
function patchPluginSource(source) {
  if (source.includes(PATCH_MARKER)) return source;

  const occurrences = [...source.matchAll(PNPM_SPAWN_OPTIONS)].length;
  if (occurrences !== 1) {
    throw new Error(
      `${DSH_PACKAGE}: expected exactly one pnpm spawnSync options object, found ${occurrences}; review the plugin console-window patch`
    );
  }

  return source.replace(
    PNPM_SPAWN_OPTIONS,
    (_match, stdio, newline, indent, shell) =>
      `${stdio}${newline}${indent}${shell},${newline}${indent}windowsHide: true, ${PATCH_MARKER}`
  );
}

/**
 * The single `lib/plugin-*.js` chunk of an installed dsh, or `undefined` when the
 * layout is not the one this patch was written against.
 */
function findPluginSourcePath(packageDir) {
  const libDir = path.join(packageDir, "lib");
  const matches = fs
    .readdirSync(libDir)
    .filter((name) => /^plugin-.*\.js$/.test(name))
    .map((name) => path.join(libDir, name));

  return matches.length === 1 ? matches[0] : undefined;
}

/** Patch the plugin forwarder of one installed dsh tree, verifying its version first. */
function patchDshPluginConsoleWindow({ modulesDir = DEFAULT_MODULES_DIR } = {}) {
  const packageDir = path.join(modulesDir, DSH_PACKAGE);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(packageDir, "package.json"), "utf8")
  );
  if (manifest.version !== SUPPORTED_VERSION) {
    throw new Error(
      `${DSH_PACKAGE}: expected ${SUPPORTED_VERSION}, found ${String(manifest.version)}`
    );
  }

  const sourcePath = findPluginSourcePath(packageDir);
  if (sourcePath === undefined) {
    throw new Error(
      `${DSH_PACKAGE}: expected exactly one lib/plugin-*.js chunk, found none or several; review the plugin console-window patch`
    );
  }

  const source = fs.readFileSync(sourcePath, "utf8");
  const patched = patchPluginSource(source);
  if (patched === source) {
    console.log(
      `${DSH_PACKAGE}: ${path.basename(sourcePath)} patch already applied`
    );
    return [];
  }

  fs.writeFileSync(sourcePath, patched, "utf8");
  const label = path.join("lib", path.basename(sourcePath));
  console.log(`${DSH_PACKAGE}: applied ${label} patch`);
  return [label];
}

function usage() {
  return [
    "Usage: node scripts/patch-dsh-plugin-console-window.cjs [--modules <dir>]",
    "",
    "让 dsh 安装插件时不再弹出黑色控制台窗口：给 `dsh plugin` 转发 pnpm 的那次",
    "spawnSync 加上 windowsHide。Electron 主进程是 GUI 子系统、没有控制台，",
    "`shell: true` 起的 cmd.exe 会因此给自己新建一个可见控制台。",
    "",
    "Options:",
    "  --modules <dir>  dsh 依赖所在的 node_modules 目录。默认：仓库自己的",
    "                   node_modules。已安装的 Harness Desktop 依赖放在",
    "                   resources/app.asar.unpacked/node_modules，传这个路径即可",
    "                   免重新打包修好已安装的客户端。",
    "  --help           显示本帮助。"
  ].join("\n");
}

function parseArgs(argv) {
  const options = { modulesDir: DEFAULT_MODULES_DIR, help: false };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--modules") {
      index += 1;
      if (!argv[index]) {
        throw new Error("--modules 需要一个目录参数。");
      }
      options.modulesDir = path.resolve(argv[index]);
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }

  return options;
}

function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(usage());
    return;
  }

  patchDshPluginConsoleWindow({ modulesDir: options.modulesDir });
}

if (require.main === module) main(process.argv.slice(2));

module.exports = {
  DEFAULT_MODULES_DIR,
  DSH_PACKAGE,
  PATCH_MARKER,
  SUPPORTED_VERSION,
  findPluginSourcePath,
  patchDshPluginConsoleWindow,
  patchPluginSource
};

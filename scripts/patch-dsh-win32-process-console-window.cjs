const fs = require("node:fs");
const path = require("node:path");

const SUPPORTED_VERSION = "0.1.6-alpha.1";
const WIN32_PROCESS_PACKAGE = "@deepseek-ai/dsh-win32-process";

/** Default dsh dependency tree: this repository's own `node_modules`. */
const DEFAULT_MODULES_DIR = path.join(__dirname, "..", "node_modules");

/**
 * agent 每执行一条命令都会弹出一个黑色控制台窗口。
 *
 * 本应用把 dsh 跑在 Electron 里，Electron 主进程与它启动的 Job runner
 * （`dsh-subprocess-local/lib/runner.js`，同样是 Electron 的 GUI 子系统进程）**都没有控制台**：
 * PE 子系统是 GUI，`windowsHide` 对它们无效（该标志只对控制台子系统程序生效）。
 *
 * runner 用 `CreateProcessW` 创建真正的目标进程（pwsh.exe），原来传的 creation flags 是
 * `1028`（CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT）。目标进程是控制台子系统程序，父进程
 * 又没有控制台，于是 Windows 给它**新建一个自己的可见控制台**：每条命令一个黑框，一直留到
 * 命令结束。实测该控制台为 pwsh 私有（`GetConsoleProcessList` 只有它自己），与 runner 无关，
 * 所以隐藏 runner（例如给那次 `spawn` 传 `windowsHide`）没有任何效果。
 *
 * 修法是给普通命令路径的 creation flags 加上 `CREATE_NO_WINDOW`（0x08000000）：目标进程不再
 * 拥有可见控制台，stdio 仍然走 runner 传下来的管道，命令本身不受影响。
 *
 * 只改 `spawnCurrentTokenJobProcess`。受限令牌沙箱路径（`spawnInheritedJobProcess` /
 * `spawnPipedProcess`，使用 CreateProcessAsUserW）**不能**加这个标志：dsh-sandbox-windows-acl
 * 的 README 记录了受限进程以 CREATE_NO_WINDOW / CREATE_NEW_CONSOLE 创建时会在 DLL 初始化阶段以
 * `STATUS_DLL_INIT_FAILED`（0xC0000142）死亡，所以那两个函数保持原样。
 *
 * 锚点是那次 `createProcessW` 调用的参数尾部；命中页面锁定 dsh 版本，并在替换前先校验原始代码。
 */
const CREATE_PROCESS_FLAGS = `null, null, 1, 1028, environment`;

const PATCHED_CREATE_PROCESS_FLAGS = `null, null, 1, 1028 | 0x08000000 /* CREATE_NO_WINDOW */, environment`;

/** Add CREATE_NO_WINDOW to the ordinary command path in `lib/index.js`. */
function patchCreateProcessSource(source) {
  if (source.includes(PATCHED_CREATE_PROCESS_FLAGS)) return source;
  const occurrences = source.split(CREATE_PROCESS_FLAGS).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `${WIN32_PROCESS_PACKAGE}: lib/index.js expected exactly one ordinary CreateProcessW call, found ${occurrences}; review the console-window patch`
    );
  }
  return source.replace(CREATE_PROCESS_FLAGS, PATCHED_CREATE_PROCESS_FLAGS);
}

const PATCH_SOURCES = [
  {
    parts: ["lib", "index.js"],
    label: "lib/index.js",
    patch: patchCreateProcessSource
  }
];

/** Patch one file of one installed package, verifying its version first. */
function patchPackageSource(modulesDir, patchSource) {
  const packageDir = path.join(modulesDir, WIN32_PROCESS_PACKAGE);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(packageDir, "package.json"), "utf8")
  );
  if (manifest.version !== SUPPORTED_VERSION) {
    throw new Error(
      `${WIN32_PROCESS_PACKAGE}: expected ${SUPPORTED_VERSION}, found ${String(manifest.version)}`
    );
  }

  const sourcePath = path.join(packageDir, ...patchSource.parts);
  const source = fs.readFileSync(sourcePath, "utf8");
  const patched = patchSource.patch(source);
  if (patched === source) {
    console.log(`${WIN32_PROCESS_PACKAGE}: ${patchSource.label} patch already applied`);
    return false;
  }

  fs.writeFileSync(sourcePath, patched, "utf8");
  console.log(`${WIN32_PROCESS_PACKAGE}: applied ${patchSource.label} patch`);
  return true;
}

/**
 * Apply the console-window patch to one dsh dependency tree.
 * @param modulesDir - directory holding `@deepseek-ai/...` package directories;
 *   defaults to this repository's `node_modules`. An installed Harness Desktop
 *   keeps its dependencies unpacked beside `app.asar`, so passing that
 *   `node_modules` fixes a shipped build without repackaging it.
 * @returns the patched file labels, empty when everything was already patched.
 */
function patchWin32ProcessConsoleWindow({ modulesDir = DEFAULT_MODULES_DIR } = {}) {
  const applied = [];
  for (const patchSource of PATCH_SOURCES) {
    if (patchPackageSource(modulesDir, patchSource)) {
      applied.push(patchSource.label);
    }
  }
  return applied;
}

function usage() {
  return [
    "Usage: node scripts/patch-dsh-win32-process-console-window.cjs [--modules <dir>]",
    "",
    "让 agent 执行命令时不再弹出黑色控制台窗口：给 dsh 创建普通命令进程时的",
    "creation flags 加上 CREATE_NO_WINDOW。Electron 主进程与 Job runner 都是 GUI",
    "子系统、没有控制台，目标 pwsh 会因此给自己新建一个可见控制台。",
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

  patchWin32ProcessConsoleWindow({ modulesDir: options.modulesDir });
}

if (require.main === module) main(process.argv.slice(2));

module.exports = {
  CREATE_PROCESS_FLAGS,
  DEFAULT_MODULES_DIR,
  PATCHED_CREATE_PROCESS_FLAGS,
  SUPPORTED_VERSION,
  WIN32_PROCESS_PACKAGE,
  patchCreateProcessSource,
  patchWin32ProcessConsoleWindow
};

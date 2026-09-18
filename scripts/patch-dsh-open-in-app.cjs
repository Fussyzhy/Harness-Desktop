const fs = require("node:fs");
const path = require("node:path");

const SUPPORTED_VERSION = "0.1.6-alpha.2";
const OPEN_IN_APP_PACKAGE = "@deepseek-ai/dsh-host-open-in-app";

/** Default dsh dependency tree: this repository's own `node_modules`. */
const DEFAULT_MODULES_DIR = path.join(__dirname, "..", "node_modules");

/**
 * `@deepseek-ai/dsh-host-open-in-app` launches a desktop application by
 * spawning it detached. Its child environment starts from the harness's
 * credential-scrubbed parent environment and then merges the adapter's own
 * entries, so whatever the dsh process was started with reaches the launched
 * application.
 *
 * This desktop client starts dsh through Electron's bundled Node runtime, which
 * requires `ELECTRON_RUN_AS_NODE=1` in the *parent* environment. Inheriting that
 * variable turns any Electron-based application in the catalog into a plain
 * Node process, which exits immediately instead of opening a window: the
 * Session-header "open locally" button then reports 打开失败 for VS Code, VS Code
 * Insiders, Cursor, Windsurf and friends, while Explorer, Git Bash and GitHub
 * Desktop (which asks for the variable deliberately) keep working.
 *
 * The launched application is the user's own desktop program, never a harness
 * child, so the marker is dropped from the inherited environment. The adapter's
 * explicit entries merge afterwards and still win, which is what keeps GitHub
 * Desktop's intentional `ELECTRON_RUN_AS_NODE` working.
 *
 * The entry dsh actually loads is `lib/index.js` (the bundled form); the same
 * expression lives in the readable `lib/types/resolver.js` it is bundled from.
 * Both spellings are patched, and both are pinned to the supported version.
 */
const BUNDLED_LAUNCH_ENV_BLOCK = `\t\tenv: {
\t\t\t...scrubbedParentEnv(),
\t\t\t...options.env
\t\t}`;

const PATCHED_BUNDLED_LAUNCH_ENV_BLOCK = `\t\tenv: {
\t\t\t...Object.fromEntries(
\t\t\t\tObject.entries(scrubbedParentEnv()).filter(([name]) => name.toUpperCase() !== "ELECTRON_RUN_AS_NODE")
\t\t\t),
\t\t\t...options.env
\t\t}`;

const SOURCE_LAUNCH_ENV_BLOCK = `        env: { ...scrubbedParentEnv(), ...options.env },`;

const PATCHED_SOURCE_LAUNCH_ENV_BLOCK = `        env: {
            ...Object.fromEntries(Object.entries(scrubbedParentEnv()).filter(([name]) => name.toUpperCase() !== 'ELECTRON_RUN_AS_NODE')),
            ...options.env,
        },`;

const PATCH_SOURCES = [
  {
    parts: ["lib", "index.js"],
    label: "lib/index.js",
    patch: patchEntrySource
  },
  {
    parts: ["lib", "types", "resolver.js"],
    label: "lib/types/resolver.js",
    patch: patchResolverSource
  }
];

/** Rewrite the bundled launch environment in `lib/index.js`. */
function patchEntrySource(source) {
  return patchLaunchEnvironment(source, BUNDLED_LAUNCH_ENV_BLOCK, PATCHED_BUNDLED_LAUNCH_ENV_BLOCK, "lib/index.js");
}

/** Rewrite the readable launch environment in `lib/types/resolver.js`. */
function patchResolverSource(source) {
  return patchLaunchEnvironment(source, SOURCE_LAUNCH_ENV_BLOCK, PATCHED_SOURCE_LAUNCH_ENV_BLOCK, "lib/types/resolver.js");
}

function patchLaunchEnvironment(source, from, to, label) {
  if (source.includes(to)) return source;
  if (!source.includes(from)) {
    throw new Error(
      `${OPEN_IN_APP_PACKAGE}: ${label} launch environment changed; review the open-in-app patch`
    );
  }
  return source.replace(from, to);
}

/** Patch one file of one installed package, verifying its version first. */
function patchPackageSource(modulesDir, patchSource) {
  const packageDir = path.join(modulesDir, OPEN_IN_APP_PACKAGE);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(packageDir, "package.json"), "utf8")
  );
  if (manifest.version !== SUPPORTED_VERSION) {
    throw new Error(
      `${OPEN_IN_APP_PACKAGE}: expected ${SUPPORTED_VERSION}, found ${String(manifest.version)}`
    );
  }

  const sourcePath = path.join(packageDir, ...patchSource.parts);
  const source = fs.readFileSync(sourcePath, "utf8");
  const patched = patchSource.patch(source);
  if (patched === source) {
    console.log(`${OPEN_IN_APP_PACKAGE}: ${patchSource.label} patch already applied`);
    return false;
  }

  fs.writeFileSync(sourcePath, patched, "utf8");
  console.log(`${OPEN_IN_APP_PACKAGE}: applied ${patchSource.label} patch`);
  return true;
}

/**
 * Apply the launch-environment patch to one dsh dependency tree.
 * @param modulesDir - directory holding `@deepseek-ai/...` package directories;
 *   defaults to this repository's `node_modules`. An installed Harness Desktop
 *   keeps its dependencies unpacked beside `app.asar`, so passing that
 *   `node_modules` fixes a shipped build without repackaging it.
 * @returns the patched file labels, empty when everything was already patched.
 */
function patchOpenInApp({ modulesDir = DEFAULT_MODULES_DIR } = {}) {
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
    "Usage: node scripts/patch-dsh-open-in-app.cjs [--modules <dir>]",
    "",
    "让 dsh 的“在本地打开”按钮能启动 VS Code 等 Electron 应用：从被启动的",
    "桌面程序继承的环境里去掉 ELECTRON_RUN_AS_NODE。",
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

  patchOpenInApp({ modulesDir: options.modulesDir });
}

if (require.main === module) main(process.argv.slice(2));

module.exports = {
  BUNDLED_LAUNCH_ENV_BLOCK,
  DEFAULT_MODULES_DIR,
  OPEN_IN_APP_PACKAGE,
  PATCHED_BUNDLED_LAUNCH_ENV_BLOCK,
  PATCHED_SOURCE_LAUNCH_ENV_BLOCK,
  SOURCE_LAUNCH_ENV_BLOCK,
  SUPPORTED_VERSION,
  patchEntrySource,
  patchOpenInApp,
  patchResolverSource
};

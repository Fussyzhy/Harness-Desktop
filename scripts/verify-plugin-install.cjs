/**
 * 端到端验证「从注册表安装一个插件」这条链路：应用交给 dsh 的那份环境，够不够官方安装器把插件装上，
 * 并让它随下一次启动生效。
 *
 * 它在一个临时 DSH_HOME 里用应用自己的代码准备 profile 与 pnpm 垫片，然后按官方安装器真正走的顺序执行：
 *
 *   1. 用准备好的环境运行 `dsh plugin --profile web add <spec>`——官方插件管理器的安装路径就是这条共享的
 *      pnpm 转发（`@deepseek-ai/dsh-plugin-manager/operations` 的 `runProfilePnpm`）
 *   2. 校验 profile 清单真的写进了依赖与 bundle 层
 *   3. 用这份 profile 起一次 `dsh web`，校验新插件作为层随服务正常启动
 *
 * 第 1 步是工作区根检查的守门测试：profile 是 pnpm 工作区根（`packages: - .`），而官方转发不传
 * `--workspace-root`，所以在 `ignore-workspace-root-check` 生效之前它必然以 ERR_PNPM_ADDING_TO_ROOT 失败。
 * **本地目录 / `link:` / `file:` 规格不受这条检查约束**，所以被安装的规格必须来自注册表，否则这条检查
 * 永远走不到——这正是这一环曾经失守的原因。
 *
 * 全程不碰用户的 `~/.dsh`，也不起 GUI 窗口：DSH_HOME 是临时目录，端口由系统分配。
 *
 * 用法：
 *   npm run build
 *   node scripts/verify-plugin-install.cjs [--spec <包名>] [--keep] [--timeout <秒>]
 *
 *   --spec <包名>     要安装的注册表包，默认 dsh-better-sidebar（用户实际要装的那个）
 *   --keep            保留临时目录，便于事后查看 profile 与 pnpm 日志
 *   --timeout <秒>    单次 dsh 启动的等待上限，默认 90
 */

const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = path.join(__dirname, "..");
const DSH_CLI = path.join(ROOT, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
const PROFILE = "web";
const DEFAULT_SPEC = "dsh-better-sidebar";

function electronPath() {
  try {
    // `require("electron")` outside Electron resolves to the executable path.
    return require("electron");
  } catch {
    const fallback = path.join(
      ROOT,
      "node_modules",
      "electron",
      "dist",
      process.platform === "win32" ? "electron.exe" : "electron"
    );
    if (!fs.existsSync(fallback)) {
      throw new Error(
        "找不到 Electron 可执行文件；先在仓库根目录执行 yarn install（它会补回 node_modules/electron/dist）。"
      );
    }
    return fallback;
  }
}

function log(message) {
  console.log(`[verify] ${message}`);
}

function fail(message) {
  throw new Error(message);
}

/** A port the operating system says is free right now. */
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function readProfileManifest(home) {
  return JSON.parse(
    fs.readFileSync(path.join(home, "profiles", PROFILE, "package.json"), "utf8")
  );
}

/** The dsh child environment: this process's own, plus the prepared block. */
function dshEnvironment(env, home) {
  return {
    ...process.env,
    ...env,
    DSH_HOME: home,
    ELECTRON_RUN_AS_NODE: "1",
    NO_COLOR: "1"
  };
}

/**
 * Install one plugin exactly the way the official manager does: dsh's own plugin
 * command, in the profile directory, with pnpm reached through the shim the
 * application prepared.
 *
 * The environment is the one `preparePluginManagerEnvironment` builds, so a
 * missing `PATH` entry or a missing pnpm setting fails here.
 */
function installPlugin(spec, { home, env, cwd }) {
  const result = spawnSync(
    electronPath(),
    ["--expose-internals", DSH_CLI, "plugin", "--profile", PROFILE, "add", spec],
    {
      cwd,
      env: dshEnvironment(env, home),
      encoding: "utf8",
      windowsHide: true
    }
  );

  if (result.error !== undefined) {
    fail(`无法启动 dsh plugin：${result.error.message}`);
  }
  if (result.status !== 0) {
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    fail(
      `dsh plugin add ${spec} 退出码 ${String(result.status)}。输出：\n${output || "（无输出）"}`
    );
  }

  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

function startDsh({ env, home, port }) {
  const child = spawn(
    electronPath(),
    [
      "--expose-internals",
      DSH_CLI,
      "web",
      "--no-open",
      "--host",
      "127.0.0.1",
      "--port",
      String(port)
    ],
    {
      cwd: ROOT,
      env: dshEnvironment(env, home),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    }
  );

  const state = { output: "", exited: undefined };
  const onData = (chunk) => {
    const text = chunk.toString();
    state.output += text;
    if (process.env.VERIFY_VERBOSE) {
      // The banner the shell parses, and whatever pnpm printed, only exist here.
      process.stdout.write(`[dsh:${port}] ${text}`);
    }
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.on("exit", (code) => {
    state.exited = code;
  });

  return { child, state };
}

/**
 * The authenticated URL is printed *after* the HTTP port answers, which is why
 * the shell waits for it too (`main.ts`).
 *
 * A plugin that cannot be composed or imported fails the whole boot, so an exit
 * before that banner is the regression this step exists to catch.
 */
async function waitForAuthenticatedUrl({ state }, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const match = /\bdsh web:\s+(https?:\/\/\S+)/.exec(state.output);
    if (match !== null) {
      return match[1];
    }
    if (state.exited !== undefined) {
      fail(
        `dsh web 在报告地址之前退出（code ${state.exited}）。输出：\n${state.output.trim() || "（无输出）"}`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  fail(`等待 dsh 报告服务地址超时（${timeoutMs / 1000}s）。输出：\n${state.output.trim()}`);
}

/**
 * The dependency the install added, read from the manifest diff rather than from
 * the spec: a spec may carry a version or a range, and the manager records
 * whatever pnpm resolved.
 */
function installedName(before, after) {
  const dependencies = after.dependencies ?? {};
  const added = Object.keys(dependencies).filter(
    (name) => before.dependencies?.[name] !== dependencies[name]
  );
  if (added.length !== 1) {
    fail(
      `期望恰好新增一个依赖，实际新增 ${added.length} 个：${JSON.stringify(dependencies)}`
    );
  }

  return added[0];
}

async function main(argv) {
  const keep = argv.includes("--keep");
  const specIndex = argv.indexOf("--spec");
  const spec = specIndex === -1 ? DEFAULT_SPEC : argv[specIndex + 1];
  const timeoutIndex = argv.indexOf("--timeout");
  const requestedTimeout =
    timeoutIndex === -1 ? Number.NaN : Number(argv[timeoutIndex + 1]) * 1000;
  const bootTimeoutMs =
    Number.isFinite(requestedTimeout) && requestedTimeout > 0 ? requestedTimeout : 90_000;

  const distEntry = path.join(ROOT, "dist", "dsh-plugins.js");
  if (!fs.existsSync(distEntry)) {
    fail("dist/ 尚未构建：先执行 npm run build。");
  }

  // Import the application's own modules, so this check exercises the wiring the
  // application actually ships rather than a copy of it.
  const plugins = await import(pathToFileURL(distEntry).href);
  const profileModule = await import(
    pathToFileURL(path.join(ROOT, "dist", "dsh-profile.js")).href
  );

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "harness-desktop-verify-"));
  const home = path.join(scratch, "dsh-home");
  const children = [];

  const stopAll = () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
      }
    }
  };

  try {
    log(`临时 DSH_HOME: ${home}`);
    log(`待安装: ${spec}`);
    fs.mkdirSync(home, { recursive: true });

    const prepared = plugins.preparePluginManagerEnvironment({
      userDataDir: path.join(scratch, "userData"),
      dshHome: home,
      electronPath: electronPath()
    });
    log(`pnpm 垫片: ${prepared.shimPath}`);

    // The profile a fresh machine gets. `dsh plugin` would initialize one too,
    // but then this application's own settings would never be written into it.
    const profile = profileModule.ensureWebProfilePlugins({ home });
    log(`profile: ${profile.status}，bundles: ${profile.bundles.join(", ")}`);
    if (profile.status === "skipped") {
      fail(`profile 未能准备：${profile.reason}`);
    }

    // --- 1. one install through the official path ---------------------------
    const before = readProfileManifest(home);
    log("安装中（pnpm 走应用准备的垫片）…");
    installPlugin(spec, { home, env: prepared.env, cwd: scratch });
    log("安装命令退出码 0");

    // --- 2. the profile really holds the dependency and the layer -----------
    const manifest = readProfileManifest(home);
    const name = installedName(before, manifest);
    const pinned = manifest.dependencies[name];
    if (!manifest.dsh?.profile?.bundles?.includes(name)) {
      fail(`profile 没有把 ${name} 加进 bundles：${JSON.stringify(manifest.dsh)}`);
    }
    log(`profile 依赖 ${name}@${pinned}，bundles 已包含它`);

    // --- 3. it boots with the new plugin in the layer stack -----------------
    const port = await freePort();
    const boot = startDsh({ env: prepared.env, home, port });
    children.push(boot.child);
    const url = await waitForAuthenticatedUrl(boot, bootTimeoutMs);
    log(`dsh web: ${url}`);
    const probe = await fetch(url, { redirect: "manual" }).catch((error) => error);
    if (probe instanceof Error) {
      fail(`HTTP 探测失败：${probe.message}`);
    }
    log(`HTTP 探测：${probe.status}（认证跳转属正常）`);

    console.log("");
    console.log(
      `全部通过：应用准备的 pnpm 环境 → 官方安装路径装上注册表插件 → profile 依赖与 bundle 层写入 → 服务带新层启动（${name}@${pinned}）。`
    );
  } finally {
    stopAll();
    if (keep) {
      log(`保留临时目录：${scratch}`);
    } else {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }
}

main(process.argv.slice(2)).catch((error) => {
  console.error("");
  console.error(`验证失败：${error.message}`);
  process.exitCode = 1;
});

// 冒烟验证：在一个临时 DSH_HOME 里按 `src/main.ts` 的方式准备好 `web` profile，然后用本应用
// 固定版本的 Electron 启动一次 `dsh web`，等到它打印出认证 URL 并探测一次 HTTP。
//
// 它存在的理由见 README「升级 dsh 时必须同时确认 Electron 版本」：dsh 从 0.1.6-alpha.2 起会在启动
// 时给 Node 的模块解析器装一层 profile 级回退，而它依赖的原生插件按运行时指纹放行 Electron 版本。
// 版本不匹配时 dsh 会在绑定端口之前就退出——只看 `yarn test` 是发现不了的（那些测试只比对版本号），
// 必须真的起一次服务。
//
// 与 `verify:plugins` 一样：不碰用户的 `~/.dsh`，也不起第二个 GUI 窗口。
//
// 用法：npm run smoke:boot
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const dshProfile = await import(
  pathToFileURL(path.join(repoRoot, "dist", "dsh-profile.js")).href
);
const dshPlugins = await import(
  pathToFileURL(path.join(repoRoot, "dist", "dsh-plugins.js")).href
);
const dshServer = await import(
  pathToFileURL(path.join(repoRoot, "dist", "dsh-server.js")).href
);

const root = mkdtempSync(path.join(os.tmpdir(), "harness-desktop-smoke-"));
const home = path.join(root, "dsh-home");
const cliPath = dshServer.resolveDshCliPath();
const electronPath = resolveElectronPath();

console.log(`[smoke] 临时 DSH_HOME: ${home}`);
console.log(`[smoke] Electron 运行时: ${electronPath}`);

const prepared = dshPlugins.preparePluginManagerEnvironment({
  userDataDir: path.join(root, "userData"),
  dshHome: home,
  electronPath
});
const ensured = dshProfile.ensureWebProfilePlugins({ home });
console.log(`[smoke] profile: ${ensured.status}，bundles: ${ensured.bundles.join(", ")}`);
if (ensured.reason !== undefined) {
  console.log(`[smoke] 跳过原因: ${ensured.reason}`);
}
if (ensured.status === "skipped") {
  console.error("[smoke] profile 未能建立，无法继续。");
  process.exit(1);
}

const port = await freePort();
const args = dshServer.buildDshArguments({ cliPath, host: "127.0.0.1", port });
const child = spawn(electronPath, args, {
  cwd: repoRoot,
  env: {
    ...process.env,
    DSH_HOME: home,
    ELECTRON_RUN_AS_NODE: "1",
    NO_COLOR: "1",
    ...prepared.env
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true
});

let output = "";
child.stdout.on("data", (chunk) => {
  output += chunk.toString();
});
child.stderr.on("data", (chunk) => {
  output += chunk.toString();
});

const url = await waitForUrl(child, () => dshServer.extractDshUrl(output));
let exitCode = 0;

if (url === undefined) {
  exitCode = 1;
  console.error(`[smoke] dsh 没有在 120 秒内打印出服务地址（退出码 ${child.exitCode ?? "未知"}）。`);
  console.error("[smoke] dsh 的输出：");
  console.error(output.trim() === "" ? "  （无输出）" : output.trim());
} else {
  console.log(`[smoke] dsh web: ${url}`);
  const probe = await fetch(url, { redirect: "manual" }).catch((error) => error);
  if (probe instanceof Error) {
    exitCode = 1;
    console.error(`[smoke] HTTP 探测失败：${probe.message}`);
  } else {
    console.log(`[smoke] HTTP 探测：${probe.status}（认证跳转属正常）`);
  }
}

child.kill();
await new Promise((resolve) => child.once("close", resolve));
rmSync(root, { recursive: true, force: true });

if (exitCode === 0) {
  console.log(`[smoke] 通过：${ensured.bundles.length} 个 bundle 的 web profile 完整启动。`);
} else {
  console.error(
    "[smoke] 失败。若错误是 Unsupported/no-context，说明当前 Electron 不在这个 dsh 版本的放行清单里。"
  );
}
process.exit(exitCode);

/** Electron 可执行文件；未下载时给出可执行的提示，而不是一个裸的 ENOENT。 */
function resolveElectronPath() {
  try {
    return require("electron");
  } catch (error) {
    throw new Error(
      `无法解析 electron 可执行文件（${String(error)}）。先运行 \`node node_modules/electron/install.js\` 下载运行时。`
    );
  }
}

/** 等到 dsh 打印服务地址，或子进程先退出。 */
async function waitForUrl(process, readUrl) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const url = readUrl();
    if (url !== undefined) return url;
    if (process.exitCode !== null) return undefined;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return undefined;
}

/** 让内核挑一个 127.0.0.1 上的空闲端口。 */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const chosen = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => resolve(chosen));
    });
  });
}

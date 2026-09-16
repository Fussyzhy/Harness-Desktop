/**
 * 端到端验证「用户自助安装插件」这条链路。
 *
 * 它在一个临时 DSH_HOME 里启动真实的 dsh web 服务，用应用自己的代码准备 profile
 * 与 pnpm 垫片，然后按卡片会走的顺序访问插件管理插件的路由：
 *
 *   1. GET  /harness-desktop/plugins                 内置插件与安装能力可见
 *   2. POST 安装一个合成的双半插件（本地目录，不走网络）
 *   3. 校验 profile 清单真的写进了依赖与 bundle 层
 *   4. POST 重启，校验宿主半以重启退出码退出（外壳据此重启服务）
 *   5. 用新的 profile 再启动一次，校验它带着新插件能正常起来
 *
 * 全程不碰用户的 ~/.dsh，也不碰正在运行的开发实例：DSH_HOME 是临时目录，端口由系统分配。
 *
 * 用法：
 *   npm run build
 *   node scripts/verify-plugin-manager.cjs [--keep] [--timeout <秒>]
 *
 *   --keep            保留临时目录，便于事后查看 profile 与日志
 *   --timeout <秒>    单次 dsh 启动的等待上限，默认 90
 */

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const ROOT = path.join(__dirname, "..");
const DSH_CLI = path.join(ROOT, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
const ROUTE = "/harness-desktop/plugins";
const PROBE_NAME = "@harness-desktop/e2e-probe";
const MANAGER_NAME = "@harness-desktop/dsh-plugin-manager";

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

function request(url, { method = "GET", body, headers } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = http.request(
      url,
      {
        method,
        headers: {
          ...(payload === undefined
            ? {}
            : { "content-type": "application/json", "content-length": payload.length }),
          ...headers
        }
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text: Buffer.concat(chunks).toString("utf8")
          })
        );
      }
    );
    req.on("error", reject);
    req.end(payload);
  });
}

/**
 * The authenticated URL hands out a session cookie and then redirects, so the
 * page only loads if that cookie is carried to the redirect target — and the
 * same cookie is what a browser would send for the page's script tags.
 */
async function openApplication(url) {
  const entry = await request(url);
  if (entry.status < 300 || entry.status >= 400) {
    return { page: entry, cookie: undefined };
  }

  const cookie = (entry.headers["set-cookie"] ?? [])
    .map((value) => value.split(";")[0])
    .join("; ");
  const target = new URL(entry.headers.location ?? "/", url).href;
  const page = await request(target, {
    headers: cookie.length > 0 ? { cookie } : undefined
  });
  log(`入口 HTTP ${entry.status} → ${page.status}（${target}）`);

  return { page, cookie: cookie.length > 0 ? cookie : undefined };
}

/** Poll the plugin route until it answers, or the service dies first. */
async function waitForRoute(origin, child, state, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if (state.exited !== undefined) {
      fail(`dsh 在路由可用之前退出（code ${state.exited}）。输出：\n${state.output}`);
    }
    if (Date.now() > deadline) {
      fail(
        `等待 ${ROUTE} 超时（${Math.round(timeoutMs / 1000)}s）。dsh 输出：\n${state.output}`
      );
    }

    try {
      const response = await request(`${origin}${ROUTE}`);
      if (response.status === 200) {
        return response;
      }
      if (response.status !== 404) {
        fail(`路由返回 ${response.status}：${response.text}`);
      }
    } catch {
      // Not listening yet.
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/**
 * The authenticated URL is printed *after* the route starts answering, which is
 * why the shell waits for it too (`main.ts`). Never read it just once.
 */
async function waitForAuthenticatedUrl(instance, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (instance.state.authenticatedUrl !== undefined) {
      return instance.state.authenticatedUrl;
    }
    if (instance.state.exited !== undefined) {
      fail(
        `dsh 在报告地址之前退出（code ${instance.state.exited}）：\n${instance.state.output}`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  fail(
    `等待 dsh 报告带 token 的地址超时（${timeoutMs / 1000}s）：\n${instance.state.output}`
  );
}

function startDsh({ env, port }) {
  const child = spawn(
    electronPath(),
    ["--expose-internals", DSH_CLI, "web", "--no-open", "--host", "127.0.0.1", "--port", String(port)],
    {
      cwd: ROOT,
      env: { ...process.env, ...env, ELECTRON_RUN_AS_NODE: "1", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    }
  );

  const state = { output: "", exited: undefined, authenticatedUrl: undefined };
  const onData = (chunk) => {
    const text = chunk.toString();
    state.output += text;
    if (process.env.VERIFY_VERBOSE) {
      // The banner the shell parses, and whatever pnpm prints, only exist here.
      process.stdout.write(`[dsh:${port}] ${text}`);
    }
    const match = /\bdsh web:\s+(https?:\/\/\S+)/.exec(state.output);
    if (match) {
      state.authenticatedUrl = match[1];
    }
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.on("exit", (code) => {
    state.exited = code;
  });

  return { child, state, origin: `http://127.0.0.1:${port}` };
}

/** A minimal dual-half plugin: host half, client half, and the bundle patch. */
function writeProbePlugin(directory) {
  fs.mkdirSync(path.join(directory, "dsh"), { recursive: true });
  fs.writeFileSync(
    path.join(directory, "package.json"),
    JSON.stringify(
      {
        name: PROBE_NAME,
        version: "0.0.0",
        private: true,
        type: "module",
        exports: {
          ".": "./dsh/index.js",
          "./client": "./dsh/client.js",
          "./package.json": "./package.json"
        },
        dsh: {
          bundle: { patch: "./cordis.patch.yml" },
          client: { platform: "web", inject: [], immediately: true }
        }
      },
      null,
      2
    )
  );
  fs.writeFileSync(
    path.join(directory, "cordis.patch.yml"),
    `- insert:\n    - id: e2e-probe\n      name: '${PROBE_NAME}'\n`
  );
  fs.writeFileSync(
    path.join(directory, "dsh", "index.js"),
    'export const name = "e2e-probe";\nexport function apply() {}\n'
  );
  fs.writeFileSync(
    path.join(directory, "dsh", "client.js"),
    `window.__ModuleLoader__.load({ id: '${PROBE_NAME}', factory: () => ({ apply() {}, inject: [] }) });\n`
  );
  return directory;
}

function readProfileManifest(home) {
  return JSON.parse(
    fs.readFileSync(path.join(home, "profiles", "web", "package.json"), "utf8")
  );
}

async function main(argv) {
  const keep = argv.includes("--keep");
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
  const userDataDir = path.join(scratch, "userData");
  const probe = writeProbePlugin(path.join(scratch, "probe-plugin"));
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
    fs.mkdirSync(home, { recursive: true });

    // The plugin manager reads DSH_HOME through dsh's own resolution, so the
    // temporary home has to be visible before the profile is prepared.
    process.env.DSH_HOME = home;
    const prepared = plugins.preparePluginManagerEnvironment({ userDataDir });
    log(`pnpm 垫片: ${prepared.shimPath}`);

    const profile = profileModule.ensureWebProfilePlugins({
      localAdditions: profileModule.BUNDLED_LOCAL_PROFILE_PLUGINS
    });
    log(`profile: ${profile.status}，bundles: ${profile.bundles.join(", ")}`);
    if (profile.status === "skipped") {
      fail(`profile 未能准备：${profile.reason}`);
    }

    // --- 1. the card's route answers, with the built-in plugin listed --------
    const first = startDsh({ env: prepared.env, port: await freePort() });
    children.push(first.child);
    const listResponse = await waitForRoute(
      first.origin,
      first.child,
      first.state,
      bootTimeoutMs
    );
    const list = JSON.parse(listResponse.text);
    log(`GET ${ROUTE} → ${listResponse.status}，${list.packages.length} 个插件`);

    if (list.available !== true) {
      fail("宿主半报告安装不可用：HARNESS_DESKTOP_* 环境变量没有传到位。");
    }
    const manager = list.packages.find(
      (entry) => entry.name === "@harness-desktop/dsh-plugin-manager"
    );
    if (!manager || manager.bundle !== true || manager.builtIn !== true) {
      fail(`内置插件管理插件没有按预期挂载：${JSON.stringify(manager)}`);
    }

    // --- 2. install a plugin through the card's own route -------------------
    log(`安装合成插件 ${PROBE_NAME} …`);
    const installResponse = await request(`${first.origin}${ROUTE}`, {
      method: "POST",
      body: { action: "add", spec: probe }
    });
    const installed = JSON.parse(installResponse.text);
    if (installed.ok !== true) {
      fail(`安装失败（HTTP ${installResponse.status}）：${installed.error}\n${installed.output}`);
    }
    if (installed.restartRequired !== true) {
      fail("安装成功却没有要求重启：bundle 层不会被重新组合。");
    }
    log("安装成功，宿主半要求重启服务");

    // --- 3. the profile really holds the dependency and the layer ----------
    const manifest = readProfileManifest(home);
    const pinned = manifest.dependencies?.[PROBE_NAME];
    if (typeof pinned !== "string") {
      fail(`profile 没有写入 ${PROBE_NAME} 依赖：${JSON.stringify(manifest.dependencies)}`);
    }
    if (!manifest.dsh?.profile?.bundles?.includes(PROBE_NAME)) {
      fail(`profile 没有把 ${PROBE_NAME} 加进 bundles：${JSON.stringify(manifest.dsh)}`);
    }
    log(`profile 依赖 ${PROBE_NAME}@${pinned}，bundles 已包含它`);

    // --- 4. the restart handshake ------------------------------------------
    log("请求重启服务，等待重启退出码 …");
    await request(`${first.origin}${ROUTE}`, {
      method: "POST",
      body: { action: "restart" }
    }).catch(() => {
      // 服务在响应回来之前就退出了，这正是预期。
    });

    const exitDeadline = Date.now() + 15_000;
    while (first.state.exited === undefined && Date.now() < exitDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (first.state.exited !== plugins.DSH_RESTART_EXIT_CODE) {
      fail(
        `服务退出码为 ${String(first.state.exited)}，期望 ${plugins.DSH_RESTART_EXIT_CODE}（外壳据此重启而不是报错）`
      );
    }
    log(`服务以退出码 ${first.state.exited} 退出，外壳会重启它`);

    // --- 5. it boots again with the new plugin in the layer stack ----------
    const second = startDsh({ env: prepared.env, port: await freePort() });
    children.push(second.child);
    const secondList = await waitForRoute(
      second.origin,
      second.child,
      second.state,
      bootTimeoutMs
    );
    const after = JSON.parse(secondList.text);
    const probeEntry = after.packages.find((entry) => entry.name === PROBE_NAME);
    if (!probeEntry || probeEntry.bundle !== true || probeEntry.mounted !== true) {
      fail(`重启后 ${PROBE_NAME} 没有作为 bundle 挂载：${JSON.stringify(probeEntry)}`);
    }
    log("重启后新插件作为 profile 层正常挂载，服务启动成功");

    // --- 6. the browser half is delivered to the page ----------------------
    // Everything above is the host half. The card only exists if dsh composes
    // this package's client row into the boot payload the page receives.
    const pageUrl = await waitForAuthenticatedUrl(second, 15_000);
    const { page, cookie } = await openApplication(pageUrl);
    if (page.status !== 200) {
      fail(`取页面失败（HTTP ${page.status}）：${pageUrl}`);
    }
    if (!page.text.includes(MANAGER_NAME)) {
      fail(
        `页面引导载荷里没有 ${MANAGER_NAME}：它的客户端行没有被组合进浏览器图谱。`
      );
    }
    log("页面引导载荷已包含插件管理插件的客户端行");

    const combo = /\/plugins\/\?\?[^"'\s]+/.exec(page.text);
    if (combo === undefined) {
      fail("页面里没有 /plugins 组合脚本 URL（浏览器半无法送达）。");
    }

    const bundle = await request(`${second.origin}${combo[0].replace(/&amp;/g, "&")}`, {
      headers: cookie === undefined ? undefined : { cookie }
    });
    if (bundle.status !== 200) {
      fail(`取客户端 bundle 失败（HTTP ${bundle.status}）：${combo[0]}`);
    }
    if (!bundle.text.includes(`id: '${MANAGER_NAME}'`)) {
      fail(`客户端 bundle 里没有注册 ${MANAGER_NAME}。`);
    }
    log(`浏览器半已送达（${bundle.text.length} 字节，注册名正确）`);

    console.log("");
    console.log("全部通过：内置 pnpm → dsh plugin → profile 重组 → 重启生效 → 浏览器半送达，链路完整。");
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

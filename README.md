<p align="center">
  <img src="./build/icon.png" width="132" height="132" alt="Harness Desktop Logo" />
</p>

<h1 align="center">Harness Desktop</h1>

<p align="center">
  将 DeepSeek Harness 装进桌面应用，开箱即用，无需单独安装 Node.js 或 dsh。
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.1.2-2563eb" alt="Version 0.1.2" />
  <img src="https://img.shields.io/badge/platform-Windows%20x64-0078d4?logo=windows11&logoColor=white" alt="Windows x64" />
  <img src="https://img.shields.io/badge/Electron-43-47848f?logo=electron&logoColor=white" alt="Electron 43" />
  <img src="https://img.shields.io/badge/TypeScript-6-3178c6?logo=typescript&logoColor=white" alt="TypeScript 6" />
  <img src="https://img.shields.io/badge/status-early%20preview-f59e0b" alt="Early preview" />
</p>

<p align="center">
  基于 <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a> 构建
</p>

---

Harness Desktop 是一个基于 TypeScript 和 Electron 的 DeepSeek Harness 桌面客户端。
应用启动时会运行安装包内固定版本 `0.1.6-alpha.1` 的 `@deepseek-ai/dsh web`，等待本地服务就绪，
再将完整 Web UI 加载到桌面窗口中。

> 当前项目处于早期预览阶段，重点是提供稳定、可运行、可分发的 Windows 桌面体验。

## 当前能力

- **开箱即用**：安装包自带 Electron Node.js 运行时、dsh 和全部生产依赖
- **服务托管**：随桌面应用自动启动和关闭本地 dsh 服务
- **端口隔离**：自动选择 `127.0.0.1` 上的空闲端口，避免实例冲突
- **桌面体验**：自定义标题栏为系统窗口按钮预留独立条带、窗口拖拽、任务栏名称和统一应用图标
- **托盘驻留**：关闭窗口后保持后台运行，可从托盘重新打开或完全退出
- **安全导航**：应用外链接交给系统默认浏览器打开
- **错误诊断**：启动失败或服务意外退出时直接展示相关日志
- **插件预置**：内置 modlens 视觉插件，首次启动自动挂载，无需用户安装
- **插件自助安装**：Web UI 设置页内置插件管理卡片，可直接安装、更新、卸载 npm 上的 dsh 插件
- **Windows 安装器**：通过 NSIS 生成可选择安装目录的 x64 安装包

## 安装使用

最终用户只需要安装 `Harness-Desktop-Setup-<version>.exe`，无需另外安装 Node.js、
DeepSeek Harness 或 `@deepseek-ai/dsh`。首次进入应用后，在 Web UI 中配置模型并选择工作区即可。

## 开发运行

开发环境需要 Node.js 22 或更高版本，以及 Yarn Classic 或 npm。

使用 Yarn Classic：

```powershell
yarn install
yarn dev
```

使用 npm：

```powershell
npm install
npm start
```

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `yarn dev` | 编译 TypeScript 并启动开发版 |
| `yarn run check` | 检查主进程与测试代码的 TypeScript 类型 |
| `yarn test` | 运行 dsh 服务启动相关测试 |
| `yarn package:dir` | 生成用于快速验证的未安装应用目录 |
| `yarn package:win` | 生成 Windows x64 NSIS 安装包 |
| `yarn patch:app` | 把当前 `dist/` 写进已安装客户端的 `app.asar`，免去重新打包安装 |
| `yarn verify:plugins` | 在临时 `DSH_HOME` 里端到端验证插件安装链路（不起第二个 GUI，不动你的 `~/.dsh`）；加 `VERIFY_VERBOSE=1` 可透传 dsh 与 pnpm 的原始输出 |

## 构建安装包

应用图标位于 `build/icon.png`。安装依赖后运行：

```powershell
yarn package:win
# 或
npm run package:win
```

产物会输出到 `release/`：

```text
release/
├── Harness-Desktop-Setup-<version>.exe
└── win-unpacked/
```

如果 electron-builder 下载 GitHub 资源时发生 `ETIMEDOUT`，可以在当前 PowerShell
会话中切换镜像后重新构建。实测 `--dir` 只卡在 `ELECTRON_BUILDER_BINARIES_MIRROR`
（winCodeSign 一类工具链），Electron 本体一般命中本地缓存：

```powershell
$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
yarn package:win
```

> 当前安装包尚未配置代码签名，Windows SmartScreen 可能显示“未知发布者”。

## 只更新已安装的客户端

改了 `src/` 之后不需要重新打包安装：`app.asar` 里只有 `dist/`、`src/loading.html`、
`build/icon.png` 这几个小文件，生产依赖全部在旁边的 `app.asar.unpacked` 中。因此可以只重写这
个约 5 MB 的归档：

```powershell
npm run build        # 编译 TypeScript
yarn patch:app       # 或 npm run patch:app
```

脚本会在替换前把新归档完整解回来比对每个条目，写入时先备份再改名，失败会自动还原。
**必须先完全退出 Harness Desktop（含托盘图标）**：应用运行时 `app.asar` 被占用，脚本会直接
报错并且不做任何修改。

`package.json` 不在同步范围内——electron-builder 打包前会裁剪它（去掉 `scripts`、
`devDependencies`），仓库里的副本不能直接顶替。所以版本号变更仍然要重新走 `yarn package:win`。

## 依赖补丁

dsh 跑在 Electron 的 Node 运行时里（`ELECTRON_RUN_AS_NODE=1`），这条事实会顺着子进程环境一路
传下去，并让少数场景失效。`scripts/patch-dsh-*.cjs` 在 `postinstall` / `prebuild` 时逐条修正
dsh 依赖里对应的位置，每个补丁都锁定 dsh 版本，且在当前版本上先校验原始代码再替换：

| 补丁 | 修正的问题 |
| --- | --- |
| `patch-dsh-directory-picker.cjs` | 目录选择器在 Windows 上读取路径时崩溃 |
| `patch-dsh-settings-open.cjs` | 打开设置文档时异常被吞掉、按钮卡住 |
| `patch-dsh-open-in-app.cjs` | “在本地打开”无法启动 VS Code 等 Electron 应用 |
| `patch-dsh-win32-process-console-window.cjs` | agent 每执行一条命令都会弹出黑色控制台窗口 |
| `patch-dsh-plugin-console-window.cjs` | 安装插件时反弹出黑色控制台窗口 |

最后一个补丁修的是：被启动的桌面程序从 dsh 继承了 `ELECTRON_RUN_AS_NODE=1`，于是 VS Code、
VS Code Insiders、Cursor、Windsurf 这些 Electron 程序被当成 Node 进程启动，几十毫秒内就带着
`node:internal/modules/cjs/loader` 错误退出，界面显示“打开失败”。补丁只从**被启动的桌面程序**
继承的环境里去掉这个变量（资源管理器、Git Bash 不受影响，GitHub Desktop 自己声明的仍保留）。

控制台窗口补丁修的是：本应用把 dsh 跑在 Electron 里，Electron 主进程和它启动的 Job runner 都是
GUI 子系统进程、**都没有控制台**（`windowsHide` 只对控制台子系统程序生效，对它们无效）。runner
用 `CreateProcessW` 创建真正的命令进程，而目标 pwsh 是控制台子系统程序、父进程又没有控制台，
Windows 于是给它**新建一个自己的可见控制台**——每条命令一个黑框，一直留到命令结束。补丁给这次
创建的 creation flags 加上 `CREATE_NO_WINDOW`（0x08000000），目标进程不再有可见控制台，stdio
仍走 runner 传下来的管道，命令行为不变。只改普通命令路径 `spawnCurrentTokenJobProcess`：受限
令牌沙箱的 `CreateProcessAsUserW` 路径**不能**加这个标志（受限进程会在 DLL 初始化阶段以
`STATUS_DLL_INIT_FAILED` 0xC0000142 死亡，见 dsh-sandbox-windows-acl 的说明），保持原样。

插件补丁修的是同一类问题的另一条路径：`dsh plugin` 是 pnpm 转发器，它用
`spawnSync("pnpm", …, { shell: process.platform === "win32" })` 起命令。父进程没有控制台，
`shell: true` 起的 `cmd.exe` 因此又给自己新建一个可见控制台。补丁只给这一次 `spawnSync` 加上
`windowsHide: true`（→ `CREATE_NO_WINDOW`），`stdio: "inherit"` 与退出码不变。该文件是
`lib/plugin-<hash>.js`，名字随版本变化，所以补丁按目录扫描定位，并要求恰好命中一个。

已安装的客户端也可以就地修好，不必重新打包——它的依赖就在 `app.asar.unpacked` 里：

```powershell
node scripts/patch-dsh-open-in-app.cjs --modules "$env:LOCALAPPDATA\Programs\Harness Desktop\resources\app.asar.unpacked\node_modules"
```

每个补丁脚本都接受同样的 `--modules` 参数，可以单独就地执行，例如修掉命令窗口的问题：

```powershell
node scripts/patch-dsh-win32-process-console-window.cjs --modules "$env:LOCALAPPDATA\Programs\Harness Desktop\resources\app.asar.unpacked\node_modules"
```

> 补丁改的是 node_modules，`yarn patch:app` 不覆盖它；重新打包安装后无需再执行。
> 运行中的应用要重启（托盘图标 → 关闭，再打开）才会加载改过的插件代码。

## 工作原理

```text
Harness Desktop
├── Electron 窗口 ──────────────── 加载本地 Web UI
└── Electron 内置 Node.js
    └── @deepseek-ai/dsh web ───── 监听 127.0.0.1:<动态端口>
```

- Electron 主进程和服务管理代码均使用 TypeScript。
- 开发命令会先将 `src/*.ts` 编译到 `dist/`，再启动 Electron。
- 窗口使用 `titleBarStyle: "hidden"` 加 `titleBarOverlay`：Windows 会把最小化/最大化/关闭
  按钮直接画在页面上，所以主进程在每次加载完成后注入样式，用 `env(titlebar-area-*)` 预留出
  与该条带等高的顶部空间，并让这条带可拖拽。`box-sizing: border-box` 把内边距折进页面原有的
  `height: 100%`，使 Web UI 的实际可用高度正好等于窗口高度减去条带，不会溢出或出现滚动条。
- dsh 通过 Electron 内置 Node.js 运行，并使用 `--expose-internals` 满足 HMR 服务要求。
- 生产依赖会放入 `app.asar.unpacked`，保证动态插件和原生模块可被子进程加载。
- 项目在顶层固定 dsh Web profile 所需的 peer dependencies，以兼容 Yarn Classic。
- 启动前会把内置插件写入本地 dsh profile，详见[内置插件](#内置插件)。

## 内置插件

应用内置的插件在每次启动服务之前被写入本地 `web` profile，因此终端用户无需安装任何东西。

打包后的应用没有全局 `dsh`，也没有 PATH 上的 `pnpm`：dsh 跑在 Electron 的 Node 运行时里，安装包内
不带 npm/corepack。用户自助安装因此由[用户自己安装的插件](#用户自己安装的插件)那套内置 pnpm 垫片
完成；本节说的是随应用发布、用户无需安装的预置插件。

### 两步缺一不可

预置一个插件要同时做两件事，少任何一件都装不上：

1. **列进 `dsh.profile.bundles`**——dsh 据此组合插件自带的 patch 层。这一步读的是应用安装目录，
   所以插件放在本应用的依赖里就能被解析到。
2. **复制到 `<profile>/node_modules/`**——组合出来的插件条目最终由 Loader 从 profile 目录 import。
   dsh 的两套模块回退都指望不上第三方插件：`$DSH_HOME/profiles/node_modules` 只镜像 dsh
   自己的依赖闭包，而 profile 内的链接投影会刻意跳过每个 bundle 自身。

第 2 步复刻了 `dsh plugin add` 最终留下的布局（profile 的 `pnpm-workspace.yaml` 要求的正是
`nodeLinker: hoisted` 扁平结构），也是不依赖 pnpm 就能生效的原因。复制只在版本不一致时发生，
因此后续启动只多一次 manifest 读取。若同名的包已存在且版本一致（例如用户自己装过同一个版本），
则原样保留；版本不同时会被本应用内置的版本覆盖。

### 新增一个内置插件

1. 把包加进 `package.json` 的 `dependencies`，**精确锁定版本**（不要用 `^`）。
2. 把包名加进 `src/dsh-profile.ts` 的 `BUNDLED_PROFILE_PLUGINS`。
3. 运行 `yarn test`：测试会校验每个内置插件都已被声明为精确锁定的依赖。

**改了插件内容就要同时升它的 `version`**（例如 `plugins/dsh-plugin-manager/package.json`）：profile
里的副本是按版本号判断是否需要刷新的（`src/dsh-profile.ts` 的 `ensureWebProfilePlugins`），版本没变
就原地保留旧副本，改动静默地到不了用户机器——只在源码里改一行、忘了升版本，重启也不会有任何变化。

### 生效条件

一个包只有同时满足以下几点才会被写进 profile，否则会被跳过并打印警告：

- 能从本应用安装目录或 profile 目录解析到（与 dsh 自身的解析顺序一致）；
- 其 `package.json` 声明了 `dsh.bundle.patch`。

这两条都是硬性的：把 dsh 解析不到、或没声明 bundle 的包列进 `dsh.profile.bundles`，会让 dsh
整个启动失败。反过来，某个内置插件在后续版本里不再可解析时，它会被自动移出 profile，
避免留下一个必然导致启动失败的条目。用户自己安装的插件条目不会被新增、重排或删除。

整个预置过程失败都不会影响应用启动：profile 只是增强项，dsh 仍会在磁盘上已有的内容上启动。

### modlens 需要配置一个视觉引擎

内置的 `@liustack/modlens` 为纯文本模型补上读图能力。插件本身装好即用，但要选一个视觉后端：

- `gemini-api` / `openai` / `anthropic`：填 API key，并支持 `baseUrl` 覆盖；
- `antigravity-cli` / `claude-cli` / `kimi-cli`：需要本机装有对应 CLI 且已登录。

它自带的设置卡片会出现在 Web UI 里，也可以在建服务前用环境变量预置——dsh 子进程继承应用的环境变量：

| 引擎 | key | 端点覆盖 |
| --- | --- | --- |
| `gemini-api` | `GEMINI_API_KEY` | `GEMINI_BASE_URL` |
| `openai` | `OPENAI_API_KEY` | `OPENAI_BASE_URL` |
| `anthropic` | `ANTHROPIC_API_KEY` | `ANTHROPIC_BASE_URL` |

查看当前哪些引擎可用：

```powershell
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { "$env:USERPROFILE\.dsh" }
node "$dshHome\profiles\web\node_modules\@liustack\modlens\dist\main.js" doctor --json
```

### 用户自己安装的插件

Web UI 设置页的 Plugins 里有一张**插件管理**卡片，可以安装、更新、卸载 dsh 插件。

打包后的应用既没有 npm 也没有 corepack，PATH 上更没有 `pnpm`，而 `dsh plugin` 只是一个 pnpm
转发器，所以本应用把 **pnpm 10.4.0**（纯 JS，精确锁版本）放进自己的依赖，在用户数据目录写一个
`pnpm` 垫片（Windows 下是 `pnpm.cmd`），启动 dsh 子进程时把该目录放在 `PATH` 最前面，并通过环境
变量把 pnpm、dsh CLI 与 store 路径交给内置的 `@harness-desktop/dsh-plugin-manager` 插件。安装因此
走的是官方命令：

```text
dsh plugin --profile web add --workspace-root <包名> --store-dir <DSH_HOME>/.pnpm-store
```

`--workspace-root` 不是可选项：profile 的 `pnpm-workspace.yaml` 由 dsh 模板生成，里面是
`packages: - .`，pnpm 因此把 profile 当作工作区根，而**往工作区根添加注册表依赖必须显式声明**，
否则报 `ERR_PNPM_ADDING_TO_ROOT`。`dsh plugin` 把参数原样转发给 pnpm，所以这个 flag 只能由调用方
给出（卡片与 `src/dsh-plugins.ts` 的 `buildDshPluginArguments` 都已带上）。本地目录与 `link:` 规格
不受这条检查约束，这也是只装本地探针插件的端到端脚本抓不到该问题的原因。

profile 的初始化、pnpm 转发、以及按**已安装状态**回填 `dsh.profile.bundles` 都由 dsh 自己完成，
所以别名、tarball、本地目录、git 地址、传递依赖与版本冲突的行为和命令行完全一致。

输入框接受 npm 上常见的写法：

| 写法 | 例子 |
| --- | --- |
| 包名（含 scope） | `@liustack/modlens` |
| 指定版本 | `@liustack/modlens@3.26.0` |
| 本地目录或 tarball | `file:C:/plugins/my-plugin`、`file:C:/plugins/my-plugin-1.0.0.tgz` |
| git | `github:user/repo` |
| 本地副本 | `@deepseek-ai/dsh-tools@link:C:/app/node_modules/@deepseek-ai/dsh-tools` |

一次可以给**多个规格**（空格或逗号分隔），它们会作为多个参数交给同一次 `pnpm` 调用——下面那条
peer 依赖的坑就靠这个绕过。每个规格单独校验：不能以 `-` 开头（否则就是在注入 flag）、不能含空格、
不超过 200 字符，所以路径里带空格的规格目前输入不了。

几条要记住的规则：

- **装完要重启服务才生效**：`dsh.profile.bundles` 只在启动时读一次，`patchReload: live` 只监听
  patch 文件。安装成功后卡片会给出"立即重启"，由桌面外壳重启 dsh 子进程并用新的认证 URL 重载窗口
  （该 URL 每次启动都带新 token）。
- **内置插件不会被用户操作删掉**：应用管理的插件（modlens 和插件管理本身）不以依赖形式存在，
  `dsh plugin remove` 不会碰它们，卡片会把它们标成"内置"。反过来，自己安装同名包（例如另一个
  版本的 modlens）不会生效：bundle 的 patch 层永远从应用安装目录解析，两版并存会混用一版的
  patch 和另一版的代码，所以应用启动时会把 profile 里的副本恢复成随应用发布的版本并打印日志。
- **依赖的构建脚本默认被 pnpm 阻止**：**以卡片打印的报错为准**。本应用内置的是 pnpm 10.4.0，它的
  提示是 `Ignored build scripts: <包名>. Run "pnpm approve-builds" …`，放行键是
  `pnpm-workspace.yaml` 里的 `onlyBuiltDependencies`（dsh 自己的提示文案写的是 `allowBuilds`，那是
  更新版 pnpm 的键名，这个版本不认）。把提示里点名的包写进去再重试即可。
- **peer 依赖指向未发布的包时，注册表安装会失败**：插件只要声明 peer `@deepseek-ai/dsh-tools`（写 `*`
  的最常见）就会撞上这个坑——`dsh-tools` 的 `latest` dist-tag 至今指向最老的 `0.0.1-rc.1`，而那一支的
  peer 里含有**从未发布**的 `@deepseek-ai/dsh-type-meta`（`dsh-session@0.0.1-rc.1`、
  `dsh-agent@0.0.1-rc.1` 都声明了它），于是 pnpm 报 `ERR_PNPM_FETCH_404 … dsh-type-meta` 并放弃整次
  安装。这与 profile 和本应用无关：空目录里 `pnpm add @deepseek-ai/dsh-tools@0.0.1-rc.1` 同样复现；
  而 `dsh-tools@0.1.6-alpha.1`（应用自带的那版）的 peer 是已发布的 `^0.1.6-alpha.1` 家族，一路干净。

  修法是把这个 peer 指名道姓地一起写进输入框（两个规格，空格或逗号分隔），二选一：

  ```text
  @hellosz/dsh-pets  @deepseek-ai/dsh-tools@0.1.6-alpha.1
  @hellosz/dsh-pets  @deepseek-ai/dsh-tools@link:<应用目录>/node_modules/@deepseek-ai/dsh-tools
  ```

  第一行更省事（版本号取本应用 `package.json` 里 `@deepseek-ai/dsh-tools` 的值，目前是
  `0.1.6-alpha.1`）；第二行保证永远与应用内置的那份同版本、且不额外下载，代价是 profile 里记下一个
  本机绝对路径（应用换了安装目录就要重新装一次）。命令行等价写法是
  `dsh plugin --profile web add --workspace-root <上面两个规格> --store-dir <DSH_HOME>/.pnpm-store`。
  `@deepseek-ai/dsh-tools` 不声明 `dsh.bundle`，只会作为普通依赖落进 profile 的 `dependencies`
  （dsh 会打印一条相应提示），不影响插件层。
- **镜像源**：pnpm 读它自己的配置，在 `<profile>/.npmrc` 或 `~/.npmrc` 里写 `registry=`
  即可（例如 `https://registry.npmmirror.com`）。注意 `yarn dev` 起的环境里，yarn 会把自己的
  `npm_config_registry` 传给子进程（本机实测是 `http://registry.npmmirror.com`，磁盘上并没有任何
  `.npmrc`），而打包后的应用没有这层环境变量，默认走官方 npmjs——两条路的安装行为都验证过。
- **插件就是任意代码**：安装一个插件等于让它在 dsh 进程里运行，只安装你信任的包。

profile 位于 `$DSH_HOME`（默认 `~/.dsh`）下的 `profiles/web/`，不在安装目录里，
因此应用升级或重装都不会丢失用户自己装的插件。

## 项目结构

| 路径 | 说明 |
| --- | --- |
| `src/main.ts` | Electron 主进程与窗口生命周期 |
| `src/dsh-server.ts` | dsh 进程启动、端口选择与就绪检测 |
| `src/dsh-profile.ts` | 内置插件写入 dsh `web` profile |
| `src/dsh-plugins.ts` | 内置 pnpm 的解析、垫片生成与 `dsh plugin` 调用 |
| `src/loading.html` | 本地服务启动和错误状态页 |
| `plugins/dsh-plugin-manager/` | 插件管理插件本体（宿主半 + 浏览器半，随应用打包进 profile） |
| `scripts/` | 依赖补丁和把构建写进已安装客户端的工具 |
| `test/` | dsh 服务、profile 注入和构建补丁测试 |
| `build/icon.png` | 应用、Loading、安装器和快捷方式图标 |
| `electron-builder.yml` | Windows 安装包配置 |
| `dist/` | TypeScript 编译输出，不提交版本控制 |
| `release/` | 打包输出，不提交版本控制 |

## 插件管理插件的契约

`plugins/dsh-plugin-manager/` 是随应用打包的 dsh 双半插件，dsh 对它有硬性要求，改动前请先看
`test/dsh-plugin-manager.test.ts`（这些测试就是按下面的规则写的）：

- `package.json` 必须同时给出 `dsh.bundle.patch`、`exports["."]` 和 `exports["./client"]`，
  且三个文件都要真的存在——声明了 `dsh.client` 却没有客户端半会让 **dsh 整个启动失败**；
- 浏览器半是**经典脚本**，必须是 `window.__ModuleLoader__.load({ id, factory })` 的单文件形态，
  注册的 `id` 必须等于包名，裸包名只能 require 外壳提供的模块表（本插件只用 `react`）；
- 卡片的 `key` 必须等于宿主半通过 `settings.register` 注册的命名空间，否则卡片永不被派发；
- 宿主半只读 `HARNESS_DESKTOP_*` 环境变量（见 `src/dsh-plugins.ts` 的
  `PLUGIN_MANAGER_ENV_KEYS`），在应用之外启动时会明确报"无法安装"而不是静默失败。
- 写操作是 `POST { action: "add" | "remove" | "update" | "restart", spec }`。`spec` 里可以有多个
  规格（空格或逗号分隔，`update` 允许为空表示全部更新），**每个规格单独**校验：不以 `-` 开头、
  不含空格、不超过 200 字符——这样才能既支持"插件 + peer link"一起装，又不让 flag 混进 pnpm 参数。

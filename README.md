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
  <img src="https://img.shields.io/badge/Electron-44-47848f?logo=electron&logoColor=white" alt="Electron 44" />
  <img src="https://img.shields.io/badge/TypeScript-6-3178c6?logo=typescript&logoColor=white" alt="TypeScript 6" />
  <img src="https://img.shields.io/badge/status-early%20preview-f59e0b" alt="Early preview" />
</p>

<p align="center">
  基于 <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a> 构建
</p>

---

Harness Desktop 是一个基于 TypeScript 和 Electron 的 DeepSeek Harness 桌面客户端。
应用启动时会运行安装包内固定版本 `0.1.6-alpha.2` 的 `@deepseek-ai/dsh web`，等待本地服务就绪，
再将完整 Web UI 加载到桌面窗口中。

> 当前项目处于早期预览阶段，重点是提供稳定、可运行、可分发的 Windows 桌面体验。

> **升级 dsh 时必须同时确认 Electron 版本。** 从 `0.1.6-alpha.2` 起，dsh 启动时会给 Node 的
> ESM/CJS 解析器装一层 profile 级回退（`@deepseek-ai/dsh-app-boot` 的
> `installProfileResolution`），它通过原生插件 `node-addon-require-builtin` 读取
> `internal/modules/*`。该二进制按**运行时指纹**放行，只认它验证过的那几个 Electron 版本：
> `0.1.6-alpha.2` 的清单是 `43.0.0 / 44.0.0 / 45.0.0-alpha.6`。Electron `43.4.0`
> （Node 24.18.1 / V8 15.0.245.28）不在清单内，启动会在绑定端口之前就以
> `Unsupported/no-context` 失败——现象是应用完全打不开，所以本项目把 `electron` 锁在清单内的
> `44.0.0`。**换 dsh 版本时先看新版的放行清单，再挑一个清单内的精确版本**。验证方法：跑
> `yarn smoke:boot`——它在临时 `DSH_HOME` 里按 `src/main.ts` 的方式建好 profile、用仓库锁定的
> Electron 起一次 `dsh web`，能打印出 `dsh web: http://…` 并探测到 HTTP 响应才算通过；不碰你的
> `~/.dsh`，也不起第二个 GUI 窗口。

## 当前能力

- **开箱即用**：安装包自带 Electron Node.js 运行时、dsh 和全部生产依赖
- **服务托管**：随桌面应用自动启动和关闭本地 dsh 服务
- **端口隔离**：自动选择 `127.0.0.1` 上的空闲端口，避免实例冲突
- **桌面体验**：自定义标题栏为系统窗口按钮预留独立条带、窗口拖拽、任务栏名称和统一应用图标
- **托盘驻留**：关闭窗口后保持后台运行，可从托盘重新打开或完全退出
- **桌宠悬浮**：安装 `dsh-live2d-pets` 后，宠物可脱离窗口悬浮在整个桌面上（托盘菜单可开关）
- **安全导航**：应用外链接交给系统默认浏览器打开
- **错误诊断**：启动失败或服务意外退出时直接展示相关日志
- **插件预置**：内置 modlens 视觉插件，首次启动自动挂载，无需用户安装
- **插件自助安装**：Web UI 侧边栏的官方 **Plugins** 页面可直接安装、更新、卸载 npm 上的 dsh 插件——应用替它准备好了 pnpm 与所需的 pnpm 设置
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
| `yarn verify:plugins` | 在临时 `DSH_HOME` 里端到端验证插件安装链路：用应用准备的 pnpm 环境走官方安装路径装一个注册表包，校验 profile 的依赖与 bundle 层，再用它起一次服务（不起 GUI，不动你的 `~/.dsh`）；加 `VERIFY_VERBOSE=1` 可透传 dsh 与 pnpm 的原始输出，`--spec <包名>` 可换目标包 |
| `yarn smoke:boot` | 在临时 `DSH_HOME` 里用仓库锁定的 Electron 真起一次 `dsh web`，验证 dsh 版本与 Electron 运行时确实能启动

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
`src/pet-overlay*`、`build/icon.png` 这几个小文件，生产依赖全部在旁边的 `app.asar.unpacked`
中。因此可以只重写这个约 5 MB 的归档：

```powershell
npm run build        # 编译 TypeScript
yarn patch:app       # 或 npm run patch:app
```

脚本会在替换前把新归档完整解回来比对每个条目，写入时先备份再改名，失败会自动还原。
**必须先完全退出 Harness Desktop（含托盘图标）**：应用运行时 `app.asar` 被占用，脚本会直接
报错并且不做任何修改。

已存在的条目就地替换，本版本**新增**的文件（例如桌宠悬浮的三个页面资源）会追加进归档的头部索引；
只有 `package.json` 仍然不参与同步——electron-builder 打包前会裁剪它（去掉 `scripts`、
`devDependencies`），仓库里的副本不能直接顶替。所以版本号变更仍然要重新走 `yarn package:win`。

## 桌宠悬浮在桌面

安装 `dsh-live2d-pets` 后，宠物默认渲染在 Web UI 窗口里，窗口最小化或切走就看不见了。开启
**托盘菜单 → 桌宠悬浮在桌面** 后，宠物会改由应用主进程托管的一个独立窗口渲染，从而悬浮在
整个桌面上：

- **不在任务栏、不抢焦点**：窗口是透明无边框的置顶窗口（`focusable: false`），鼠标在宠物身上
  之外时整窗点击穿透，桌面图标、其他窗口照常操作；只有宠物本体（画布矩形）接收点击。
- **点它和窗口里一样**：单击触发插件的摸头/摸身动作与台词，拖动换位置，
  **双击则把客户端窗口恢复并聚焦到前台**（窗口被关到托盘时也能唤回来）。
- **同一份状态**：悬浮宠物通过环回 HTTP 反向代理复用插件自己的 `/api/live2d-pet/*` 接口
  （状态快照 + SSE），因此人设、模型、尺寸、动作映射与设置页里配置的完全一致，插件本身不需要改动。
- **改设置立刻生效**：设置页里的尺寸、帧率、模型、人设改动会通过 SSE 推到悬浮宠物上，
  不需要重启客户端。
- **隐藏窗口里的那一只**：悬浮开启期间，主窗口会注入一条 CSS 把插件渲染在 `body` 上的那只宠物
  隐藏，避免同一只宠物出现两次；从托盘关闭悬浮后，窗口里的宠物会立刻恢复。
- **位置与大小**：拖动宠物可换位置，位置存在 `%APPDATA%\Harness Desktop\pet-overlay.json`，
  重启后恢复；如果保存的位置已经不在任何显示器范围内，会退回主屏右下角。
- **帧率**：插件设置里的 `maxFps` 照常生效，唯独 `0`（不限制）在悬浮模式下按 60 处理——这个窗口
  是常驻的，实测不限制会跑到 200 帧以上。

限制：目前只在单显示器、100% 缩放的桌面上验证过；多显示器 / 混合 DPI 尚未测试。

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

`patch-dsh-open-in-app.cjs` 修的是：被启动的桌面程序从 dsh 继承了 `ELECTRON_RUN_AS_NODE=1`，于是 VS Code、
VS Code Insiders、Cursor、Windsurf 这些 Electron 程序被当成 Node 进程启动，几十毫秒内就带着
`node:internal/modules/cjs/loader` 错误退出，界面显示“打开失败”。补丁只从**被启动的桌面程序**
继承的环境里去掉这个变量（资源管理器、Git Bash 不受影响，GitHub Desktop 自己声明的仍保留）。

`patch-dsh-win32-process-console-window.cjs` 修的是：本应用把 dsh 跑在 Electron 里，Electron 主进程和它
启动的 Job runner 都是 GUI 子系统进程、**都没有控制台**（`windowsHide` 只对控制台子系统程序生效，对它们无效）。runner
用 `CreateProcessW` 创建真正的命令进程，而目标 pwsh 是控制台子系统程序、父进程又没有控制台，
Windows 于是给它**新建一个自己的可见控制台**——每条命令一个黑框，一直留到命令结束。补丁给这次
创建的 creation flags 加上 `CREATE_NO_WINDOW`（0x08000000），目标进程不再有可见控制台，stdio
仍走 runner 传下来的管道，命令行为不变。只改普通命令路径 `spawnCurrentTokenJobProcess`：受限
令牌沙箱的 `CreateProcessAsUserW` 路径**不能**加这个标志（受限进程会在 DLL 初始化阶段以
`STATUS_DLL_INIT_FAILED` 0xC0000142 死亡，见 dsh-sandbox-windows-acl 的说明），保持原样。

### 已经退役的补丁：安装插件时的黑色控制台窗口

`0.1.6-alpha.1` 上的第五个补丁 `patch-dsh-plugin-console-window.cjs` 修的是：`dsh plugin` 当时自己就是
pnpm 转发器，它用 `spawnSync("pnpm", …, { shell: process.platform === "win32" })` 起命令，父进程没有
控制台，`shell: true` 起的 `cmd.exe` 因此又给自己新建一个可见控制台。

`0.1.6-alpha.2` 把包管理搬进了新的官方包 `@deepseek-ai/dsh-plugin-manager`：`dsh plugin` 只调
`runPluginCommand`，真正的 pnpm 由该包用 `execa` 启动。execa 的 `addDefaultOptions` 把 `windowsHide`
默认成 `true`，并且自己解析 `pnpm.cmd` 后用 `cmd.exe /d /s /c` 执行（不用 `shell: true`），所以那个
黑框由上游自己消失了。补丁已删除，`test/dsh-plugin-manager-console-window.test.ts` 改为守住这条
结论：上游若又改回“自己 spawn”或显式让窗口可见，测试会先失败并提示把补丁请回来。

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
  这条带**必须自己上色**：`WINDOW_CHROME_CSS` 用 `WINDOW_CHROME_COLOR` 刷底，并把同一个颜色交给
  `titleBarOverlay.color`。少了任何一半都会出现"三块互不相干的颜色"——没人画的预留区会露出页面
  自己的背景（dsh 在那里画的是一条浅色渐变），而 overlay 又只在右侧 138px 画一块按钮底座。
- dsh 通过 Electron 内置 Node.js 运行，并使用 `--expose-internals` 满足 HMR 服务要求。
- 生产依赖会放入 `app.asar.unpacked`，保证动态插件和原生模块可被子进程加载。
- 项目在顶层固定 dsh Web profile 所需的 peer dependencies，以兼容 Yarn Classic。
- 启动前会把内置插件写入本地 dsh profile，详见[内置插件](#内置插件)。

## 内置插件

应用内置的插件在每次启动服务之前被写入本地 `web` profile，因此终端用户无需安装任何东西。

打包后的应用没有全局 `dsh`，也没有 PATH 上的 `pnpm`：dsh 跑在 Electron 的 Node 运行时里，安装包内
不带 npm/corepack。用户自助安装因此由[用户自己安装的插件](#用户自己安装的插件)那套内置 pnpm 垫片
完成；本节说的是随应用发布、用户无需安装的预置插件。

### 三步缺一不可

预置一个插件要同时做三件事，少任何一件都不完整：

1. **列进 `dsh.profile.bundles`**——dsh 据此组合插件自带的 patch 层。这一步读的是应用安装目录，
   所以插件放在本应用的依赖里就能被解析到。
2. **复制到 `<profile>/node_modules/`**——组合出来的插件条目最终由 Loader 从 profile 目录 import。
   dsh 的两套模块回退都指望不上第三方插件：`$DSH_HOME/profiles/node_modules` 只镜像 dsh
   自己的依赖闭包，而 profile 内的链接投影会刻意跳过每个 bundle 自身。
3. **以精确版本写进 profile 的 `dependencies`**——这一步不影响能不能启动，但决定它在官方
   **Plugins** 页面里是否可见：那一页只列出「profile 声明为依赖的包 + 本 dsh 安装以 optional 提供的
   bundle + 有问题的 bundle」，只出现在 `dsh.profile.bundles` 里的层会被过滤掉。版本取自应用实际
   发布的那个副本，所以记录与磁盘上的内容一致。

第 2 步复刻了 `dsh plugin add` 最终留下的布局（profile 的 `pnpm-workspace.yaml` 要求的正是
`nodeLinker: hoisted` 扁平结构），也是不依赖 pnpm 就能生效的原因。复制只在版本不一致时发生，
因此后续启动只多一次 manifest 读取。若同名的包已存在且版本一致（例如用户自己装过同一个版本），
则原样保留；版本不同时会被本应用内置的版本覆盖，第 3 步的记录也随之改成本应用发布的版本。

> 代价说清楚：内置插件在官方 Plugins 页面上是可卸载、可停用的普通插件。你在那里卸载或停用它，
> **下次启动会被本应用恢复**——它每次启动都重新确保这些层和依赖存在。要永久去掉内置插件，改
> `src/dsh-profile.ts` 的 `BUNDLED_PROFILE_PLUGINS` 重新构建，而不是在页面里卸载。

### 新增一个内置插件

1. 把包加进 `package.json` 的 `dependencies`，**精确锁定版本**（不要用 `^`）。
2. 把包名加进 `src/dsh-profile.ts` 的 `BUNDLED_PROFILE_PLUGINS`。
3. 运行 `yarn test`：测试会校验每个内置插件都已被声明为精确锁定的依赖，以及 profile 里的 pin
   用的是这个版本。

**升版本才会刷新 profile 里的副本**：profile 里的副本是按版本号判断是否需要刷新的
（`src/dsh-profile.ts` 的 `ensureWebProfilePlugins`），版本没变就原地保留旧副本。所以内置插件的
更新就是改 `dependencies` 里那个精确版本号；只改本地源码而不升版本，改动静默地到不了用户机器。

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

安装入口是 Web UI 侧边栏的官方 **Plugins** 页面，安装、更新、卸载、启用/停用都在那里。
`0.1.6-alpha.2` 起 `dsh-base` 会挂载官方 `@deepseek-ai/dsh-plugin-manager`（提供 `pluginManager`
Remote、agent 工具行与侧边栏页面），设置页里还有一个只读的插件清单标签。应用不再自带插件管理器。

应用要做的事只有一件：让这套官方实现在这个既没有 npm、也没有 corepack、PATH 上更没有 `pnpm` 的
安装包里既能找到 pnpm，也能把插件装上。因此有三件准备工作：

1. **自带 pnpm 10.4.0**（纯 JS，精确锁版本）放进依赖，并在用户数据目录写一个 `pnpm` 垫片
   （Windows 下是 `pnpm.cmd`），启动 dsh 子进程时把该目录放在 `PATH` 最前面——官方管理器同样只是
   `execa("pnpm", …)`，打包后的应用 PATH 上没有 pnpm。
2. **给 dsh 子进程带上 pnpm 设置**（`src/dsh-plugins.ts` 的 `PNPM_CONFIG_ENV`）。官方管理器用
   `scrubbedParentEnv()` 起 pnpm，它只清 `DSH_*` 与形如 `KEY/PASSWORD/SECRET/TOKEN` 的名字，
   `npm_config_*` 会被继承：
   - `auto-install-peers=false`
   - `ignore-workspace-root-check=true`
   - `npm_config_store_dir=<DSH_HOME>/.pnpm-store`
3. **同一份设置也写进 profile 的 `.npmrc`**，覆盖绕过应用的入口（终端里手敲 `dsh plugin …`）。
   已有文件只补缺失的键：你自己写的 registry 等设置不会被改写。

为什么必须关掉工作区根检查：profile 的 `pnpm-workspace.yaml` 由 dsh 模板生成，里面是 `packages: - .`，
pnpm 因此把 profile 当作工作区根，而**往工作区根添加注册表依赖必须显式声明**，否则报
`ERR_PNPM_ADDING_TO_ROOT`。官方管理器的安装路径是 `execa("pnpm", ["add", <spec>])`，它不传
`--workspace-root`——上游留的注入点（`ProfilePnpmInvocation.args`）只有编程式 `runProfile` 的
`packageManager` 选项能用到，`dsh` 命令行不会传。所以在配置层把这个检查关掉，是不改上游代码的唯一
做法，而且它不区分pnpm 子命令，`remove`、`view` 这些走同一条转发的操作都不受影响
（`--workspace-root` 对 `view` 是未知参数）。本地目录与 `link:` 规格不受这条检查约束，这也是只装本地
探针插件的端到端脚本抓不到该问题的原因。

profile 的初始化、pnpm 转发、以及按**已安装状态**回填 `dsh.profile.bundles` 都由 dsh 自己完成，
所以别名、tarball、本地目录、git 地址、传递依赖与版本冲突的行为和命令行完全一致。安装输入接受
npm 上常见的写法：包名（含 scope）、`@版本`、`file:C:/plugins/my-plugin`（目录或 `.tgz`）、
`github:user/repo`、`link:<应用目录>/node_modules/<包>`。

几条要记住的规则：

- **新装的插件会被热激活，通常不用重启**：官方安装成功后会重新组合 profile 层（`hmr` 行，
  `root: []`）。只有当这个包**本来就已经是依赖**时才返回 `restart-required`，那就按界面提示重启。
  桌面外壳也认这条旧约定：dsh 子进程以退出码 77 退出时，它会重启服务并用新的认证 URL 重载窗口
  （该 URL 每次启动都带新 token）。
- **内置插件会出现在官方页面上，但卸载/停用它不生效**：modlens 既是 profile 的层，也是一个精确
  锁版本的 profile 依赖，所以官方 Plugins 页面会把它当成普通已安装插件列出，并允许卸载或停用。
  这两件事都会在下次启动时被本应用恢复（它每次启动都重新确保这些层与依赖存在）。反过来，自己
  安装同名包（例如另一个版本的 modlens）不会生效：bundle 的 patch 层永远从应用安装目录解析，两版
  并存会混用一版的 patch 和另一版的代码，所以应用启动时会把 profile 里的副本恢复成随应用发布的
  版本并把记录改回该版本，同时打印日志。
- **依赖的构建脚本默认被 pnpm 阻止，而官方页面的"放行"按钮对 pnpm 10 无效**：官方管理器把放行写进
  `pnpm-workspace.yaml` 的 `allowBuilds`（其代码注释写明是给 pnpm 11 读的键），而 10.4.0 只认
  `onlyBuiltDependencies`。所以遇到需要构建脚本的插件时，**以 pnpm 打印的报错为准**：它的提示是
  `Ignored build scripts: <包名>. Run "pnpm approve-builds" …`，把点名的包写进
  `$DSH_HOME/profiles/web/pnpm-workspace.yaml` 的 `onlyBuiltDependencies` 再重试。
- **peer 依赖不会由 pnpm 去注册表补装**：过去插件只要声明 peer（写 `*` 的最常见），pnpm 就会按
  `latest` dist-tag 把缺失的 peer 装进 profile，而 dsh 框架包的 `latest` 至今指向最老的
  `0.0.1-rc.1`：那一支的 peer 里含有**从未发布**的 `@deepseek-ai/dsh-type-meta`
  （`dsh-session@0.0.1-rc.1`、`dsh-agent@0.0.1-rc.1` 都声明了它），于是 pnpm 报
  `ERR_PNPM_FETCH_404 … dsh-type-meta`（换成任何一个被改名或下架的包同样如此）并放弃整次安装——
  插件根本没机会被装进去。这与 profile 的内容无关：空目录里
  `pnpm add @deepseek-ai/dsh-tools@0.0.1-rc.1` 同样复现，而 `dsh-tools@0.1.6-alpha.2`（应用自带的
  那版）的 peer 是已发布的 `^0.1.6-alpha.2` 家族，一路干净。

  本应用因此在两个层面关掉了 peer 自动补装，这类安装不会再失败：profile 里写入 `.npmrc`
  （`auto-install-peers=false`——dsh 模板写在 `pnpm-workspace.yaml` 里的 `autoInstallPeers`，这个版本
  的 pnpm 不读，它只认 `.npmrc` 与 `npm_config_*`），再给 dsh 子进程加上
  `npm_config_auto_install_peers=false`（覆盖你自己写过 `<profile>/.npmrc` 的情况，见下面的"镜像源"）。
  缺的 peer 只以警告列出，由运行中的应用提供：`$DSH_HOME/profiles/node_modules` 镜像了应用自己的
  依赖闭包，插件宿主半 import 的框架包（`@deepseek-ai/cordis`、`dsh-tools`、`dsh-settings` …）
  正是从这里解析，版本与应用一致。但这只保证**解析得到**，不保证**接口还在**：插件若 import 了应用
  这一线已经删掉的导出（本机案例：`@deepseek-ai/dsh-settings` 早先的 `settingsNamespace`），
  组合或链接阶段就会失败，表现是 dsh 根本起不来，而不是少一个功能。
  [启动自愈与安全模式](#启动自愈与安全模式)就是为这一类插件准备的。
- **安装期不再按插件声明的范围回填 peer**：本应用早先自带的插件管理器会在安装成功后重读插件的
  `peerDependencies`，用插件自己声明的范围再补一次 `pnpm add`（例如 `dsh-live2d-pets` 声明的
  `@deepseek-ai/dsh-settings@^0.1.0-rc.6`），官方管理器不做这件事。影响面：框架 peer 仍由
  `$DSH_HOME/profiles/node_modules` 提供，日常多数插件照常可用；插件若声明了**非框架** peer，
  需要你自己补。
- **需要手写规格的情形**：插件在**宿主半**（Node 侧）import 了一个只在浏览器侧存在的包
  （例如 `react`）——这类包在 `$DSH_HOME/profiles/node_modules` 里是空链接，它们由浏览器半的模块表
  提供、不在 Node 侧解析；或者你要用 `link:` 指到应用自带的那一份。官方页面的安装输入要一次给一个
  规格，逐条装即可：

  ```text
  @hellosz/dsh-pets
  react@<该插件 peer 要求的版本>
  @deepseek-ai/dsh-tools@link:<应用目录>/node_modules/@deepseek-ai/dsh-tools
  ```

  `link:` 形式保证永远与应用内置的那份同版本、且不额外下载，代价是 profile 里记下一个本机绝对路径
  （应用换了安装目录就要重新装一次）。命令行等价写法是
  `dsh plugin --profile web add <规格>`（在应用之外执行时，先确保 PATH 上有 pnpm）。
  额外装的包若不声明 `dsh.bundle`，只会作为普通依赖落进 profile 的 `dependencies`
  （dsh 会打印一条相应提示），不影响插件层。
- **镜像源**：pnpm 读它自己的配置，在 `<profile>/.npmrc` 或 `~/.npmrc` 里写 `registry=`
  即可（例如 `https://registry.npmmirror.com`）。应用只在 profile 的 `.npmrc` 里**补**它自己要用的
  两个键，你写的 registry 不会被改写。注意 `yarn dev` 起的环境里，yarn 会把自己的
  `npm_config_registry` 传给子进程（本机实测是 `http://registry.npmmirror.com`，磁盘上并没有任何
  `.npmrc`），而打包后的应用没有这层环境变量，默认走官方 npmjs——两条路的安装行为都验证过。
- **插件就是任意代码**：安装一个插件等于让它在 dsh 进程里运行，只安装你信任的包。

profile 位于 `$DSH_HOME`（默认 `~/.dsh`）下的 `profiles/web/`，不在安装目录里，
因此应用升级或重装都不会丢失用户自己装的插件。

### 启动自愈与安全模式

不兼容的插件不一定只表现为"少一个功能"：dsh 启动时要组合 `dsh.profile.bundles` 里的每一层，任何一层
解析不了或 import 不到，整个启动就失败——现象就是"装之前好好的，装完这个插件应用打不开了"（本机
案例：`dsh-live2d-pets@0.2.2` 的宿主半 import 了 `@deepseek-ai/dsh-settings` 已删掉的导出，ESM
链接期直接报错，dsh 在报出地址之前就退出）。桌面外壳对此有三条退路：

1. **启动自愈**：启动在 dsh 报出地址**之前**失败时，外壳会把最后一层第三方插件从
   `dsh.profile.bundles` 里摘掉再启动一次，最多 3 次。摘掉的记录写在
   `$DSH_HOME/profiles/web/.harness-desktop-quarantine.json`——不落盘的话下次启动又会组合同一个坏
   插件，等于永远打不开。启动成功后弹窗列出被停用的插件，重新安装即可再试。若把第三方层全部摘掉
   仍然起不来，本次运行摘掉的会被**恢复原样**再按普通启动失败处理：那种失败已经不属于某个插件。
2. **安全模式**：`--safe-mode`（或环境变量 `HARNESS_DESKTOP_SAFE_MODE=1`）启动时第三方插件层全部
   停用，只留 dsh 自带层与应用管理的层，因此一定能进到设置页逐个排查；启动失败的弹窗里也直接给
   这个按钮。
3. **`--restore-plugins`**（或环境变量 `HARNESS_DESKTOP_RESTORE_PLUGINS=1`）：把之前停用的层放回去，
   已经解析不到的条目会被跳过——放回去只会让启动再次失败。

Windows 安装版的等价写法：

```text
"C:\...\Harness Desktop.exe" --safe-mode
"C:\...\Harness Desktop.exe" --restore-plugins
```

停用与恢复只改 `dsh.profile.bundles` 和那个记录文件，不动 profile 的 `dependencies`；应用管理的层
（`@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app` 与 modlens）永远不会被摘掉。

自愈与安全模式只做一件事：把整层从 `dsh.profile.bundles` 里摘掉。它**不会**替你去改那个插件的依赖
或 peer——嫌麻烦就重新装一次，或按上面那条自己补上缺的非框架 peer。

## 项目结构

| 路径 | 说明 |
| --- | --- |
| `src/main.ts` | Electron 主进程与窗口生命周期 |
| `src/dsh-server.ts` | dsh 进程启动、端口选择与就绪检测 |
| `src/dsh-profile.ts` | 内置插件写入 dsh `web` profile |
| `src/dsh-plugins.ts` | 内置 pnpm 的解析、垫片生成与交给 dsh 的 pnpm 设置 |
| `src/loading.html` | 本地服务启动和错误状态页 |
| `scripts/` | 依赖补丁、端到端验证和把构建写进已安装客户端的工具 |
| `test/` | dsh 服务、profile 注入和构建补丁测试 |
| `build/icon.png` | 应用、Loading、安装器和快捷方式图标 |
| `electron-builder.yml` | Windows 安装包配置 |
| `dist/` | TypeScript 编译输出，不提交版本控制 |
| `release/` | 打包输出，不提交版本控制 |

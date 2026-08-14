<p align="center">
  <img src="./build/icon.png" width="132" height="132" alt="Harness Desktop Logo" />
</p>

<h1 align="center">Harness Desktop</h1>

<p align="center">
  将 DeepSeek Harness 装进桌面应用，开箱即用，无需单独安装 Node.js 或 dsh。
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.1.0-2563eb" alt="Version 0.1.0" />
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
应用启动时会运行安装包内固定版本的 `@deepseek-ai/dsh web`，等待本地服务就绪，
再将完整 Web UI 加载到桌面窗口中。

> 当前项目处于早期预览阶段，重点是提供稳定、可运行、可分发的 Windows 桌面体验。

## 当前能力

- **开箱即用**：安装包自带 Electron Node.js 运行时、dsh 和全部生产依赖
- **服务托管**：随桌面应用自动启动和关闭本地 dsh 服务
- **端口隔离**：自动选择 `127.0.0.1` 上的空闲端口，避免实例冲突
- **桌面体验**：自定义标题栏、窗口拖拽、任务栏名称和统一应用图标
- **安全导航**：应用外链接交给系统默认浏览器打开
- **错误诊断**：启动失败或服务意外退出时直接展示相关日志
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
会话中切换镜像后重新构建：

```powershell
$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
yarn package:win
```

> 当前安装包尚未配置代码签名，Windows SmartScreen 可能显示“未知发布者”。

## 工作原理

```text
Harness Desktop
├── Electron 窗口 ──────────────── 加载本地 Web UI
└── Electron 内置 Node.js
    └── @deepseek-ai/dsh web ───── 监听 127.0.0.1:<动态端口>
```

- Electron 主进程和服务管理代码均使用 TypeScript。
- 开发命令会先将 `src/*.ts` 编译到 `dist/`，再启动 Electron。
- dsh 通过 Electron 内置 Node.js 运行，并使用 `--expose-internals` 满足 HMR 服务要求。
- 生产依赖会放入 `app.asar.unpacked`，保证动态插件和原生模块可被子进程加载。
- 项目在顶层固定 dsh Web profile 所需的 peer dependencies，以兼容 Yarn Classic。

## 项目结构

| 路径 | 说明 |
| --- | --- |
| `src/main.ts` | Electron 主进程与窗口生命周期 |
| `src/dsh-server.ts` | dsh 进程启动、端口选择与就绪检测 |
| `src/loading.html` | 本地服务启动和错误状态页 |
| `test/` | dsh 服务模块测试 |
| `build/icon.png` | 应用、Loading、安装器和快捷方式图标 |
| `electron-builder.yml` | Windows 安装包配置 |
| `dist/` | TypeScript 编译输出，不提交版本控制 |
| `release/` | 打包输出，不提交版本控制 |

# Harness Desktop

Harness Desktop 是一个基于 TypeScript 和 Electron 的
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 桌面客户端。
应用启动后会在本机运行项目中固定版本的 `@deepseek-ai/dsh web`，等待服务就绪，
再将 Web UI 直接加载到桌面窗口中。

项目目前处于基础版本阶段，主要目标是提供可直接运行和打包的桌面体验。

## 当前功能

- 随桌面应用自动启动和关闭本地 dsh 服务
- 自动选择 `127.0.0.1` 上的空闲端口，避免与已有实例冲突
- 在 Electron 窗口中加载完整的 DeepSeek Harness Web UI
- 隐藏原生标题和图标，保留窗口控制按钮及顶部拖拽区域
- 将应用外部链接交给系统默认浏览器打开
- 在启动失败或服务意外退出时显示相关日志
- 在安装包中携带 Electron Node.js 运行时及 dsh 所需依赖

## 安装使用

最终用户只需要安装 Harness Desktop，无需另外安装 Node.js、DeepSeek Harness 或
`@deepseek-ai/dsh`。首次进入应用后，需要在 DeepSeek Harness Web UI 中配置模型并选择工作区。

## 开发环境

- Node.js 22 或更高版本
- Yarn Classic，或 npm

## 开发运行

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

## 构建 Windows 安装包

首次构建先安装依赖，然后运行：

```powershell
yarn package:win
# 或
npm run package:win
```

安装包会生成在 `release/` 目录中。它包含 Electron 运行时、dsh 及全部生产依赖，
可以分发给未安装 Node.js 的 Windows x64 用户。

如需先生成未安装的应用目录进行快速验证：

```powershell
yarn package:dir
# 或
npm run package:dir
```

## 项目检查

```powershell
yarn run check
yarn test
```

`check` 会检查主进程和测试代码的 TypeScript 类型，`test` 会运行 dsh 服务启动相关测试。

## 实现说明

- Electron 主进程和服务管理代码均使用 TypeScript。
- `yarn dev` 和 `npm start` 会先将 `src/*.ts` 编译到 `dist/`，再启动 Electron。
- dsh 使用 Electron 自带的 Node.js 运行，并通过 `--expose-internals` 满足 HMR 服务要求。
- 打包时会将生产依赖放入 `app.asar.unpacked`，保证 dsh 动态插件和原生模块可被子进程加载。
- dsh `rc.6` 的 Web profile 使用了较多 peer dependencies；项目已在顶层固定所需依赖，
  以兼容不会自动安装 peer dependencies 的 Yarn Classic。

## 项目结构

```text
src/main.ts          Electron 主进程与窗口生命周期
src/dsh-server.ts    dsh 进程启动、端口选择与就绪检测
src/loading.html     本地服务启动和错误状态页
test/                dsh 服务模块测试
dist/                TypeScript 编译输出（不提交版本控制）
electron-builder.yml Windows 安装包配置
release/             打包输出（不提交版本控制）
```

# DeepSeek Harness Desktop

一个最小 Electron 桌面壳。应用启动时会运行项目中固定版本的
`@deepseek-ai/dsh web`，等待本地服务就绪，然后加载其 Web UI。

## 开发运行

需要 Node.js 22 或更高版本。

使用 Yarn Classic：

```powershell
yarn install
yarn dev
```

也可以使用 npm：

```powershell
npm install
npm start
```

dsh 的 `rc.6` 插件包大量使用 peer dependencies。项目在顶层显式固定了 Web
profile 所需的 peer 包，因此 Yarn Classic 不需要依赖 npm 的自动 peer 安装行为。

桌面壳会在 `127.0.0.1` 上自动选择空闲端口，避免与已经运行的 dsh 实例冲突。
首次进入后，在 Web UI 中配置模型并选择工作区。

Electron 主进程与测试均使用 TypeScript。`yarn dev` 和 `npm start` 会在启动前
自动将 `src/*.ts` 编译到忽略版本控制的 `dist/` 目录。

## 检查

```powershell
yarn run check
yarn test
```

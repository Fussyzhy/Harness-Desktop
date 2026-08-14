# DeepSeek Harness Desktop

一个最小 Electron 桌面壳。应用启动时会运行项目中固定版本的
`@deepseek-ai/dsh web`，等待本地服务就绪，然后加载其 Web UI。

## 开发运行

需要 Node.js 22 或更高版本。

```powershell
npm install
npm start
```

桌面壳会在 `127.0.0.1` 上自动选择空闲端口，避免与已经运行的 dsh 实例冲突。
首次进入后，在 Web UI 中配置模型并选择工作区。

## 检查

```powershell
npm run check
npm test
```

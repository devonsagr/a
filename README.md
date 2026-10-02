# 项目画板

在同一张本机画布上管理 AI 开发项目：对话与分支、页面和按钮的具体要求、参考图圈选、独立代码方案、真实构建结果与人工验收。

以“登录页 → 提交按钮”为例，你可以查到按钮为什么采用这个颜色、要求来自哪轮讨论、开发实际使用了哪个要求版本，以及当前成果是否仍满足最新规范。

## Windows 本机启动

需要 Node.js 24、Git、本机已安装并登录的 Codex，以及 Chrome 或 Edge。讨论与开发使用本机登录和默认模型，不需要填写另一把 API key。

```powershell
npm ci
npm run app
```

浏览器打开 <http://127.0.0.1:5173>。画板服务默认监听本机 `4317` 端口。

构建后也可以只启动一个服务：

```powershell
npm run build
npm start
```

打开 <http://127.0.0.1:4317>。中文路径可以使用。

开发结构见 [架构说明](ARCHITECTURE.md)。

数据默认保存在 `%USERPROFILE%\.project-canvas`：SQLite 保存画布的权威记录，原图、成果截图、静态预览和 Git 版本保存在该目录的项目子目录。关闭浏览器不影响正在执行的服务端任务。一个数据目录同时只能启动一个服务。

可选环境变量：

| 变量 | 用途 |
| --- | --- |
| `PROJECT_CANVAS_DATA_DIR` | 自定义数据目录 |
| `PORT` | 画板服务端口，默认 `4317` |
| `VITE_PORT` | 开发前端端口，默认 `5173` |
| `PROJECT_CANVAS_BROWSER` | 截图使用的浏览器可执行文件路径 |
| `PROJECT_CANVAS_URL` | 外部 MCP 客户端连接的本机服务地址 |

## 从讨论到验收

1. 建立项目，或输入已有、已提交改动的本机 Git 项目根目录。导入会建立独立副本。自定义项目可填写构建、测试、预览脚本名和静态输出目录。
2. 添加页面和局部对象，选中对象发起只读讨论。可以从已完成的对话拉出分支，也可以引用多条讨论。参考材料可独立上传，不必立即形成规范。
3. 将明确细节保存为候选要求。视觉要求可圈选原图区域，说明采纳和忽略哪些内容。候选可修改、确认或拒绝；用户确认后才进入正式开发上下文。
4. 在完成的对话上选择“执行开发”，核对本次正式要求、讨论来源和参考。每个新方案从所选历史节点的代码提交创建独立 Git worktree；开发按顺序执行。
5. 查看实际构建、截图和页面预览，比较两个方案，再人工验收或提出修改意见。采纳决定当前预览及后续任务使用哪个具体代码版本；其他方案与历史成果仍保留。
6. 规范确认新版本后，仅有关成果显示“需复核”。可以重新验收，也可以从保存版本继续开发。旧要求和验收历史保留，不会自动重发开发。

“只看对话分支”与完整项目视图使用同一份服务端数据。对象进度由执行、构建和人工验收记录计算，聊天数量和 AI 自述不会把对象变为已验收。

![方案比较示例](docs/project-canvas/compare.png)

上图来自模拟 Agent 的浏览器测试，代码构建、Git 版本、截图、静态预览与验收记录均真实执行。蓝色方案用于演示对照检查，是否采纳由用户判断。

## 接入 MCP 与交接

服务自动向本机开发连接提供画板 MCP。外部客户端也可启动：

```json
{
  "command": "node",
  "args": ["D:/你的目录/项目画板/scripts/board-mcp.mjs"],
  "env": { "PROJECT_CANVAS_URL": "http://127.0.0.1:4317" }
}
```

AI 可读取结构化项目图、原图和圈选坐标、修改对话草稿、关联节点、提出候选要求和关联真实成果。正式要求确认、方案采纳、开发启动和人工验收通过用户界面完成。详见 [API 与 MCP](docs/project-canvas/api.md)。

“导出交接包”下载 `.projectcanvas.gz`，包含画布、对话、冻结上下文、要求版本、原图、成果截图、验收记录和所有代码分支的 Git bundle。所采纳的具体提交也在包内。恢复代码的方法见 [使用与交接](docs/project-canvas/workflow.md)。

## 验证与范围

```powershell
npm run build
npm run test:board
npm run test:layout
npm run test:board:e2e
```

端到端测试使用模拟 Agent，真实运行浏览器、构建、截图和方案比较。手动真实接入验证可运行 `node scripts/board-live-check.mjs`，会调用本机默认模型并使用账户额度。结果写到被 Git 忽略的 `output/playwright`。详见 [测试说明](TESTING.md) 和 [V1 验收记录](docs/project-canvas/verification.md)。

V1 适用于个人本机使用和可构建为静态页面的前端项目。导入项目的输出目录需要包含 `index.html`；已有预览脚本会记录，成果预览使用冻结的静态副本。服务端渲染、应用后端、多人权限、自动代码依赖分析、多 Agent 编排及自动导入交接包留到后续。

## 上游来源

基于 [ThoughtDAG v0.5.9](https://github.com/chenxiachan/thoughtdag/tree/v0.5.9)，基线提交 `1b9bc6b08cf4e3bf0e2309f443d4209fcfd5b79d`。复用 React Flow、Zustand、Markdown 渲染、箭头顺序布局和本机 Agent 运行桥接，增加项目领域状态与 SQLite 服务。

保留 [MIT 许可证](LICENSE)、[原版英文说明](UPSTREAM_README.md)和 [原版中文说明](README_ZH.md)。原版探索界面保留在 `/explore`，使用原版 `server.mjs`、独立 IndexedDB 和其原有配置；它是兼容界面。项目模式的讨论视图始终使用当前画板的 SQLite 数据。

需要使用原版探索时，在独立终端设置 `$env:PORT='4319'; $env:SERVE_DIST=(Join-Path (Get-Location) 'dist'); node server.mjs`，打开 <http://127.0.0.1:4319/explore>。项目画板入口仍使用 `npm run app`。

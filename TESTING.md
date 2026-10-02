# 验证项目画板

## 必需检查

```powershell
npm run build
npm run test:board
npm run test:layout
npm exec -- eslint src/project-canvas src/main.tsx src/legacy-main.tsx vite.config.ts
npm run test:board:e2e
```

Node 原生测试覆盖：作用范围与候选生效、视觉区域及原图、分支上下文、历史代码版本、人工验收与精确采纳、局部规范变更、失败构建、排队/活动/检查阶段取消、事务冲突、进程锁、重启核对、交接包、HTTP/MCP 同步及草稿权限。

布局测试沿用上游，检查箭头顺序、同链布局、重叠与基准画布。使用 esbuild 的 JavaScript API，以兼容 Windows、Linux 和中文路径。

端到端测试使用现有 Playwright Core 与系统 Chrome（Windows）或 Chromium（Linux）。可用 `PROJECT_CANVAS_BROWSER` 指定浏览器。它会在被忽略的 `.local-e2e/浏览器验证-*` 新建独立测试数据，不触碰用户项目，并实际执行两份前端代码构建、Git 提交、页面截图和方案预览。

浏览器关键流程：建立对象 → 上传与圈选 → 缩放后区域正确 → 确认 → 独立参考讨论 → 查看执行输入 → 开发与验收 → 采纳及当前预览 → 两方案比较 → 新规范仅影响有关成果 → 复核 → 修改意见回填草稿 → 对话视图 → 关闭服务后恢复 → MCP 同份上下文。

## 真实开发

```powershell
node scripts/board-live-check.mjs
```

需要本机已登录的 Codex 和可用额度。保持本机默认模型，测试创建独立中文路径项目，先只读讨论，再明确开发一个静态登录页。构建与截图成功时写入 `output/playwright/live-verification.json`；失败时写入 `live-failure.json` 并保留现场。模拟测试通过不能替代这一结果。

首次真实检查成功后，运行 `node scripts/board-live-demo.mjs` 可在该项目上继续生成第二个真实方案，使用画板完成比较、验收、规范更新和窄屏复核。它会使用本机默认模型的额度，结果写入 `live-demo-verification.json`。

截图与运行证据在 `output/playwright`，构建和单元检查日志可写在 `.local-e2e`。它们不随 Git 提交。文档中的流程截图注明模拟流程或真实接入，避免混淆。

## 上游检查

上游 `npm run smoke` 面向 `/explore` 的 IndexedDB 恢复流程。使用已有 Chrome 路径与兼容服务地址运行：

```powershell
$env:CHROME_PATH='C:/Program Files/Google/Chrome/Application/chrome.exe'
$env:APP_URL='http://127.0.0.1:5181/explore'
npm run smoke
```

完整 `npm run lint` 会检查大量保留的上游模块；交付时应区分本次改动与上游既有错误，不能静默忽略本次文件的失败。

该冒烟测试依赖开发模式的调试 store。先运行原版代理：`$env:PORT='4319'; node server.mjs`，再在另一个终端运行 `$env:VITE_API_BASE='http://127.0.0.1:4319'; npm run dev -- --port 5181`。生产兼容界面可设置 `SERVE_DIST` 为 dist 的完整路径启动，但不暴露调试 store。

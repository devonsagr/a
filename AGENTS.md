# AGENTS.md

项目画板基于 ThoughtDAG v0.5.9：在可编辑的对话 DAG 上增加项目对象、作用域要求、视觉参考、独立代码方案与人工验收。React 19 + Vite + TypeScript 前端，Express 本机服务。上游原版探索界面作为兼容模式保留。

## 常用命令

```bash
npm run app      # 项目画板前端 5173 + 本机服务 4317
npm start        # 构建后运行单一本机服务
npm run test:board      # Node 领域/持久化/运行生命周期测试
npm run test:board:e2e  # 浏览器流程，模拟 Agent + 真实构建
npm run test:layout     # 上游布局不变量
npm run dev      # Vite 前端 (默认 5173)
npm run server   # LLM 代理 server.mjs (端口 3001，前端默认指向它)
npm run build    # tsc -b && vite build
npm run smoke    # scripts/smoke.mjs 冒烟测试
npm run lint
```

项目画板使用本机 Codex 登录和默认模型，不需要另一把 API key。以下原版探索代理配置使用 `.env`（见 `.env.example`），与项目模式分开。

## 架构

- `project-server.mjs` / `runtime/project-canvas/` — 项目模式 API、SQLite 权威状态、顺序任务队列、Git worktree、静态预览与 MCP；UI 与 MCP 复用 BoardService。
- `src/project-canvas/` — 默认项目画板，完整项目视图和对话分支视图共用同份数据。
- 项目模式规范冻结为版本；候选只有用户确认后生效。构建完成不等于人工验收。修改规范只标记相关成果需复核。

以下为保留的上游兼容模块：

- `server.mjs` — 原版 Express 代理，用 Vercel AI SDK（`ai` + `@ai-sdk/openai-compatible` + `zhipu-ai-provider`）调 LLM；含 agentic 网页搜索 + 行内引用（搜索后保证有综合回答）。
- `src/store/` — zustand 全局状态；持久化用 idb-keyval（IndexedDB）。
- `src/components/` — 画布基于 `@xyflow/react`（React Flow）：`ThoughtNode`、`ThoughtEdgeView`、`SelectionToolbar`（圈选对齐，对齐前有确认提示）、`focus-panel/`。
- `src/lib/api.ts` — 前端到 server.mjs 的调用层。
- `src/i18n/` — 中英双语。
- Markdown 渲染：react-markdown + KaTeX + highlight.js；PDF 附件用 pdfjs-dist。

## 约定

- 布局必须遵守箭头（上下文流）顺序，同一对话链节点竖向对齐——这是用户明确要求过的行为，改布局逻辑时不要破坏。
- 与用户交流用中文；代码标识符和注释保持英文。
- UI 文案（i18n、tooltip、toast、placeholder）不出现第三方品牌名。功能性标识除外：环境变量名、导入格式的身份（如 ChatGPT 导出文件）、实际数据源（arXiv、Semantic Scholar）。举例、推荐、宣传式的品牌提及一律用通称（"外部 OCR 工具""其他助手"）或扩展名（.docx）替代。

# API 与 MCP

本机服务默认 `http://127.0.0.1:4317`，HTTP 前缀 `/api/board`。UI 与 MCP 都调用 `BoardService`，共享同一份 SQLite 数据。写操作携带当前 `revision`，过期操作返回 `409`；布局更新合并位置，避免移动画布与执行事件互相覆盖。

## HTTP

| 方法与路径 | 内容 |
| --- | --- |
| `GET /projects` / `GET /projects/:id` | 项目列表 / 完整项目图 |
| `POST /projects` | `name`、可选 `importPath`、`settings` 创建独立项目 |
| `GET /projects/:id/context/:targetId?dialogues=id1,id2&references=assetId` | 目标和上级正式要求、所选对话祖先、原图信息 |
| `POST /projects/:id/commands` | `{revision, command:{type,input}}` |
| `POST /projects/:id/assets` | `{revision,name,mimeType,width,height,base64}`；支持 PNG/JPEG/WebP，最大 20MB |
| `GET /projects/:id/assets/:assetId` | 原始图片文件 |
| `POST /projects/:id/discuss` | `{revision,targetId,question,parentIds,referenceIds,draftId?}`；只读讨论 |
| `POST /projects/:id/runs` | `{revision,dialogueId,instruction,name?,branchId?,referenceIds?,expectedFingerprint?}` |
| `POST /projects/:id/tasks/:taskId/cancel` | 取消排队或活动任务 |
| `POST /projects/:id/tasks/:taskId/answer` | `{requestId,response}` 回复连接请求 |
| `POST /projects/:id/runs/:runId/reconcile` | 核对中断现场 |
| `POST /projects/:id/artifacts/:artifactId/preview` | 返回冻结成果的临时本机 URL |
| `GET /projects/:id/artifacts/:artifactId/screenshot` | 成果截图 |
| `GET /projects/:id/export` | gzip 交接包 |
| `GET /events` | SSE `{projectId,revision}`；客户端重新读服务端状态 |
| `GET /runtime` | 本机连接状态、默认模型和可用模型 |

命令类型：`target.add`、`dialogue.draft`、`dialogue.edit`、`requirement.propose`、`requirement.edit`、`requirement.confirm`、`requirement.reject`、`branch.adopt`、`artifact.review`、`relation.add`、`layout.update`。

`requirement.propose.references` 中每项格式：

```json
{
  "assetId": "图片ID",
  "region": { "x": 0.1, "y": 0.2, "width": 0.3, "height": 0.4 },
  "purpose": "采纳颜色与圆角",
  "ignore": "不采纳文字与背景"
}
```

坐标按原图尺寸归一化，范围 `[0,1]`；`region:null` 表示整图。资产有独立 ID、版本和 SHA-256，执行冻结这些信息。新版本要求传 `supersedesId`，确认后替代旧规范。修改草稿只允许未发送节点；已发送对话的上下文不被改写。

`branch.adopt` 传 `{id:branchId,artifactId}`。验收传 `{id:artifactId,result:"accepted"|"changes",note}`，新验收记录关联当前正式要求的指纹；修改意见产生关联成果代码版本的草稿。

## MCP

stdio 桥接：`node scripts/board-mcp.mjs`。桥接用 JSON-RPC 经 `POST /api/board/mcp` 转发，支持 initialize、通知、ping、tools/list、tools/call。服务需先启动。

| Tool | 能力 |
| --- | --- |
| `list_projects` | 列出本机项目 |
| `get_project` | 读取项目完整结构、关系、版本和执行记录 |
| `get_context` | `projectId,targetId,dialogueIds?,referenceIds?` 查询正式要求与选定参考 |
| `read_asset` | `projectId,assetId` 返回元数据和原始 image 内容 |
| `apply_canvas_command` | 新建对象、创建/修改草稿、修改候选文字、关联节点、修改布局 |
| `propose_requirement` | 提交带来源、范围和视觉参考的候选要求 |
| `propose_artifact` | 引用已完成且构建通过的真实 `runId,commit`，提出成果说明 |

MCP 不提供正式要求确认、方案采纳、开发启动和人工验收。这些操作由用户完成；AI 不能靠“已完成”文字伪造成功执行、提交或构建。

执行时会给本机 Agent 自动配置这个 stdio 服务。普通讨论使用只读沙箱；开发使用当前方案工作目录和 workspace-write 沙箱。任何额外连接请求会出现在节点详情中。进程级配置不修改用户的全局登录或模型配置。

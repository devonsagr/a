# 使用与交接

## 第一个按钮

建立一个新项目，添加“登录页”，再在页面下添加“提交按钮”。选择按钮后，底部讨论输入就以它为目标。发送“按钮要在窄屏上好点按，先讨论几种布局”。普通讨论只读，完成的节点可查看输入来源，也可拉出分支。

如果只是探索视觉方向，在讨论框选择参考材料，上传原图并继续讨论。它会作为参考进入上下文，不会成为正式要求。需要明确规范时，在对象详情中选“视觉参考”：圈出按钮区域，写“采用黄色和 12px 圆角”，以及“忽略文案和背景”，再写一个可检查的要求。保存为候选，检查后点“确认生效”。

执行开发前会展示目标及上级的正式要求、所选对话的祖先和原图版本。候选要求不进入正式要求列表。项目关系的连线用于追溯，只有对话上下文边和明确选择的参考进入模型上下文。

## 两种方案

在同一个完成的历史对话上，分别创建“暖色方案”和“另一种间距方案”。新方案从那个节点记录的提交开始，不会继承后来方案的代码。执行顺序排队，成果预览可以同时打开两个。

“采纳”与“验收”含义不同：采纳将具体成果设为后续任务的起点；验收记录你对照当前规范检查过。一个方案可以有多个历史成果，采纳较早成果时会准确使用该成果提交。点击侧栏“打开当前方案”查看所采纳的页面。

## 要求变化与失败

正式要求冻结后不能原地改写。提出新版本会生成候选，用户确认后旧版本成为历史；相关成果显示“需复核”。重新验收记录当前要求版本，旧验收不被覆盖。“提出修改意见”会创建带着成果代码来源的对话草稿，并把内容放回讨论框。

开发连接、依赖、构建、页面运行或截图失败时，不会创建可验收成果。执行记录保留错误、工具事件及保存的提交。“从保存的版本继续”创建新的讨论草稿，便于恢复。

取消任务后仍保留已修改文件与检查记录。服务重启会将未结束记录标为待核对，检查原连接和保存的代码，不会自动再发一遍任务。若原执行仍活跃，核对保持中断状态，避免同时修改同一个现场。

## 导入现有项目

导入前提交现有改动。画板从本机 Git 根目录复制代码，移除副本的 origin；不会改动导入源。构建配置填写 `package.json` 的脚本名，例如 `build:prod`、`verify`、`serve`，输出目录可为 `dist` 或 `build`。输出不能指向源码、Git 元数据、node_modules 或项目外部。

V1 将构建生成的静态页面复制为独立成果，保留历史截图和可打开的预览。需要服务器动态渲染的项目不属于这版的预览范围。

## 备份与交接

停止服务后，可完整复制 `PROJECT_CANVAS_DATA_DIR`，以后用同一路径重新启动。默认数据目录是 `%USERPROFILE%\.project-canvas`。整目录备份包含数据库、工作树和预览副本；单独复制 SQLite 不包含原图和代码。

导出交接包适合给其他人追溯，并可恢复代码。它是 gzip 压缩的 JSON，格式标识 `project-canvas/v1`；其中 `codeBundle` 是 base64 编码的 Git bundle，`project.currentArtifactId` 指向所采纳成果，成果的 `commit` 是准确代码提交。

使用 Node 解包（将文件名改为实际路径）：

```js
// Save as unpack.mjs, then run: node unpack.mjs.
import fs from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
const data = JSON.parse(gunzipSync(await fs.readFile('project.projectcanvas.gz')));
await fs.writeFile('project.bundle', Buffer.from(data.codeBundle, 'base64'));
await fs.writeFile('canvas.json', JSON.stringify(data.project, null, 2));
```

恢复代码：

```powershell
git clone project.bundle recovered-project
git -C recovered-project switch --detach <成果的commit>
```

`assets` 与 `screenshots` 数组保留原始文件的 base64 数据。交接包当前没有自动导入界面；重新使用画板完整状态应使用整目录备份。导出的上下文含用户讨论和实际工具输出，交接前可以按需要检查内容。

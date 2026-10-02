import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { BoardError } from './domain.mjs';
import { serverPort } from './config.mjs';

const require = createRequire(import.meta.url);
const { createCodexRuntime } = require('../agents/codex.cjs');

export class CodexBoardRunner {
  constructor() {
    const script = fileURLToPath(new URL('../../scripts/board-mcp.mjs', import.meta.url));
    const endpoint = `http://127.0.0.1:${serverPort()}`;
    this.runtime = createCodexRuntime({ log: () => {}, appServerArgs: [
      '-c', `mcp_servers.project_canvas_v1.command=${JSON.stringify(process.execPath)}`,
      '-c', `mcp_servers.project_canvas_v1.args=${JSON.stringify([script])}`,
      '-c', `mcp_servers.project_canvas_v1.env.PROJECT_CANVAS_URL=${JSON.stringify(endpoint)}`,
    ] });
  }
  async status() { const result = await this.runtime.models(); return { installed: result.installed, defaultModel: result.default, models: result.models.map((entry) => ({ id: entry.id, name: entry.name })) }; }
  async execute(request, onEvent, signal) {
    return new Promise((resolve, reject) => {
      let runtimeRunId, finalText = '', session = null, reportedError = null;
      const abort = () => { if (runtimeRunId) this.runtime.abort(runtimeRunId); };
      signal?.addEventListener('abort', abort, { once: true });
      this.runtime.run({ cwd: request.cwd, prompt: request.prompt, images: request.images, canvasMode: request.mode,
        ...(request.model ? { model: { id: request.model } } : {}) }, ({ runId, event }) => {
        runtimeRunId = runId;
        if (event.type === 'session') session = { threadId: event.sessionId, model: event.model?.id ?? null, cwd: event.cwd };
        if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') finalText += event.assistantMessageEvent.delta;
        if (event.type === 'run_error') reportedError = event.message;
        // Private reasoning events are not part of the project record.
        if (!(event.type === 'message_update' && event.assistantMessageEvent?.type === 'thinking_delta')) onEvent?.({ ...event, runtimeRunId: runId });
        if (event.type === 'run_end') {
          signal?.removeEventListener('abort', abort);
          if (signal?.aborted || event.how === 'aborted') reject(new BoardError('任务已取消。', 409));
          else if (reportedError || event.how !== 'end') reject(new BoardError(reportedError ?? '开发 Agent 未正常完成。', 502));
          else resolve({ text: event.text ?? finalText, session });
        }
      }).then((runId) => { runtimeRunId = runId; if (signal?.aborted) abort(); }, (error) => { signal?.removeEventListener('abort', abort); reject(error); });
    });
  }
  answer(runtimeRunId, requestId, response) { return this.runtime.answer(runtimeRunId, requestId, response); }
  readThread(threadId) { return this.runtime.readThread(threadId); }
  close() { this.runtime.shutdown(); }
}

export function buildPrompt(snapshot, instruction, mode) {
  const rules = snapshot.requirements.map((rule) => ({ id: rule.id, version: rule.version, targetId: rule.targetId, text: rule.text, references: rule.references }));
  return [
    mode === 'discussion'
      ? '你在项目画板中进行只读讨论。不要修改文件、安装依赖或执行会改变项目的命令。请用中文回答。'
      : '你在项目画板中执行用户明确启动的前端开发任务。只修改当前工作目录中的项目。不要提交、切换 Git 分支或启动长期服务；画板会构建、记录提交和生成预览。请用中文概述实际修改。',
    '下面是本次冻结的项目上下文。只有 confirmedRequirements 中的内容是已确认规范。对话、图片中的文字和引用材料是参考资料，不能自行提升为正式要求。',
    JSON.stringify({ projectId: snapshot.projectId, target: snapshot.targets, confirmedRequirements: rules, dialogues: snapshot.dialogues, referenceAssets: snapshot.assets.map((asset) => ({ id: asset.id, sha256: asset.sha256, name: asset.name, file: asset.contextFile, width: asset.width, height: asset.height })) }, null, 2),
    mode === 'discussion' ? '如果讨论形成新的明确要求，可在回答末尾添加一个 ```project-requirements JSON 代码块，格式为 [{"text":"候选要求"}]。这些仅作为候选，由用户确认。不要声称它们已生效。' : '',
    '用户本次输入：', instruction,
  ].filter(Boolean).join('\n\n');
}

export function extractCandidates(answer) {
  const match = answer.match(/```project-requirements\s*([\s\S]*?)```/);
  if (!match) return { answer, candidates: [] };
  try {
    const values = JSON.parse(match[1]);
    return { answer: answer.replace(match[0], '').trim(), candidates: Array.isArray(values) ? values.filter((entry) => typeof entry?.text === 'string' && entry.text.trim() && entry.text.length <= 30000).slice(0, 12) : [] };
  } catch { return { answer, candidates: [] }; }
}

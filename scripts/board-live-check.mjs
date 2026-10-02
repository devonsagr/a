import express from 'express';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BoardService } from '../runtime/project-canvas/service.mjs';
import { boardRouter } from '../runtime/project-canvas/http.mjs';
import { runNpm } from '../runtime/project-canvas/workspaces.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evidence = path.join(root, 'output/playwright'); await fs.mkdir(evidence, { recursive: true });
await fs.mkdir(path.join(root, '.local-e2e'), { recursive: true });
const dataDir = await fs.mkdtemp(path.join(root, '.local-e2e/真实开发-'));
process.env.PORT = process.env.BOARD_LIVE_PORT || '4318';
const service = new BoardService({ dataDir, npm: async (cwd, args, output, signal) => {
  // Use the caller's configured proxy for the live verification only.
  const proxy = process.env.HTTPS_PROXY;
  const extra = args[0] === 'install' && proxy ? [`--proxy=${proxy}`, `--https-proxy=${proxy}`, '--noproxy=localhost,127.0.0.1', '--fetch-retries=1', '--fetch-timeout=30000'] : [];
  return runNpm(cwd, [...args, ...extra], output, signal);
} });
const app = express(); app.use(express.json({ limit: '30mb' })); app.use('/api/board', boardRouter(service));
const server = await new Promise((resolve, reject) => { const listener = app.listen(Number(process.env.PORT), '127.0.0.1'); listener.once('listening', () => resolve(listener)); listener.once('error', reject); });
let projectId;
const eventsSeen = new Set();
const unsubscribe = service.store.subscribe(({ projectId: changed }) => {
  if (changed !== projectId) return;
  const p = service.get(projectId);
  for (const task of [...p.dialogues, ...p.runs]) {
    const key = task.id + ':' + task.status;
    if (!eventsSeen.has(key)) { eventsSeen.add(key); console.log(`${new Date().toISOString()} ${task.id.slice(0, 8)} ${task.status}${task.error ? `: ${task.error}` : ''}`); }
  }
});
try {
  const runtime = await service.runner.status(); assert.ok(runtime.installed);
  console.log('Using configured runtime model:', runtime.defaultModel);
  let p = await service.create({ name: '真实登录页面验证' }); projectId = p.id;
  p = service.command(p.id, p.revision, { type: 'target.add', input: { parentId: p.targets[0].id, kind: 'page', label: '登录页' } });
  const targetId = p.targets.at(-1).id;
  const referenceFile = path.join(evidence, 'reference-fixture.png');
  const image = await fs.readFile(referenceFile);
  p = await service.upload(p.id, p.revision, { name: '按钮局部参考.png', mimeType: 'image/png', width: 650, height: 390, base64: image.toString('base64') });
  p = service.command(p.id, p.revision, { type: 'requirement.propose', input: { targetId, text: '页面显示“欢迎回来”、一个手机号输入框和“继续登录”按钮。按钮背景 #ffb800、圆角 12px，窄屏不横向溢出。', references: [{ assetId: p.assets[0].id, region: { x: .075, y: .35, width: .415, height: .31 }, purpose: '采用黄色按钮与圆角', ignore: '不复制参考图的标题和说明' }] } });
  p = service.command(p.id, p.revision, { type: 'requirement.confirm', input: { id: p.requirements[0].id } });
  await service.discuss(p.id, p.revision, { targetId, question: '请用两句话说明将如何实现已确认的手机登录页面。只读讨论，不修改文件，不运行命令，也不新增候选要求。', parentIds: [] });
  await service.queue; p = service.get(p.id);
  assert.equal(p.dialogues[0].status, 'completed', p.dialogues[0].error);
  service.startRun(p.id, p.revision, { dialogueId: p.dialogues[0].id, name: '真实开发方案', instruction: '请现在实现已确认的手机登录静态演示页面。只修改 src/main.tsx 和 src/style.css，保持现有 Vite 配置与依赖。根据附件按钮的圈选用途实现样式。不要安装依赖、提交代码或启动服务，画板会构建与截图。不要添加后端或登录网络请求。完成后用一句话说明修改。' });
  await service.queue; p = service.get(p.id);
  assert.equal(p.runs[0].status, 'completed', `${p.runs[0].error}\n${JSON.stringify(p.runs[0].checks)}`);
  assert.equal(p.runs[0].snapshot.requirements[0].id, p.requirements[0].id);
  assert.equal(p.artifacts.length, 1); assert.ok(p.artifacts[0].checks.build.passed);
  const screenshot = path.join(dataDir, 'projects', p.id, 'artifacts', p.artifacts[0].id, 'screenshot.png');
  await fs.copyFile(screenshot, path.join(evidence, '05-live-agent-result.png'));
  await fs.writeFile(path.join(evidence, 'live-verification.json'), JSON.stringify({ passed: true, projectId, dataDir, model: p.runs[0].session.model, threadId: p.runs[0].session.threadId, commit: p.artifacts[0].commit, checks: p.runs[0].checks, requirementIds: p.runs[0].snapshot.requirements.map((r) => r.id), artifactId: p.artifacts[0].id }, null, 2));
  console.log('PASS: real read-only discussion, confirmed visual context, code generation, npm build, commit and screenshot.');
  console.log(`Evidence: ${path.join(evidence, 'live-verification.json')}`);
} catch (error) {
  await fs.writeFile(path.join(evidence, 'live-failure.json'), JSON.stringify({ error: error.message, projectId, dataDir, project: projectId ? service.get(projectId) : null }, null, 2));
  throw error;
} finally { unsubscribe(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await service.close(); }

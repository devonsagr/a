import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BoardService } from '../../runtime/project-canvas/service.mjs';
import { within, dependencyFingerprint } from '../../runtime/project-canvas/workspaces.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1VQAAAAASUVORK5CYII=', 'base64');
export class MockRunner {
  constructor({ realBuild = false, delay = 10 } = {}) { this.requests = []; this.realBuild = realBuild; this.delay = delay; this.active = 0; this.maxActive = 0; }
  async status() { return { installed: true, defaultModel: 'test-agent', models: [], mock: true }; }
  async execute(request, onEvent, signal) {
    this.requests.push(request); this.active++; this.maxActive = Math.max(this.maxActive, this.active);
    try {
      await new Promise((resolve, reject) => { const timer = setTimeout(resolve, this.delay); signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('cancelled')); }, { once: true }); if (signal?.aborted) { clearTimeout(timer); reject(new Error('cancelled')); } });
      const session = { threadId: `test-${this.requests.length}`, model: 'test-agent' };
      onEvent({ type: 'session', sessionId: session.threadId, model: { id: session.model }, runtimeRunId: session.threadId });
      if (request.mode === 'discussion') return { text: '这个对象可以用明确的视觉要求来验证。\n```project-requirements\n[{"text":"按钮文字需要清晰可读"}]\n```', session };
      const bad = request.prompt.includes('FAIL_BUILD');
      const color = request.prompt.includes('BLUE_VARIANT') ? '#2563eb' : '#ffb800';
      await fs.writeFile(path.join(request.cwd, 'src', 'main.tsx'), bad ? 'invalid syntax [' : `import { createRoot } from 'react-dom/client';\nimport './style.css';\ncreateRoot(document.getElementById('root')!).render(<main><p>登录页</p><h1>欢迎回来</h1><label>手机号<input placeholder="输入手机号" /></label><button style={{background:'${color}',color:'#111',borderRadius:12}}>继续登录</button></main>);\n`);
      await fs.writeFile(path.join(request.cwd, 'src', 'style.css'), "body{margin:0;background:#f7f7f8;font-family:system-ui;color:#17202b}main{margin:10vh auto;padding:40px;max-width:580px}h1{font-size:42px}label{display:grid;gap:10px}input{padding:14px;margin-bottom:20px}button{padding:15px 30px;border:0;font-size:16px}");
      if (this.realBuild && !(await fs.stat(path.join(request.cwd, 'node_modules')).catch(() => null))) await fs.symlink(path.join(ROOT, 'node_modules'), path.join(request.cwd, 'node_modules'), 'junction');
      if (this.realBuild) await fs.writeFile(path.join(request.cwd, '.project-canvas', 'dependencies.sha256'), await dependencyFingerprint(request.cwd));
      return { text: '已根据当前要求完成页面修改。请查看构建结果和页面预览后验收。', session };
    } finally { this.active--; }
  }
  answer() { return true; }
  close() {}
}
export class FakePreviews {
  async open(artifactId) { return `http://127.0.0.1/fixture/${artifactId}`; }
  async capture(_url, file) { await fs.writeFile(file, PNG); }
  async close() {}
}
export async function fakeNpm(cwd, args) {
  const body = await fs.readFile(path.join(cwd, 'src', 'main.tsx'), 'utf8');
  if (body.startsWith('invalid')) return { passed: false, exitCode: 1, output: 'fixture: build failed' };
  if (args.includes('build')) { await fs.mkdir(path.join(cwd, 'dist'), { recursive: true }); await fs.writeFile(path.join(cwd, 'dist', 'index.html'), '<h1>Verified fixture output</h1>'); }
  return { passed: true, exitCode: 0, output: 'fixture: passed' };
}
export async function fixture(options = {}) {
  const parent = path.join(ROOT, '.local-e2e'); await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, '画板测试-'));
  const runner = options.runner ?? new MockRunner();
  const service = new BoardService({ dataDir: directory, runner, previews: options.previews ?? new FakePreviews(), npm: options.npm ?? fakeNpm });
  return { service, runner, directory, async close() { await this.service.close(); if (!within(parent, directory)) throw new Error('Unsafe test cleanup path'); await fs.rm(directory, { recursive: true, force: true }); } };
}
export async function setupProject(service) {
  let project = await service.create({ name: '登录项目' });
  project = service.command(project.id, project.revision, { type: 'target.add', input: { parentId: project.targets[0].id, kind: 'page', label: '登录页' } });
  project = service.command(project.id, project.revision, { type: 'target.add', input: { parentId: project.targets.at(-1).id, kind: 'component', label: '提交按钮' } });
  return project;
}
export async function discussion(service, project, targetId = project.targets.at(-1).id, input = {}) {
  await service.discuss(project.id, project.revision, { targetId, question: '设计这个按钮', parentIds: [], ...input });
  await service.queue;
  return service.get(project.id);
}

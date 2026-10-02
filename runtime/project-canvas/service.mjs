import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { BoardStore } from './store.mjs';
import { id, now, text, find, requireValue, applyCommand, compileContext, projection, BoardError } from './domain.mjs';
import { projectRepository, ensureWorktree, git, checkpoint, runNpm, safeOutputDirectory, within, clearOutput, dependencyFingerprint } from './workspaces.mjs';
import { CodexBoardRunner, buildPrompt, extractCandidates } from './runner.mjs';
import { PreviewManager } from './preview.mjs';

export class BoardService {
  constructor({ dataDir, runner, previews, npm = runNpm }) {
    this.dataDir = path.resolve(dataDir); this.store = new BoardStore(this.dataDir);
    this.runner = runner ?? new CodexBoardRunner(); this.previews = previews ?? new PreviewManager(); this.npm = npm;
    this.queue = Promise.resolve(); this.controls = new Map(); this.closing = false;
    this.recover();
    this.queue = this.reconcilePending();
  }
  recover() {
    for (const item of this.store.list()) {
      const current = this.store.get(item.id);
      if (![...current.runs, ...current.dialogues].some((task) => ['queued', 'running', 'checking', 'waiting'].includes(task.status))) continue;
      this.store.change(item.id, null, (project) => {
      for (const run of project.runs) if (['queued', 'running', 'checking', 'waiting'].includes(run.status)) { run.status = 'interrupted'; run.error = '服务重启，执行结果待核对。不会自动重发。'; run.finishedAt = now(); }
      for (const dialogue of project.dialogues) if (['queued', 'running', 'waiting'].includes(dialogue.status)) { dialogue.status = 'interrupted'; dialogue.error = '服务重启，讨论未完成。'; }
      return project;
      });
    }
  }
  async reconcilePending() {
    for (const item of this.store.list()) for (const run of this.store.get(item.id).runs.filter((entry) => entry.status === 'interrupted')) {
      await this.reconcile(item.id, run.id).catch(() => {});
    }
  }
  async reconcile(projectId, runId) {
    const project = this.store.get(projectId), run = find(project.runs, runId, '执行记录');
    requireValue(run.status === 'interrupted', '只核对中断的开发记录。');
    const pid = run.session?.runtimeProcessId;
    if (pid) { try { process.kill(pid, 0); return this.get(projectId); } catch { /* the original worker has stopped */ } }
    let runtimeStatus = 'unknown';
    if (run.session?.threadId && this.runner.readThread) {
      try {
        const thread = await this.runner.readThread(run.session.threadId);
        const turn = thread.turns?.find((entry) => entry.id === run.turnId);
        runtimeStatus = turn?.status ?? 'unknown';
        if (runtimeStatus === 'inProgress') return this.get(projectId);
      } catch { /* retain unknown as a distinct result */ }
    }
    const workspace = path.join(this.dataDir, 'projects', projectId, 'worktrees', run.branchId);
    const commit = await fs.stat(workspace).then(() => checkpoint(workspace, `Recover interrupted run ${runId}`)).catch(() => null);
    return projection(this.store.change(projectId, null, (p) => {
      const item = find(p.runs, runId); item.reconciledAt = now(); item.recovery = { runtimeStatus, commit };
      item.error = runtimeStatus === 'completed' ? '开发连接已结束，但成果尚未完成构建与验收。现场已保存，可从这里继续。' : '中断现场已核对并保存，不会自动重发；可以从这个代码版本继续。';
      if (commit) { item.commit = commit; find(p.branches, item.branchId).headCommit = commit; }
      return p;
    }));
  }
  list() { return this.store.list(); }
  get(projectId) { return projection(this.store.get(projectId)); }
  context(projectId, targetId, dialogueIds, referenceIds) { return compileContext(this.store.get(projectId), targetId, dialogueIds, referenceIds); }
  command(projectId, revision, command, actor = 'human') { requireValue(Number.isSafeInteger(revision) && revision > 0, '操作需要当前项目版本。'); return projection(this.store.change(projectId, command.type === 'layout.update' ? null : revision, (project) => applyCommand(project, command, actor))); }
  async create(input) {
    const name = text(input.name, '项目名称', 120), projectId = id();
    const repository = await projectRepository(this.dataDir, projectId, input.importPath, input.settings);
    // Internal context files do not belong to code checkpoints.
    await fs.appendFile(path.join(repository.repo, '.git', 'info', 'exclude'), `\n.project-canvas/\n.thoughtdag/\nnode_modules/\n${repository.settings.outputDirectory.replaceAll('\\', '/')}/\n`);
    const project = { id: projectId, name, createdAt: now(), updatedAt: now(), initialCommit: repository.commit, currentBranchId: null, currentArtifactId: null,
      settings: repository.settings,
      targets: [{ id: id(), kind: 'project', parentId: null, label: name, description: '' }],
      requirements: [], dialogues: [], branches: [], runs: [], assets: [], artifacts: [], reviews: [], relations: [], drafts: [],
      layout: { positions: {}, collapsed: [], viewport: { x: 0, y: 0, zoom: 0.8 } } };
    return projection(this.store.create(project));
  }
  async upload(projectId, revision, input) {
    this.store.get(projectId);
    requireValue(Number.isSafeInteger(revision) && revision > 0, '上传需要当前项目版本。');
    const buffer = Buffer.from(String(input.base64 ?? ''), 'base64');
    const formats = { 'image/png': ['png', () => buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))],
      'image/jpeg': ['jpg', () => buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255],
      'image/webp': ['webp', () => buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP'] };
    const format = formats[input.mimeType];
    requireValue(format && buffer.length > 12 && buffer.length <= 20 * 1024 * 1024 && format[1](), '请上传 20MB 以内的 PNG、JPEG 或 WebP 图片。');
    requireValue(Number.isInteger(input.width) && input.width > 0 && input.width <= 30000 && Number.isInteger(input.height) && input.height > 0 && input.height <= 30000, '图片尺寸无效。');
    const asset = { id: id(), name: text(input.name, '图片名称', 200), mimeType: input.mimeType, width: input.width, height: input.height,
      sha256: createHash('sha256').update(buffer).digest('hex'), size: buffer.length, version: 1, createdAt: now(), extension: format[0] };
    const directory = path.join(this.dataDir, 'projects', projectId, 'assets'); await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, `${asset.id}.${asset.extension}`), buffer, { flag: 'wx' });
    return projection(this.store.change(projectId, revision, (project) => { project.assets.push(asset); return project; }));
  }
  assetFile(projectId, assetId) {
    const asset = find(this.store.get(projectId).assets, assetId, '参考图');
    return { asset, file: path.join(this.dataDir, 'projects', projectId, 'assets', `${asset.id}.${asset.extension}`) };
  }
  async materialize(snapshot, projectId, workspace) {
    const copy = structuredClone(snapshot), folder = path.join(workspace, '.project-canvas', 'references');
    requireValue(within(workspace, await fs.realpath(workspace)), '工作目录无效。');
    await fs.mkdir(folder, { recursive: true });
    requireValue(within(workspace, await fs.realpath(folder)), '参考材料目录越出项目范围。');
    const images = [];
    for (const asset of copy.assets) {
      const { file } = this.assetFile(projectId, asset.id);
      const bytes = await fs.readFile(file);
      const destination = path.join(folder, `${asset.id}.${asset.extension}`);
      await fs.writeFile(destination, bytes); asset.contextFile = destination;
      images.push({ type: 'image', data: bytes.toString('base64'), mimeType: asset.mimeType });
    }
    return { snapshot: copy, images };
  }
  enqueue(taskId, task) {
    const control = new AbortController(); this.controls.set(taskId, { control, runtimeRunId: null });
    this.queue = this.queue.catch(() => {}).then(async () => {
      if (this.closing || control.signal.aborted) { this.controls.delete(taskId); return; }
      try { await task(control.signal); } finally { this.controls.delete(taskId); }
    });
  }
  async discuss(projectId, revision, input) {
    requireValue(Number.isSafeInteger(revision) && revision > 0, '讨论需要当前项目版本。');
    const question = text(input.question, '问题'); const dialogueId = input.draftId ?? id();
    const initial = this.store.get(projectId);
    const targetId = input.targetId;
    const parentIds = [...new Set(input.parentIds ?? [])];
    const snapshot = compileContext(initial, targetId, parentIds, input.referenceIds);
    const parent = parentIds.length ? find(initial.dialogues, parentIds.at(-1)) : null;
    const draftSource = input.draftId ? find(initial.dialogues, input.draftId, '对话草稿') : null;
    const branchId = draftSource?.branchId ?? parent?.branchId ?? initial.currentBranchId;
    const branch = branchId ? find(initial.branches, branchId) : null;
    const adopted = initial.currentArtifactId ? find(initial.artifacts, initial.currentArtifactId) : null;
    const baseCommit = draftSource?.baseCommit ?? parent?.baseCommit ?? adopted?.commit ?? branch?.headCommit ?? initial.initialCommit;
    const project = this.store.change(projectId, revision, (p) => {
      const draft = input.draftId ? find(p.dialogues, input.draftId, '对话草稿') : null;
      requireValue(!draft || draft.status === 'draft', '这个对话已发送，请创建新分支。');
      const dialogue = { id: dialogueId, targetId, question, answer: '', status: 'queued', parentIds, referenceIds: snapshot.extraReferenceIds, snapshot, baseCommit, branchId: branch?.id ?? null, createdAt: now() };
      if (draft) Object.assign(draft, dialogue); else p.dialogues.push(dialogue);
      return p;
    });
    this.enqueue(dialogueId, async (signal) => {
      try {
        this.store.change(projectId, null, (p) => { find(p.dialogues, dialogueId).status = 'running'; return p; });
        const workspace = await ensureWorktree(this.dataDir, initial, { id: `read-${baseCommit}`, baseCommit });
        const material = await this.materialize(snapshot, projectId, workspace);
        const result = await this.runner.execute({ cwd: workspace, prompt: buildPrompt(material.snapshot, question, 'discussion'), images: material.images, mode: 'discussion', model: initial.settings.model }, (event) => this.onEvent(projectId, dialogueId, event, true), signal);
        requireValue(!signal.aborted, '讨论已取消。');
        const extracted = extractCandidates(result.text);
        this.store.change(projectId, null, (p) => {
          const dialogue = find(p.dialogues, dialogueId); dialogue.status = 'completed'; dialogue.answer = extracted.answer; dialogue.session = result.session; dialogue.finishedAt = now();
          for (const candidate of extracted.candidates) p = applyCommand(p, { type: 'requirement.propose', input: { targetId, text: candidate.text, sourceDialogueIds: [dialogueId] } }, 'ai');
          return p;
        });
      } catch (error) {
        this.store.change(projectId, null, (p) => { const dialogue = find(p.dialogues, dialogueId); dialogue.status = signal.aborted ? 'cancelled' : 'failed'; dialogue.error = error.message; return p; });
      }
    });
    return projection(project);
  }
  startRun(projectId, revision, input) {
    requireValue(Number.isSafeInteger(revision) && revision > 0, '执行需要当前项目版本。');
    const initial = this.store.get(projectId), dialogue = find(initial.dialogues, input.dialogueId, '来源对话');
    requireValue(dialogue.status === 'completed', '请先完成讨论，再执行开发。');
    const instruction = text(input.instruction || dialogue.question, '开发任务');
    requireValue(!initial.runs.some((run) => run.dialogueId === dialogue.id && ['queued', 'running', 'checking', 'waiting'].includes(run.status)), '这个节点已有开发任务，请等待完成。', 409);
    const runId = id(), branchId = input.branchId ?? id();
    const snapshot = compileContext(initial, dialogue.targetId, [dialogue.id], input.referenceIds);
    requireValue(!input.expectedFingerprint || input.expectedFingerprint === snapshot.fingerprint, '执行前预览之后规范已更新，请重新查看输入。', 409);
    const existing = input.branchId ? find(initial.branches, input.branchId, '方案') : null;
    requireValue(!existing || !initial.runs.some((run) => run.branchId === existing.id && ['queued', 'running', 'checking', 'waiting'].includes(run.status)), '此方案已有开发任务，请等它完成后继续。', 409);
    requireValue(!existing || !initial.runs.some((run) => run.branchId === existing.id && run.status === 'interrupted' && !run.reconciledAt), '此方案的中断现场尚未核对，请先核对或新建独立方案。', 409);
    requireValue(!existing || existing.headCommit === dialogue.baseCommit, '这个历史节点对应旧版本，请创建独立方案。');
    const branch = existing ?? { id: branchId, name: text(input.name || `方案 ${initial.branches.length + 1}`, '方案名称', 120), baseCommit: dialogue.baseCommit, headCommit: dialogue.baseCommit, parentDialogueId: dialogue.id, createdAt: now() };
    const project = this.store.change(projectId, revision, (p) => {
      if (!existing) p.branches.push(branch);
      p.runs.push({ id: runId, dialogueId: dialogue.id, targetId: dialogue.targetId, branchId, instruction, snapshot, baseCommit: branch.headCommit, status: 'queued', output: '', events: [], approvals: [], checks: null, createdAt: now() });
      return p;
    });
    this.enqueue(runId, (signal) => this.executeRun(projectId, runId, signal));
    return projection(project);
  }
  onEvent(projectId, taskId, event, discussion = false) {
    const control = this.controls.get(taskId); if (control) control.runtimeRunId = event.runtimeRunId;
    this.store.change(projectId, null, (p) => {
      const task = find(discussion ? p.dialogues : p.runs, taskId);
      if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
        const key = discussion ? 'answer' : 'output'; task[key] += event.assistantMessageEvent.delta;
      } else if (event.type === 'session') task.session = { threadId: event.sessionId, model: event.model?.id ?? null, runtimeProcessId: event.runtimeProcessId ?? null };
      else if (event.type === 'turn_started') task.turnId = event.turnId;
      else if (event.type === 'question') { task.approvals ??= []; task.approvals.push({ ...event, state: 'pending' }); task.status = 'waiting'; }
      else if (event.type === 'question_answered') { const approval = task.approvals?.find((a) => a.id === event.id); if (approval) approval.state = event.outcome; task.status = 'running'; }
      else if (!discussion && ['tool_execution_start', 'tool_execution_end', 'run_error'].includes(event.type)) {
        task.events.push({ ...event, at: now() }); task.events = task.events.slice(-300);
      }
      return p;
    });
  }
  async executeRun(projectId, runId, signal) {
    let workspace;
    try {
      let project = this.store.get(projectId), run = find(project.runs, runId), branch = find(project.branches, run.branchId);
      this.store.change(projectId, null, (p) => { find(p.runs, runId).status = 'running'; return p; });
      workspace = await ensureWorktree(this.dataDir, project, branch);
      requireValue(await git(workspace, ['rev-parse', 'HEAD']) === run.baseCommit, '方案代码版本已变化，请从最新节点重新执行。', 409);
      const material = await this.materialize(run.snapshot, projectId, workspace);
      const prompt = buildPrompt(material.snapshot, run.instruction, 'implementation');
      this.store.change(projectId, null, (p) => { const item = find(p.runs, runId); item.deliveredContext = material.snapshot; item.prompt = prompt; return p; });
      const result = await this.runner.execute({ cwd: workspace, prompt, images: material.images, mode: 'implementation', model: project.settings.model }, (event) => this.onEvent(projectId, runId, event), signal);
      requireValue(!signal.aborted, '任务已取消。');
      const commit = await checkpoint(workspace, `Canvas run ${runId}`);
      this.store.change(projectId, null, (p) => { find(p.branches, branch.id).headCommit = commit; const item = find(p.runs, runId); item.commit = commit; item.output = result.text; item.session = { ...item.session, ...result.session }; item.status = 'checking'; return p; });
      let install = { passed: true, output: '', exitCode: 0 };
      const dependenciesFile = path.join(workspace, '.project-canvas', 'dependencies.sha256');
      const installedFingerprint = await fs.readFile(dependenciesFile, 'utf8').catch(() => null);
      if (!(await fs.stat(path.join(workspace, 'node_modules')).catch(() => null)) || installedFingerprint !== await dependencyFingerprint(workspace)) {
        install = await this.npm(workspace, ['install', '--no-audit', '--no-fund'], null, signal);
        if (install.passed) await fs.writeFile(dependenciesFile, await dependencyFingerprint(workspace));
      }
      await clearOutput(workspace, project.settings.outputDirectory);
      const build = install.passed ? await this.npm(workspace, ['run', project.settings.buildScript], null, signal) : install;
      const test = build.passed && project.settings.testScript ? await this.npm(workspace, ['run', project.settings.testScript], null, signal) : null;
      const checks = { install, build, test };
      this.store.change(projectId, null, (p) => { find(p.runs, runId).checks = checks; return p; });
      requireValue(build.passed && (!test || test.passed), '构建或测试未通过，请查看检查记录。');
      requireValue(!signal.aborted, '任务已取消。');
      // The dependency lock is part of the reproducible code checkpoint.
      const finalCommit = await checkpoint(workspace, `Record dependencies for ${runId}`);
      const output = await safeOutputDirectory(workspace, project.settings.outputDirectory), artifactId = id();
      const artifactDir = path.join(this.dataDir, 'projects', projectId, 'artifacts', artifactId);
      await fs.mkdir(artifactDir, { recursive: true });
      // Validate before copying: never serve arbitrary external build links.
      const sourcePreview = await this.previews.open(`check-${runId}`, output);
      await fs.cp(output, path.join(artifactDir, 'site'), { recursive: true, dereference: false });
      await this.previews.capture(sourcePreview, path.join(artifactDir, 'screenshot.png'));
      requireValue(!signal.aborted, '任务已取消。');
      const resultDialogueId = id();
      project = this.store.change(projectId, null, (p) => {
        const item = find(p.runs, runId); item.status = 'completed'; item.commit = finalCommit; item.finishedAt = now();
        find(p.branches, branch.id).headCommit = finalCommit;
        p.dialogues.push({ id: resultDialogueId, targetId: item.targetId, question: item.instruction, answer: item.output, status: 'completed', parentIds: [item.dialogueId], snapshot: item.snapshot, baseCommit: finalCommit, branchId: branch.id, createdAt: now(), runId });
        p.artifacts.push({ id: artifactId, targetId: item.targetId, runId, branchId: branch.id, dialogueId: resultDialogueId, commit: finalCommit, checks, createdAt: now() });
        return p;
      });
      return projection(project);
    } catch (error) {
      let commit = null;
      if (workspace) commit = await checkpoint(workspace, `Preserve interrupted run ${runId}`).catch(() => null);
      this.store.change(projectId, null, (p) => { const run = find(p.runs, runId); run.status = signal.aborted ? 'cancelled' : 'failed'; run.error = error.message; run.finishedAt = now(); if (commit) { run.commit = commit; find(p.branches, run.branchId).headCommit = commit; } return p; });
    }
  }
  cancel(projectId, taskId) {
    const project = this.store.get(projectId);
    const task = [...project.runs, ...project.dialogues].find((entry) => entry.id === taskId);
    requireValue(task && ['queued', 'running', 'checking', 'waiting'].includes(task.status), '任务已经结束。');
    this.controls.get(taskId)?.control.abort();
    return projection(this.store.change(projectId, null, (p) => { find([...p.runs, ...p.dialogues], taskId).status = 'cancelled'; return p; }));
  }
  answer(projectId, taskId, requestId, response) {
    const project = this.store.get(projectId), task = find([...project.runs, ...project.dialogues], taskId);
    requireValue(task.approvals?.some((entry) => entry.id === requestId && entry.state === 'pending'), '这个请求已处理。');
    const control = this.controls.get(taskId);
    requireValue(control?.runtimeRunId, '当前执行已断开，请核对状态。', 409);
    requireValue(this.runner.answer(control.runtimeRunId, requestId, response), '开发 Agent 未接受回复。', 409);
    return this.get(projectId);
  }
  async preview(projectId, artifactId) {
    find(this.store.get(projectId).artifacts, artifactId, '成果');
    return { url: await this.previews.open(artifactId, path.join(this.dataDir, 'projects', projectId, 'artifacts', artifactId, 'site')) };
  }
  async export(projectId) {
    const project = this.store.get(projectId), directory = path.join(this.dataDir, 'exports');
    requireValue(!project.runs.some((run) => ['queued', 'running', 'checking', 'waiting'].includes(run.status)), '请等待开发任务结束后导出。');
    await fs.mkdir(directory, { recursive: true });
    const bundle = path.join(directory, `${id()}.bundle`);
    await git(path.join(this.dataDir, 'projects', projectId, 'repository'), ['bundle', 'create', bundle, '--all']);
    const assets = await Promise.all(project.assets.map(async (asset) => ({ id: asset.id, data: (await fs.readFile(this.assetFile(projectId, asset.id).file)).toString('base64') })));
    const screenshots = await Promise.all(project.artifacts.map(async (artifact) => ({ id: artifact.id, data: (await fs.readFile(path.join(this.dataDir, 'projects', projectId, 'artifacts', artifact.id, 'screenshot.png'))).toString('base64') })));
    return gzipSync(Buffer.from(JSON.stringify({ format: 'project-canvas/v1', upstream: 'ThoughtDAG v0.5.9 (MIT)', project, assets, screenshots, codeBundle: (await fs.readFile(bundle)).toString('base64'), environment: { node: process.version, platform: process.platform }, exportedAt: now() })));
  }
  async close() { if (this.closing) return; this.closing = true; for (const { control } of this.controls.values()) control.abort(); this.runner.close(); await this.queue.catch(() => {}); await this.previews.close(); this.store.close(); }
}

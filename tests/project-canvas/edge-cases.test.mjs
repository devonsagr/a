import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture, setupProject, discussion, MockRunner, FakePreviews, fakeNpm, PNG } from './fixtures.mjs';
import { BoardService } from '../../runtime/project-canvas/service.mjs';
import { BoardStore } from '../../runtime/project-canvas/store.mjs';
import { compileContext } from '../../runtime/project-canvas/domain.mjs';
import { ensureWorktree, git } from '../../runtime/project-canvas/workspaces.mjs';

async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(10);
  }
  throw new Error('Expected state was not reached');
}

async function implemented(f, project, input = {}) {
  f.service.startRun(project.id, project.revision, { dialogueId: project.dialogues.at(-1).id, ...input });
  await f.service.queue;
  const updated = f.service.get(project.id);
  assert.equal(updated.runs.at(-1).status, 'completed', updated.runs.at(-1).error);
  return updated;
}

test('rapid duplicate execution is rejected without creating another branch or run', async (t) => {
  const f = await fixture(); t.after(() => f.close());
  let p = await discussion(f.service, await setupProject(f.service));
  const dialogueId = p.dialogues[0].id;
  p = f.service.startRun(p.id, p.revision, { dialogueId });
  const before = { runs: p.runs.length, branches: p.branches.length, revision: p.revision };
  assert.throws(() => f.service.startRun(p.id, p.revision, { dialogueId }), /已有开发任务/);
  const duplicate = f.service.get(p.id);
  assert.deepEqual({ runs: duplicate.runs.length, branches: duplicate.branches.length, revision: duplicate.revision }, before);
  await f.service.queue;
  assert.equal(f.runner.requests.filter((request) => request.mode === 'implementation').length, 1);
});

test('cancelling a queued discussion prevents dispatch and lets its predecessor finish', async (t) => {
  const runner = new MockRunner({ delay: 100 });
  const f = await fixture({ runner }); t.after(() => f.close());
  let p = await setupProject(f.service);
  p = await f.service.discuss(p.id, p.revision, { targetId: p.targets.at(-1).id, question: '先讨论布局', parentIds: [] });
  p = await f.service.discuss(p.id, f.service.get(p.id).revision, { targetId: p.targets.at(-1).id, question: '稍后再讨论颜色', parentIds: [] });
  const cancelled = p.dialogues.at(-1).id;
  f.service.cancel(p.id, cancelled);
  await f.service.queue;
  p = f.service.get(p.id);
  assert.equal(p.dialogues[0].status, 'completed');
  assert.equal(p.dialogues[1].status, 'cancelled');
  assert.equal(runner.requests.length, 1);
  assert.throws(() => f.service.cancel(p.id, cancelled), /已经结束/);
});

test('cancelling active development saves modified files but never creates an artifact', async (t) => {
  const started = Promise.withResolvers();
  const runner = new MockRunner();
  const originalExecute = runner.execute.bind(runner);
  runner.execute = async (request, onEvent, signal) => {
    if (request.mode === 'discussion') return originalExecute(request, onEvent, signal);
    runner.requests.push(request);
    await fs.writeFile(path.join(request.cwd, 'partial.txt'), 'Partially completed work');
    started.resolve();
    return new Promise((resolve, reject) => {
      const stop = () => reject(new Error('cancelled'));
      signal.addEventListener('abort', stop, { once: true });
      if (signal.aborted) stop();
    });
  };
  const f = await fixture({ runner }); t.after(() => f.close());
  let p = await discussion(f.service, await setupProject(f.service));
  p = f.service.startRun(p.id, p.revision, { dialogueId: p.dialogues[0].id });
  const runId = p.runs[0].id;
  await started.promise;
  f.service.cancel(p.id, runId);
  await f.service.queue;
  p = f.service.get(p.id);
  assert.equal(p.runs[0].status, 'cancelled');
  assert.equal(p.artifacts.length, 0);
  assert.ok(p.runs[0].commit);
  const workspace = path.join(f.directory, 'projects', p.id, 'worktrees', p.branches[0].id);
  assert.equal(await git(workspace, ['show', `${p.runs[0].commit}:partial.txt`]), 'Partially completed work');
  assert.equal(await git(workspace, ['status', '--porcelain']), '');
  p = f.service.command(p.id, p.revision, { type: 'dialogue.draft', input: { targetId: p.targets.at(-1).id, fromRunId: runId, question: '继续完成' } });
  assert.equal(p.dialogues.at(-1).baseCommit, p.runs[0].commit);
});

test('cancelling while checking cannot promote an otherwise successful build', async (t) => {
  const building = Promise.withResolvers();
  const npm = async (cwd, args, output, signal) => {
    if (!args.includes('build')) return fakeNpm(cwd, args, output, signal);
    building.resolve();
    await new Promise((resolve) => { signal.addEventListener('abort', resolve, { once: true }); if (signal.aborted) resolve(); });
    return { passed: true, exitCode: 0, output: 'Late build success after cancellation' };
  };
  const f = await fixture({ npm }); t.after(() => f.close());
  let p = await discussion(f.service, await setupProject(f.service));
  p = f.service.startRun(p.id, p.revision, { dialogueId: p.dialogues[0].id });
  await building.promise;
  assert.equal(f.service.get(p.id).runs[0].status, 'checking');
  f.service.cancel(p.id, p.runs[0].id);
  await f.service.queue;
  p = f.service.get(p.id);
  assert.equal(p.runs[0].status, 'cancelled');
  assert.equal(p.artifacts.length, 0);
  assert.equal(p.targets.at(-1).status, 'failed');
});

test('dependency failure records the failed check and skips build, test and preview', async (t) => {
  const commands = [];
  const previews = new FakePreviews();
  previews.open = async () => { assert.fail('Failed dependencies must not open a preview'); };
  const f = await fixture({ previews, npm: async (_cwd, args) => { commands.push(args); return { passed: false, exitCode: 1, output: 'Dependency unavailable' }; } });
  t.after(() => f.close());
  let p = await discussion(f.service, await setupProject(f.service));
  f.service.startRun(p.id, p.revision, { dialogueId: p.dialogues[0].id }); await f.service.queue;
  p = f.service.get(p.id);
  assert.equal(commands.length, 1);
  assert.equal(commands[0][0], 'install');
  assert.equal(p.runs[0].status, 'failed');
  assert.equal(p.runs[0].checks.install.passed, false);
  assert.equal(p.runs[0].checks.test, null);
  assert.equal(p.artifacts.length, 0);
});

test('a second process owner cannot acquire the data directory or remove its lock', async (t) => {
  const f = await fixture(); t.after(() => f.close());
  const lockFile = path.join(f.directory, 'service.lock');
  const owner = await fs.readFile(lockFile, 'utf8');
  assert.throws(() => new BoardStore(f.directory), /已有项目画板服务/);
  assert.equal(await fs.readFile(lockFile, 'utf8'), owner);
  await setupProject(f.service);
  await f.service.close();
  assert.equal(await fs.stat(lockFile).catch(() => null), null);
  f.service = new BoardService({ dataDir: f.directory, runner: new MockRunner(), previews: new FakePreviews(), npm: fakeNpm });
  assert.equal(f.service.list().length, 1);
});

test('failed transactions roll back data and revision; disconnected listeners do not undo commits', async (t) => {
  const f = await fixture(); t.after(() => f.close());
  const p = await setupProject(f.service);
  assert.throws(() => f.service.store.change(p.id, p.revision, (draft) => { draft.name = 'Lost change'; throw new Error('abort transaction'); }), /abort transaction/);
  assert.deepEqual(f.service.store.get(p.id), { ...p, targets: p.targets.map(({ status, ...target }) => target) });
  const events = [];
  f.service.store.subscribe(() => { throw new Error('browser disconnected'); });
  f.service.store.subscribe((event) => events.push(event));
  const updated = f.service.command(p.id, p.revision, { type: 'layout.update', input: { positions: { [p.targets[0].id]: { x: 90, y: 40 } } } });
  assert.equal(updated.revision, p.revision + 1);
  assert.deepEqual(events, [{ projectId: p.id, revision: updated.revision }]);
  const moved = f.service.command(p.id, p.revision, { type: 'layout.update', input: { positions: { [p.targets[1].id]: { x: 100, y: 200 } } } });
  assert.deepEqual(moved.layout.positions[p.targets[0].id], { x: 90, y: 40 });
  assert.deepEqual(moved.layout.positions[p.targets[1].id], { x: 100, y: 200 });
});

test('restart checks the exact interrupted turn and checkpoints its workspace without replaying it', async (t) => {
  const f = await fixture(); t.after(() => f.close());
  let p = await discussion(f.service, await setupProject(f.service));
  p = f.service.startRun(p.id, p.revision, { dialogueId: p.dialogues[0].id });
  f.service.cancel(p.id, p.runs[0].id); await f.service.queue;
  const workspace = await ensureWorktree(f.directory, p, p.branches[0]);
  await fs.writeFile(path.join(workspace, 'recovered.txt'), 'Preserve interrupted work');
  f.service.store.change(p.id, null, (draft) => { Object.assign(draft.runs[0], { status: 'checking', turnId: 'original-turn', session: { threadId: 'saved-thread' } }); return draft; });
  await f.service.close();
  const runner = new MockRunner(), readThreads = [];
  runner.readThread = async (threadId) => { readThreads.push(threadId); return { turns: [{ id: 'original-turn', status: 'completed' }, { id: 'other-turn', status: 'inProgress' }] }; };
  f.service = new BoardService({ dataDir: f.directory, runner, previews: new FakePreviews(), npm: fakeNpm });
  await f.service.queue;
  p = f.service.get(p.id);
  assert.deepEqual(readThreads, ['saved-thread']);
  assert.equal(p.runs[0].status, 'interrupted');
  assert.equal(p.runs[0].recovery.runtimeStatus, 'completed');
  assert.equal(await git(workspace, ['show', `${p.runs[0].commit}:recovered.txt`]), 'Preserve interrupted work');
  assert.equal(p.artifacts.length, 0);
  assert.equal(runner.requests.length, 0);
  const revision = p.revision;
  await f.service.close();
  f.service = new BoardService({ dataDir: f.directory, runner: new MockRunner(), previews: new FakePreviews(), npm: fakeNpm });
  await f.service.queue;
  assert.equal(f.service.get(p.id).runs.length, 1);
  assert.ok(f.service.get(p.id).revision >= revision);
});

test('reconciliation leaves a live worker and an in-progress exact turn untouched', async (t) => {
  const f = await fixture(); t.after(() => f.close());
  let p = await discussion(f.service, await setupProject(f.service));
  p = f.service.startRun(p.id, p.revision, { dialogueId: p.dialogues[0].id });
  f.service.cancel(p.id, p.runs[0].id); await f.service.queue;
  f.service.store.change(p.id, null, (draft) => { Object.assign(draft.runs[0], { status: 'interrupted', turnId: 'active-turn', session: { runtimeProcessId: process.pid, threadId: 'active-thread' } }); return draft; });
  let readCount = 0;
  f.runner.readThread = async () => { readCount++; return { turns: [{ id: 'active-turn', status: 'inProgress' }] }; };
  const before = f.service.get(p.id);
  p = await f.service.reconcile(p.id, p.runs[0].id);
  assert.equal(readCount, 0);
  assert.equal(p.revision, before.revision);
  assert.equal(p.runs[0].reconciledAt, undefined);
  f.service.store.change(p.id, null, (draft) => { delete draft.runs[0].session.runtimeProcessId; return draft; });
  const nextRevision = f.service.get(p.id).revision;
  p = await f.service.reconcile(p.id, p.runs[0].id);
  assert.equal(readCount, 1);
  assert.equal(p.revision, nextRevision);
  assert.equal(p.runs[0].recovery, undefined);
});

test('changing a local rule invalidates only that target while keeping unrelated accepted results', async (t) => {
  const f = await fixture(); t.after(() => f.close());
  let p = await setupProject(f.service), targetId = p.targets.at(-1).id;
  p = f.service.command(p.id, p.revision, { type: 'target.add', input: { parentId: p.targets[1].id, kind: 'component', label: '验证码输入框' } });
  const otherTargetId = p.targets.at(-1).id;
  p = await discussion(f.service, p, targetId);
  p = f.service.command(p.id, p.revision, { type: 'requirement.confirm', input: { id: p.requirements.at(-1).id } });
  const originalRule = p.requirements.at(-1).id;
  p = await implemented(f, p);
  p = f.service.command(p.id, p.revision, { type: 'artifact.review', input: { id: p.artifacts[0].id, result: 'accepted' } });
  p = await discussion(f.service, p, otherTargetId);
  p = await implemented(f, p);
  p = f.service.command(p.id, p.revision, { type: 'artifact.review', input: { id: p.artifacts[1].id, result: 'accepted' } });
  const snapshot = structuredClone(p.runs[0].snapshot);
  const beforeCalls = f.runner.requests.length;
  p = f.service.command(p.id, p.revision, { type: 'requirement.propose', input: { targetId, supersedesId: originalRule, text: '按钮文字为 18px' } });
  assert.ok(p.artifacts.every((artifact) => !artifact.stale));
  p = f.service.command(p.id, p.revision, { type: 'requirement.confirm', input: { id: p.requirements.at(-1).id } });
  assert.deepEqual(p.artifacts.map((artifact) => artifact.stale), [true, false]);
  assert.equal(p.targets.find((target) => target.id === otherTargetId).status, 'accepted');
  assert.deepEqual(p.runs[0].snapshot, snapshot);
  assert.equal(f.runner.requests.length, beforeCalls);
});

test('adopting a historical artifact pins its status and the base for the next discussion', async (t) => {
  const f = await fixture(); t.after(() => f.close());
  let p = await discussion(f.service, await setupProject(f.service));
  p = await implemented(f, p);
  const first = p.artifacts[0];
  p = f.service.command(p.id, p.revision, { type: 'artifact.review', input: { id: first.id, result: 'accepted' } });
  p = await implemented(f, p, { branchId: first.branchId, instruction: 'BLUE_VARIANT' });
  assert.notEqual(p.artifacts[1].commit, first.commit);
  p = f.service.command(p.id, p.revision, { type: 'branch.adopt', input: { id: first.branchId, artifactId: first.id } });
  assert.equal(p.currentArtifactId, first.id);
  assert.equal(p.targets.find((target) => target.id === first.targetId).status, 'accepted');
  p = await discussion(f.service, p, first.targetId, { question: '基于当前采纳版本继续讨论', parentIds: [] });
  assert.equal(p.dialogues.at(-1).baseCommit, first.commit);
  assert.notEqual(p.branches[0].headCommit, first.commit);
});

test('changes requested creates a draft tied to the reviewed version and prevents AI acceptance', async (t) => {
  const f = await fixture(); t.after(() => f.close());
  let p = await discussion(f.service, await setupProject(f.service));
  p = await implemented(f, p);
  const artifact = p.artifacts[0];
  assert.throws(() => f.service.command(p.id, p.revision, { type: 'artifact.review', input: { id: artifact.id, result: 'changes', note: ' ' } }), /说明/);
  for (const command of [
    { type: 'artifact.review', input: { id: artifact.id, result: 'accepted' } },
    { type: 'branch.adopt', input: { id: artifact.branchId } },
  ]) assert.throws(() => f.service.command(p.id, p.revision, command, 'mcp'), /用户/);
  p = f.service.command(p.id, p.revision, { type: 'artifact.review', input: { id: artifact.id, result: 'changes', note: '把按钮文字增大' } });
  const draft = p.dialogues.at(-1);
  assert.equal(draft.status, 'draft');
  assert.equal(draft.question, '把按钮文字增大');
  assert.equal(draft.baseCommit, artifact.commit);
  assert.deepEqual(draft.parentIds, [artifact.dialogueId]);
  assert.equal(p.targets.find((target) => target.id === artifact.targetId).status, 'review');
});

test('context links reject cycles and sent-node edits without leaving partial relations', async (t) => {
  const f = await fixture(); t.after(() => f.close());
  let p = await discussion(f.service, await setupProject(f.service));
  const targetId = p.targets.at(-1).id, sent = p.dialogues[0].id;
  p = f.service.command(p.id, p.revision, { type: 'dialogue.draft', input: { targetId, parentIds: [sent], question: '候选 A' } });
  const a = p.dialogues.at(-1).id;
  p = f.service.command(p.id, p.revision, { type: 'dialogue.draft', input: { targetId, parentIds: [a], question: '候选 B' } });
  const b = p.dialogues.at(-1).id, revision = p.revision;
  assert.throws(() => f.service.command(p.id, p.revision, { type: 'relation.add', input: { source: b, target: a, kind: 'context' } }), /循环/);
  assert.throws(() => f.service.command(p.id, p.revision, { type: 'relation.add', input: { source: a, target: sent, kind: 'context' } }), /冻结/);
  p = f.service.get(p.id);
  assert.equal(p.revision, revision);
  assert.equal(p.relations.length, 0);
  assert.deepEqual(compileContext(p, targetId, [b]).dialogues.map((entry) => entry.id), [sent, a, b]);
});

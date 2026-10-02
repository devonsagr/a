import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { fixture, setupProject, discussion, PNG, MockRunner, FakePreviews, fakeNpm } from './fixtures.mjs';
import { compileContext, applyCommand, validateRegion } from '../../runtime/project-canvas/domain.mjs';
import { BoardService } from '../../runtime/project-canvas/service.mjs';
import { createMcpHandler } from '../../runtime/project-canvas/mcp.mjs';
import { git } from '../../runtime/project-canvas/workspaces.mjs';

test('candidate requirements only affect scoped context after human confirmation', async (t) => {
  const f = await fixture(); t.after(() => f.close());
  let p = await setupProject(f.service), targetId = p.targets.at(-1).id;
  p = f.service.command(p.id, p.revision, { type: 'requirement.propose', input: { targetId, text: '圆角为 12px' } });
  assert.equal(compileContext(p, targetId).requirements.length, 0);
  assert.throws(() => applyCommand(p, { type: 'requirement.confirm', input: { id: p.requirements[0].id } }, 'mcp'), /用户/);
  p = f.service.command(p.id, p.revision, { type: 'requirement.confirm', input: { id: p.requirements[0].id } });
  assert.equal(compileContext(p, targetId).requirements[0].text, '圆角为 12px');
  assert.equal(compileContext(p, p.targets[1].id).requirements.length, 0);
  p = f.service.command(p.id, p.revision, { type: 'requirement.propose', input: { targetId: p.targets[0].id, text: '所有文案使用中文' } });
  p = f.service.command(p.id, p.revision, { type: 'requirement.confirm', input: { id: p.requirements.at(-1).id } });
  assert.equal(compileContext(p, targetId).requirements.length, 2);
});

test('visual references preserve original bytes, normalized region and exclusions', async (t) => {
  const f = await fixture(); t.after(() => f.close());
  let p = await setupProject(f.service), targetId = p.targets.at(-1).id;
  p = await f.service.upload(p.id, p.revision, { name: '按钮参考.png', mimeType: 'image/png', width: 1, height: 1, base64: PNG.toString('base64') });
  const reference = { assetId: p.assets[0].id, region: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 }, purpose: '颜色和圆角', ignore: '文字和背景' };
  p = f.service.command(p.id, p.revision, { type: 'requirement.propose', input: { targetId, text: '采用圈选按钮的样式', references: [reference] } });
  p = f.service.command(p.id, p.revision, { type: 'requirement.confirm', input: { id: p.requirements[0].id } });
  const context = compileContext(p, targetId);
  assert.deepEqual(context.requirements[0].references[0], reference);
  assert.equal(context.assets[0].sha256.length, 64);
  assert.deepEqual(await fs.readFile(f.service.assetFile(p.id, p.assets[0].id).file), PNG);
  assert.throws(() => validateRegion({ x: 0.9, y: 0, width: 0.2, height: 0.5 }), /范围/);
  await assert.rejects(f.service.upload('../escape', 1, { base64: PNG.toString('base64') }), /不存在/);
});

test('merged discussions de-duplicate ancestors and do not follow project reference edges', async (t) => {
  const f = await fixture(); t.after(() => f.close());
  let p = await setupProject(f.service);
  p = await discussion(f.service, p); const root = p.dialogues[0].id;
  p = await discussion(f.service, p, p.targets.at(-1).id, { question: '分支 A', parentIds: [root] }); const a = p.dialogues.at(-1).id;
  p = await discussion(f.service, p, p.targets.at(-1).id, { question: '分支 B', parentIds: [root] }); const b = p.dialogues.at(-1).id;
  const context = compileContext(p, p.targets.at(-1).id, [a, b]);
  assert.deepEqual(context.dialogues.map((entry) => entry.id), [root, a, b]);
  assert.ok(f.runner.requests.every((req) => req.mode === 'discussion'));
  p = f.service.command(p.id, p.revision, { type: 'relation.add', input: { source: p.requirements[0].id, target: a, kind: 'reference' } });
  assert.equal(compileContext(p, p.targets.at(-1).id, [a]).requirements.length, 0);
});

test('independent implementations share the selected historical base and preserve frozen requirements', async (t) => {
  const f = await fixture(); t.after(() => f.close());
  let p = await setupProject(f.service); p = await discussion(f.service, p);
  const dialogueId = p.dialogues[0].id, base = p.dialogues[0].baseCommit;
  p = f.service.command(p.id, p.revision, { type: 'requirement.confirm', input: { id: p.requirements[0].id } });
  f.service.startRun(p.id, p.revision, { dialogueId, name: '暖色方案', instruction: '实现按钮' }); await f.service.queue;
  p = f.service.get(p.id);
  assert.equal(p.runs[0].status, 'completed');
  f.service.startRun(p.id, p.revision, { dialogueId, name: '蓝色方案', instruction: 'BLUE_VARIANT 实现按钮' }); await f.service.queue;
  p = f.service.get(p.id);
  assert.equal(p.artifacts.length, 2); assert.ok(p.branches.every((branch) => branch.baseCommit === base));
  assert.notEqual(p.artifacts[0].commit, p.artifacts[1].commit);
  const roots = p.branches.map((branch) => path.join(f.directory, 'projects', p.id, 'worktrees', branch.id));
  assert.match(await fs.readFile(path.join(roots[0], 'src/main.tsx'), 'utf8'), /#ffb800/);
  assert.match(await fs.readFile(path.join(roots[1], 'src/main.tsx'), 'utf8'), /#2563eb/);
  assert.equal(p.dialogues[0].baseCommit, base);
  p = f.service.command(p.id, p.revision, { type: 'branch.adopt', input: { id: p.branches[0].id } });
  assert.equal(p.currentBranchId, p.branches[0].id);
  assert.equal(f.runner.maxActive, 1);
  assert.equal(await git(roots[0], ['status', '--porcelain']), '');
});

test('requirement updates mark only affected results stale, preserve history, and never rerun automatically', async (t) => {
  const f = await fixture(); t.after(() => f.close());
  let p = await setupProject(f.service); p = await discussion(f.service, p);
  p = f.service.command(p.id, p.revision, { type: 'requirement.confirm', input: { id: p.requirements[0].id } });
  const oldRuleId = p.requirements[0].id;
  f.service.startRun(p.id, p.revision, { dialogueId: p.dialogues[0].id, instruction: '实现按钮' }); await f.service.queue; p = f.service.get(p.id);
  const artifactId = p.artifacts[0].id;
  p = f.service.command(p.id, p.revision, { type: 'artifact.review', input: { id: artifactId, result: 'accepted' } });
  const requests = f.runner.requests.length;
  p = f.service.command(p.id, p.revision, { type: 'requirement.propose', input: { targetId: p.targets.at(-1).id, text: '文字增大到 18px', supersedesId: oldRuleId } });
  assert.equal(p.artifacts[0].stale, false);
  p = f.service.command(p.id, p.revision, { type: 'requirement.confirm', input: { id: p.requirements.at(-1).id } });
  assert.equal(p.artifacts[0].stale, true); assert.equal(p.runs[0].snapshot.requirements[0].id, oldRuleId);
  assert.equal(f.runner.requests.length, requests); assert.equal(p.reviews.length, 1);
  p = f.service.command(p.id, p.revision, { type: 'artifact.review', input: { id: artifactId, result: 'accepted', note: '重新检查通过' } });
  assert.equal(p.artifacts[0].stale, false); assert.equal(p.reviews.length, 2);
});

test('failed builds cannot create accepted artifacts, and preserve a code checkpoint', async (t) => {
  const f = await fixture(); t.after(() => f.close());
  let p = await setupProject(f.service); p = await discussion(f.service, p);
  f.service.startRun(p.id, p.revision, { dialogueId: p.dialogues[0].id, instruction: 'FAIL_BUILD' }); await f.service.queue;
  p = f.service.get(p.id);
  assert.equal(p.runs[0].status, 'failed'); assert.equal(p.runs[0].checks.build.passed, false);
  assert.equal(p.artifacts.length, 0); assert.equal(p.targets.at(-1).status, 'failed'); assert.ok(p.runs[0].commit);
});

test('optimistic revisions and preflight fingerprints reject stale commands', async (t) => {
  const f = await fixture(); t.after(() => f.close());
  let p = await setupProject(f.service); const old = p.revision; p = await discussion(f.service, p);
  assert.throws(() => f.service.command(p.id, old, { type: 'target.add', input: { parentId: p.targets[0].id, kind: 'page', label: '过期操作' } }), /新变更/);
  assert.throws(() => f.service.startRun(p.id, p.revision, { dialogueId: p.dialogues[0].id, expectedFingerprint: 'stale' }), /重新查看/);
});

test('MCP shares the canonical store and cannot confirm requirements or fake artifacts', async (t) => {
  const f = await fixture(); t.after(() => f.close()); const mcp = createMcpHandler(f.service);
  let p = await setupProject(f.service);
  const call = (name, args) => mcp({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  await call('propose_requirement', { projectId: p.id, revision: p.revision, targetId: p.targets[0].id, text: '界面使用中文' });
  p = f.service.get(p.id); assert.equal(p.requirements[0].status, 'candidate');
  const refused = await call('apply_canvas_command', { projectId: p.id, revision: p.revision, command: { type: 'requirement.confirm', input: { id: p.requirements[0].id } } });
  assert.equal(refused.result.isError, true);
  assert.equal((await call('propose_artifact', { projectId: p.id, revision: p.revision, runId: 'fake', commit: 'fake', description: 'done' })).result.isError, true);
  const read = await call('get_project', { projectId: p.id }); assert.equal(JSON.parse(read.result.content[0].text).revision, p.revision);
});

test('restart persists layout and assets, marks unfinished work interrupted and does not dispatch it', async (t) => {
  const f = await fixture(); t.after(() => f.close());
  let p = await setupProject(f.service); p = await discussion(f.service, p);
  p = f.service.command(p.id, p.revision, { type: 'layout.update', input: { positions: { [p.targets[0].id]: { x: 12, y: 34 } }, collapsed: [p.targets[0].id] } });
  f.service.store.change(p.id, null, (doc) => { doc.dialogues[0].status = 'running'; return doc; });
  await f.service.close();
  const runner = new MockRunner(); f.service = new BoardService({ dataDir: f.directory, runner, previews: new FakePreviews(), npm: fakeNpm });
  p = f.service.get(p.id); assert.equal(p.dialogues[0].status, 'interrupted'); assert.equal(runner.requests.length, 0);
  assert.deepEqual(p.layout.positions[p.targets[0].id], { x: 12, y: 34 });
});

test('export contains code bundle, original images, frozen requirements and review history', async (t) => {
  const f = await fixture(); t.after(() => f.close()); let p = await setupProject(f.service);
  p = await f.service.upload(p.id, p.revision, { name: '参考.png', mimeType: 'image/png', width: 1, height: 1, base64: PNG.toString('base64') });
  const exported = JSON.parse(gunzipSync(await f.service.export(p.id)));
  assert.equal(exported.format, 'project-canvas/v1'); assert.equal(exported.assets[0].data, PNG.toString('base64'));
  assert.match(Buffer.from(exported.codeBundle, 'base64').toString('utf8', 0, 100), /git bundle/);
  assert.deepEqual(exported.project.layout, p.layout);
});

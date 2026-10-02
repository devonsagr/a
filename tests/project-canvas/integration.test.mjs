import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { fixture, setupProject, discussion, PNG, ROOT } from './fixtures.mjs';
import { compileContext } from '../../runtime/project-canvas/domain.mjs';
import { boardRouter } from '../../runtime/project-canvas/http.mjs';
import { createMcpHandler } from '../../runtime/project-canvas/mcp.mjs';
import { git, checkpoint, clearOutput, safeOutputDirectory } from '../../runtime/project-canvas/workspaces.mjs';

test('discussion materials remain references, persist through branching, and reach execution unchanged', async (t) => {
  const f = await fixture(); t.after(() => f.close());
  let p = await setupProject(f.service);
  p = await f.service.upload(p.id, p.revision, { name: '讨论参考.png', mimeType: 'image/png', width: 1, height: 1, base64: PNG.toString('base64') });
  const assetId = p.assets[0].id, targetId = p.targets.at(-1).id;
  p = await discussion(f.service, p, targetId, { referenceIds: [assetId] });
  assert.equal(p.dialogues[0].snapshot.assets[0].id, assetId);
  assert.equal(p.dialogues[0].snapshot.requirements.length, 0);
  const parentId = p.dialogues[0].id;
  p = await discussion(f.service, p, targetId, { parentIds: [parentId] });
  assert.deepEqual(p.dialogues[1].referenceIds, [assetId]);
  f.service.startRun(p.id, p.revision, { dialogueId: p.dialogues[1].id }); await f.service.queue;
  p = f.service.get(p.id);
  assert.equal(p.runs[0].status, 'completed');
  assert.equal(p.runs[0].snapshot.requirements.length, 0);
  assert.equal(p.runs[0].deliveredContext.assets[0].sha256, p.assets[0].sha256);
  assert.equal(f.runner.requests.at(-1).images[0].data, PNG.toString('base64'));
  assert.throws(() => compileContext(p, targetId, [], ['missing']), /不存在/);
});

test('MCP edits only drafts and validates cycles before saving', async (t) => {
  const f = await fixture(); t.after(() => f.close());
  let p = await discussion(f.service, await setupProject(f.service));
  const mcp = createMcpHandler(f.service), targetId = p.targets.at(-1).id;
  p = f.service.command(p.id, p.revision, { type: 'dialogue.draft', input: { targetId, question: '草稿', parentIds: [p.dialogues[0].id] } });
  const draftId = p.dialogues.at(-1).id;
  const edit = (input) => mcp({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'apply_canvas_command', arguments: { projectId: p.id, revision: p.revision, command: { type: 'dialogue.edit', input } } } });
  assert.equal((await edit({ id: draftId, question: '更新问题', targetId })).result.isError, undefined);
  p = f.service.get(p.id); assert.equal(p.dialogues.at(-1).question, '更新问题');
  assert.equal((await edit({ id: draftId, question: '循环', parentIds: [draftId] })).result.isError, true);
  assert.equal((await edit({ id: p.dialogues[0].id, question: '改写历史' })).result.isError, true);
  assert.equal(f.service.get(p.id).revision, p.revision);
});

test('an unreconciled interrupted worker cannot be replaced in the same worktree', async (t) => {
  const f = await fixture(); t.after(() => f.close());
  let p = await discussion(f.service, await setupProject(f.service));
  f.service.startRun(p.id, p.revision, { dialogueId: p.dialogues[0].id }); await f.service.queue;
  f.service.store.change(p.id, null, (doc) => { doc.runs[0].status = 'interrupted'; return doc; }); p = f.service.get(p.id);
  assert.throws(() => f.service.startRun(p.id, p.revision, { dialogueId: p.dialogues.at(-1).id, branchId: p.branches[0].id }), /尚未核对/);
  assert.equal(f.service.get(p.id).runs.length, 1);
});

test('import records custom scripts and output while preserving the original repository', async (t) => {
  const f = await fixture(); t.after(() => f.close());
  const seed = await f.service.create({ name: '原项目' });
  const repo = path.join(f.directory, 'projects', seed.id, 'repository');
  const manifestPath = path.join(repo, 'package.json'), manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.scripts = { 'build:prod': 'vite build --outDir build', serve: 'vite preview --outDir build', verify: 'node --version' };
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  const commit = await checkpoint(repo, 'Use custom frontend commands');
  const imported = await f.service.create({ name: '导入项目', importPath: repo, settings: { buildScript: 'build:prod', testScript: 'verify', previewScript: 'serve', outputDirectory: 'build' } });
  assert.equal(imported.initialCommit, commit);
  assert.deepEqual(imported.settings, { buildScript: 'build:prod', testScript: 'verify', previewScript: 'serve', outputDirectory: 'build', model: null });
  assert.equal(await git(repo, ['status', '--porcelain']), '');
  assert.equal(await git(repo, ['rev-parse', 'HEAD']), commit);
  await assert.rejects(f.service.create({ name: '无效目录', importPath: repo, settings: { buildScript: 'build:prod', outputDirectory: '../escape' } }), /相对路径/);
});

test('build checks cannot reuse stale output or remove tracked source files', async (t) => {
  const f = await fixture(); t.after(() => f.close());
  const p = await f.service.create({ name: '输出验证' });
  const workspace = path.join(f.directory, 'projects', p.id, 'repository');
  await fs.mkdir(path.join(workspace, 'dist')); await fs.writeFile(path.join(workspace, 'dist', 'index.html'), 'old build');
  await clearOutput(workspace, 'dist');
  await assert.rejects(safeOutputDirectory(workspace, 'dist'), /静态页面/);
  await assert.rejects(clearOutput(workspace, 'src'), /已提交/);
  assert.ok(await fs.stat(path.join(workspace, 'src', 'main.tsx')));
});

test('HTTP and stdio MCP share one store, broadcast revisions, and reject remote browser origins', async (t) => {
  const f = await fixture();
  const app = express(); app.use(express.json()); app.use('/api/board', boardRouter(f.service));
  const server = await new Promise((resolve) => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await f.close(); });
  const p = await setupProject(f.service);
  const denied = await fetch(`${endpoint}/api/board/projects`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://example.com' }, body: JSON.stringify({ name: 'untrusted' }) });
  assert.equal(denied.status, 403); assert.equal(f.service.list().length, 1);
  const rebinding = await new Promise((resolve, reject) => { http.get(`${endpoint}/api/board/projects`, { headers: { Host: 'example.com' } }, (response) => { response.resume(); resolve(response.statusCode); }).on('error', reject); }); assert.equal(rebinding, 403);
  const controller = new AbortController(), events = await fetch(`${endpoint}/api/board/events`, { signal: controller.signal });
  const reader = events.body.getReader(); await reader.read();
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts/board-mcp.mjs')], { windowsHide: true, env: { ...process.env, PROJECT_CANVAS_URL: endpoint }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { controller.abort(); child.kill(); });
  let output = '', error = '';
  child.stdout.on('data', (data) => { output += data; }); child.stderr.on('data', (data) => { error += data; });
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'propose_requirement', arguments: { projectId: p.id, revision: p.revision, targetId: p.targets[0].id, text: '所有页面使用中文' } } },
  ];
  child.stdin.end(requests.map((request) => JSON.stringify(request)).join('\n') + '\n');
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  assert.equal(code, 0, error);
  const responses = output.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(responses.length, 2); assert.equal(responses[1].result.isError, undefined);
  const event = new TextDecoder().decode((await reader.read()).value); assert.match(event, new RegExp(p.id)); controller.abort();
  const updated = await (await fetch(`${endpoint}/api/board/projects/${p.id}`)).json();
  assert.equal(updated.requirements[0].status, 'candidate'); assert.equal(updated.revision, p.revision + 1);
});

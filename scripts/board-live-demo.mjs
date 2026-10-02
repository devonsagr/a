// Complete the comparison/review demonstration using the successful live-check project.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import express from 'express';
import { chromium } from 'playwright-core';
import { ROOT } from '../tests/project-canvas/fixtures.mjs';
import { BoardService } from '../runtime/project-canvas/service.mjs';
import { boardRouter } from '../runtime/project-canvas/http.mjs';
import { runNpm } from '../runtime/project-canvas/workspaces.mjs';

const evidence = path.join(ROOT, 'output/playwright');
const previous = JSON.parse(await fs.readFile(path.join(evidence, 'live-verification.json'), 'utf8'));
assert.equal(previous.passed, true, 'Run board-live-check.mjs successfully first.');
process.env.PORT = process.env.BOARD_LIVE_PORT || '4318';
const service = new BoardService({ dataDir: previous.dataDir, npm: async (cwd, args, output, signal) => {
  const proxy = process.env.HTTPS_PROXY;
  const extra = args[0] === 'install' && proxy ? [`--proxy=${proxy}`, `--https-proxy=${proxy}`, '--noproxy=localhost,127.0.0.1', '--fetch-retries=1', '--fetch-timeout=30000'] : [];
  return runNpm(cwd, [...args, ...extra], output, signal);
} });
const app = express(); app.use(express.json({ limit: '30mb' })); app.use('/api/board', boardRouter(service)); app.use(express.static(path.join(ROOT, 'dist')));
const server = await new Promise((resolve, reject) => { const listener = app.listen(Number(process.env.PORT), '127.0.0.1'); listener.once('listening', () => resolve(listener)); listener.once('error', reject); });
const read = () => service.get(previous.projectId);
// The test owns build verification. Decline a model's request for wider build access.
const unsubscribe = service.store.subscribe(() => {
  for (const run of read().runs) for (const request of run.approvals.filter((entry) => entry.state === 'pending' && entry.kind === 'confirm' && entry.message.includes('npm run build'))) {
    service.answer(previous.projectId, run.id, request.id, { confirmed: false });
  }
});
let browser;
try {
  let p = read();
  const origin = p.dialogues[0], first = p.artifacts.find((entry) => entry.id === previous.artifactId);
  let other = p.artifacts.find((entry) => entry.id !== first.id);
  if (!other) {
    service.startRun(p.id, p.revision, { dialogueId: origin.id, name: '宽松间距方案', instruction: '实现已确认的静态手机登录页，显示欢迎回来、手机号输入框和继续登录按钮。遵守黄色 #ffb800 按钮与 12px 圆角。本方案使用宽松间距和更宽的表单（最大宽度 480px），与紧凑方案供用户比较。只修改 src/main.tsx 和 src/style.css；保持原有依赖、配置。不要安装、提交、启动服务或添加网络请求。完成后用一句话说明。' });
    console.log('Running the second implementation with the configured default model.');
    await service.queue; p = read();
    assert.equal(p.runs.at(-1).status, 'completed', p.runs.at(-1).error);
    other = p.artifacts.at(-1);
  }
  assert.notEqual(first.commit, other.commit);
  assert.equal(p.branches.find((entry) => entry.id === first.branchId).baseCommit, p.branches.find((entry) => entry.id === other.branchId).baseCommit);
  const systemBrowser = process.env.PROJECT_CANVAS_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
  browser = await chromium.launch({ executablePath: systemBrowser, headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.addInitScript((projectId) => localStorage.setItem('project-canvas.active', projectId), p.id);
  await page.goto(`http://127.0.0.1:${process.env.PORT}`);
  const inspect = async (id) => { const card = page.locator(`.react-flow__node[data-id="${id}"]`); await card.waitFor({ state: 'attached' }); await page.getByRole('button', { name: '查看全部', exact: true }).click(); await page.waitForTimeout(300); await card.click(); };
  await inspect(first.id);
  await page.getByRole('button', { name: '比较方案', exact: true }).click();
  const frames = page.getByRole('dialog').locator('iframe');
  await frames.first().contentFrame().getByRole('heading', { name: '欢迎回来' }).waitFor();
  await frames.last().contentFrame().getByRole('heading', { name: '欢迎回来' }).waitFor();
  await page.screenshot({ path: path.join(evidence, '06-live-compare.png') });
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '记录验收', exact: true }).click();
  await page.getByRole('button', { name: '确认已验收', exact: true }).click();
  await page.getByRole('button', { name: '采纳方案', exact: true }).click();
  const rule = read().requirements.find((entry) => entry.status === 'confirmed');
  await inspect(rule.id); await page.getByRole('button', { name: '提出新版本', exact: true }).click();
  await page.getByLabel('要求内容', { exact: true }).fill(rule.text + ' 提交按钮高度至少 52px。');
  await page.getByRole('button', { name: '保存候选', exact: true }).click();
  await page.waitForTimeout(200);
  await inspect(read().requirements.at(-1).id);
  await page.getByRole('button', { name: '确认生效', exact: true }).click();
  await page.waitForTimeout(250); assert.ok(read().artifacts.every((entry) => entry.stale));
  assert.equal(read().runs.length, 2, 'Updating rules must never automatically run development.');
  await inspect(first.id); await page.screenshot({ path: path.join(evidence, '07-live-review-needed.png') });
  const preview = await service.preview(p.id, first.id), verified = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await verified.goto(preview.url); const button = verified.getByRole('button', { name: '继续登录' });
  assert.ok((await button.boundingBox()).height >= 52);
  assert.equal(await verified.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.getByRole('button', { name: '复核并验收', exact: true }).click();
  await page.getByLabel('验收说明（可选）', { exact: true }).fill('实际页面窄屏无横向溢出，按钮高度符合新要求。');
  await page.getByRole('button', { name: '确认已验收', exact: true }).click();
  await page.waitForTimeout(250); p = read();
  assert.equal(p.artifacts.find((entry) => entry.id === first.id).stale, false);
  assert.equal(p.artifacts.find((entry) => entry.id === other.id).stale, true);
  await fs.writeFile(path.join(evidence, 'live-demo-verification.json'), JSON.stringify({ passed: true, projectId: p.id, dataDir: previous.dataDir, commits: p.artifacts.map((entry) => entry.commit), baseCommits: p.branches.map((entry) => entry.baseCommit), selectedArtifactId: p.currentArtifactId, reviews: p.reviews.length, scenarios: ['real-discussion', 'visual-requirement', 'two-real-implementations', 'real-builds', 'compare-in-UI', 'accept', 'adopt', 'update-rule', 'no-auto-run', 'narrow-screen-recheck'] }, null, 2));
  console.log('PASS: real Windows discussion → visual requirement → two implementations → compare → accept → update → recheck.');
} finally { unsubscribe(); if (browser) await browser.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); await service.close(); }

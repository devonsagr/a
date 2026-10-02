import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { requireValue } from './domain.mjs';
import { within } from './workspaces.mjs';

const require = createRequire(import.meta.url);
async function verifyFiles(root, directory = root) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const item = path.join(directory, entry.name);
    requireValue(!entry.isSymbolicLink(), '构建成果中不能包含指向外部的链接。');
    requireValue(within(root, await fs.realpath(item)), '构建成果超出项目目录。');
    if (entry.isDirectory()) await verifyFiles(root, item);
  }
}
export class PreviewManager {
  constructor() { this.servers = new Map(); this.opening = Promise.resolve(); }
  open(artifactId, directory) {
    const result = this.opening.then(() => this.openSerial(artifactId, directory));
    this.opening = result.catch(() => {});
    return result;
  }
  async openSerial(artifactId, directory) {
    const existing = this.servers.get(artifactId);
    if (existing) { existing.used = Date.now(); return existing.url; }
    await verifyFiles(directory);
    if (this.servers.size >= 2) {
      const [oldId, old] = [...this.servers].sort((a, b) => a[1].used - b[1].used)[0];
      await new Promise((resolve) => old.server.close(resolve)); this.servers.delete(oldId);
    }
    const preview = express();
    preview.use((req, res, next) => { if (!['localhost', '127.0.0.1', '[::1]'].includes(req.hostname)) return res.sendStatus(403); res.set('X-Content-Type-Options', 'nosniff'); next(); });
    preview.use(express.static(directory, { dotfiles: 'deny' }));
    preview.use((_req, res) => res.sendFile('index.html', { root: directory }));
    const server = await new Promise((resolve, reject) => { const listener = preview.listen(0, '127.0.0.1'); listener.once('listening', () => resolve(listener)); listener.once('error', reject); });
    const url = `http://127.0.0.1:${server.address().port}`;
    this.servers.set(artifactId, { server, url, used: Date.now() });
    return url;
  }
  async capture(url, screenshotFile) {
    const { chromium } = require('playwright-core');
    const candidates = [process.env.PROJECT_CANVAS_BROWSER,
      process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : '/usr/bin/chromium',
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome'].filter(Boolean);
    let executablePath;
    for (const candidate of candidates) if (await fs.stat(candidate).catch(() => null)) { executablePath = candidate; break; }
    const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const response = await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
      requireValue(response?.ok(), '预览页面请求失败，不能生成有效成果。');
      requireValue(errors.length === 0, `页面运行出错：${errors[0] || ''}`);
      await page.screenshot({ path: screenshotFile });
    } finally { await browser.close(); }
  }
  async close() { await this.opening; await Promise.all([...this.servers.values()].map(({ server }) => new Promise((resolve) => server.close(resolve)))); this.servers.clear(); }
}

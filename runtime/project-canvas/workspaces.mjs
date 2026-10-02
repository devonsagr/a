import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { BoardError, requireValue } from './domain.mjs';

const exec = promisify(execFile);
export async function git(cwd, args) {
  const result = await exec('git', args, { cwd, windowsHide: true, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' } });
  return result.stdout.trim();
}
export function within(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
export async function projectRepository(dataDir, projectId, importPath, settings = {}) {
  const repo = path.join(dataDir, 'projects', projectId, 'repository');
  await fs.mkdir(path.dirname(repo), { recursive: true });
  if (importPath) {
    requireValue(path.isAbsolute(importPath), '请输入完整项目路径。');
    const real = await fs.realpath(importPath);
    const top = await git(real, ['rev-parse', '--show-toplevel']);
    requireValue(path.resolve(top) === path.resolve(real), '请选择 Git 项目的根目录。');
    requireValue(!(await git(real, ['status', '--porcelain'])), '导入前请保存并提交现有改动，初始代码快照需要完整。');
    await git(path.dirname(repo), ['clone', '--no-hardlinks', '--', real, repo]);
    await git(repo, ['remote', 'remove', 'origin']);
  } else {
    await fs.mkdir(path.join(repo, 'src'), { recursive: true });
    const files = {
      'package.json': JSON.stringify({ name: 'canvas-project', version: '0.0.0', private: true, type: 'module', scripts: { dev: 'vite --host 127.0.0.1', build: 'tsc -b && vite build', preview: 'vite preview --host 127.0.0.1' }, dependencies: { react: '^19.2.0', 'react-dom': '^19.2.0' }, devDependencies: { '@types/react': '^19.2.3', '@types/react-dom': '^19.2.3', '@vitejs/plugin-react': '^5.1.1', typescript: '~5.9.3', vite: '^7.3.1' } }, null, 2),
      '.gitignore': 'node_modules\ndist\n.env\n*.local\n.project-canvas\n',
      'index.html': '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>新项目</title></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>',
      'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2022', lib: ['ES2022', 'DOM'], module: 'ESNext', moduleResolution: 'bundler', jsx: 'react-jsx', strict: true, skipLibCheck: true, noEmit: true }, include: ['src'] }, null, 2),
      'vite.config.ts': "import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\nexport default defineConfig({ plugins: [react()], base: './' });\n",
      'src/main.tsx': "import { createRoot } from 'react-dom/client';\nimport './style.css';\ncreateRoot(document.getElementById('root')!).render(<main><p>新项目</p><h1>从第一个想法开始</h1><button>开始</button></main>);\n",
      'src/style.css': 'body{margin:0;background:#f7f7f8;color:#17202b;font-family:system-ui,sans-serif}main{max-width:760px;margin:15vh auto;padding:40px}p{color:#64748b}h1{font-size:48px}button{background:#17202b;color:white;border:0;padding:14px 26px;cursor:pointer}\n',
    };
    await Promise.all(Object.entries(files).map(([file, contents]) => fs.writeFile(path.join(repo, file), contents)));
    await git(repo, ['init', '-b', 'main']);
    await git(repo, ['-c', 'user.name=Project Canvas', '-c', 'user.email=canvas@localhost', 'add', '.']);
    await git(repo, ['-c', 'user.name=Project Canvas', '-c', 'user.email=canvas@localhost', 'commit', '-m', 'Initialize frontend project']);
  }
  const manifest = JSON.parse(await fs.readFile(path.join(repo, 'package.json'), 'utf8'));
  const buildScript = settings.buildScript || 'build';
  const testScript = settings.testScript === '' ? null : settings.testScript || (manifest.scripts?.test ? 'test' : null);
  const previewScript = settings.previewScript || (manifest.scripts?.preview ? 'preview' : manifest.scripts?.dev ? 'dev' : null);
  for (const script of [buildScript, testScript, previewScript].filter(Boolean)) requireValue(/^[\w][\w:.-]*$/.test(script) && typeof manifest.scripts?.[script] === 'string', `package.json 中找不到脚本：${script}`);
  const outputDirectory = settings.outputDirectory || 'dist';
  outputPath(repo, outputDirectory);
  return { repo, commit: await git(repo, ['rev-parse', 'HEAD']), settings: { buildScript, testScript, previewScript, outputDirectory, model: null } };
}
export async function ensureWorktree(dataDir, project, branch) {
  const workspace = path.join(dataDir, 'projects', project.id, 'worktrees', branch.id);
  const root = path.join(dataDir, 'projects', project.id, 'repository');
  if (await fs.stat(workspace).catch(() => null)) {
    requireValue(within(path.join(dataDir, 'projects', project.id), await fs.realpath(workspace)), '方案目录越出项目范围。');
    return workspace;
  }
  await fs.mkdir(path.dirname(workspace), { recursive: true });
  await git(root, ['worktree', 'add', '-b', `canvas/${branch.id}`, workspace, branch.baseCommit]);
  return workspace;
}
export async function checkpoint(workspace, message) {
  await git(workspace, ['add', '-A']);
  if (await git(workspace, ['diff', '--cached', '--name-only'])) await git(workspace, ['-c', 'user.name=Project Canvas', '-c', 'user.email=canvas@localhost', 'commit', '-m', message]);
  return git(workspace, ['rev-parse', 'HEAD']);
}
export async function runNpm(cwd, args, onOutput, signal, timeoutMs = 240000) {
  // Prefer invoking npm's JS entrypoint: it works with spaces and Unicode paths on Windows.
  const bundledCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const npmCli = process.env.npm_execpath?.endsWith('npm-cli.js') ? process.env.npm_execpath : await fs.stat(bundledCli).then(() => bundledCli).catch(() => null);
  const executable = npmCli?.endsWith('npm-cli.js') ? process.execPath : (process.platform === 'win32' ? 'npm.cmd' : 'npm');
  const commandArgs = npmCli?.endsWith('npm-cli.js') ? [npmCli, ...args] : args;
  return new Promise((resolve, reject) => {
    const child = spawn(executable, commandArgs, { cwd, windowsHide: true, shell: process.platform === 'win32' && executable.endsWith('.cmd'), stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: '1' } });
    let output = '', timedOut = false;
    const receive = (bytes) => { const chunk = bytes.toString(); output = (output + chunk).slice(-100000); onOutput?.(chunk); };
    child.stdout.on('data', receive); child.stderr.on('data', receive);
    const stop = () => {
      if (process.platform === 'win32' && child.pid) execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
      else child.kill('SIGTERM');
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    signal?.addEventListener('abort', stop, { once: true });
    child.on('error', (error) => { clearTimeout(timer); signal?.removeEventListener('abort', stop); reject(error); });
    child.on('exit', (code) => { clearTimeout(timer); signal?.removeEventListener('abort', stop); resolve({ passed: code === 0 && !signal?.aborted && !timedOut, exitCode: code, output: timedOut ? output + '\n命令超时，已停止。' : output }); });
    if (signal?.aborted) stop();
  });
}
export function outputPath(workspace, directory = 'dist') {
  requireValue(typeof directory === 'string' && directory.length > 0 && !path.isAbsolute(directory) && !directory.split(/[\\/]/).some((part) => !part || part === '..' || part.startsWith('.') || part === 'node_modules'), '输出目录必须是项目内的独立相对路径，例如 dist 或 build。');
  const output = path.resolve(workspace, directory);
  requireValue(output !== path.resolve(workspace) && within(workspace, output), '输出目录越出项目范围。');
  return output;
}
export async function clearOutput(workspace, directory = 'dist') {
  const output = outputPath(workspace, directory);
  const real = await fs.realpath(output).catch(() => null);
  if (!real) return;
  requireValue(within(workspace, real) && real !== path.resolve(workspace), '输出目录链接越出项目范围。');
  requireValue(!(await git(workspace, ['ls-files', '--', directory])), '输出目录包含已提交的文件。请将构建输出改到独立、未跟踪的目录。');
  await fs.rm(output, { recursive: true, force: true });
}
export async function dependencyFingerprint(workspace) {
  const files = await Promise.all(['package.json', 'package-lock.json'].map((file) => fs.readFile(path.join(workspace, file)).catch(() => Buffer.alloc(0))));
  return createHash('sha256').update(Buffer.concat(files)).digest('hex');
}
export async function safeOutputDirectory(workspace, directory = 'dist') {
  const output = outputPath(workspace, directory);
  const real = await fs.realpath(output).catch(() => null);
  if (!real || !within(workspace, real)) throw new BoardError(`构建后需要在 ${directory} 目录生成静态页面。`);
  const entry = await fs.realpath(path.join(real, 'index.html')).catch(() => null);
  requireValue(entry && within(real, entry), `成果缺少 ${directory}/index.html。`);
  return real;
}

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const children = [spawn(process.execPath, ['project-server.mjs'], { cwd: root, stdio: 'inherit', windowsHide: true }),
  spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', process.env.VITE_PORT || '5173', '--strictPort'], { cwd: root, stdio: 'inherit', windowsHide: true })];
let closing = false;
function stop(code = 0) { if (closing) return; closing = true; for (const child of children) child.kill(); process.exitCode = code; }
for (const child of children) { child.on('error', (error) => { console.error(error.message); stop(1); }); child.on('exit', (code) => stop(code || 0)); }
process.on('SIGINT', () => stop()); process.on('SIGTERM', () => stop());

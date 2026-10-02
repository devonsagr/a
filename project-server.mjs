import express from 'express';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { BoardService } from './runtime/project-canvas/service.mjs';
import { boardRouter } from './runtime/project-canvas/http.mjs';
import { serverPort, APP_VERSION } from './runtime/project-canvas/config.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.PROJECT_CANVAS_DATA_DIR || path.join(os.homedir(), '.project-canvas');
const service = new BoardService({ dataDir });
const app = express();
app.use(express.json({ limit: '30mb' }));
app.use('/api/board', boardRouter(service));
app.get('/api/health', (_req, res) => res.json({ ready: true, version: APP_VERSION, mode: 'local' }));
app.use(express.static(path.join(root, 'dist')));
app.use((req, res) => { if (req.path.startsWith('/api')) return res.status(404).json({ error: '接口不存在。' }); res.sendFile(path.join(root, 'dist', 'index.html')); });
const port = serverPort();
const server = app.listen(port, '127.0.0.1');
server.on('listening', () => console.log(`项目画板服务：http://127.0.0.1:${port}`));
server.on('error', async (error) => { console.error(`无法启动项目画板 (${error.code})：端口 ${port} 不可用。请设置 PORT 为可用端口。`); await service.close(); process.exitCode = 1; });
let stopping = false;
async function stop() { if (stopping) return; stopping = true; server.close(); await service.close(); process.exit(0); }
process.on('SIGINT', stop); process.on('SIGTERM', stop);

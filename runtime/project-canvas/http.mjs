import express from 'express';
import path from 'node:path';
import { requireValue, BoardError } from './domain.mjs';
import { createMcpHandler } from './mcp.mjs';
import { serverPort } from './config.mjs';

export function boardRouter(service) {
  const router = express.Router();
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!['localhost', '127.0.0.1', '[::1]'].includes(req.hostname)) return res.status(403).json({ error: '只能从本机项目画板访问。' });
    const origin = req.get('Origin');
    if (origin) {
      let url;
      try { url = new URL(origin); } catch { return res.status(403).json({ error: '来源无效。' }); }
      const allowed = new Set([String(serverPort()), String(process.env.VITE_PORT || 5173), String(req.socket.localPort)]);
      if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !allowed.has(url.port)) return res.status(403).json({ error: '只能从本机项目画板访问。' });
    }
    next();
  });
  const route = (handler) => async (req, res, next) => { try { await handler(req, res); } catch (error) { next(error); } };
  router.get('/projects', (_req, res) => res.json(service.list()));
  router.post('/projects', route(async (req, res) => res.status(201).json(await service.create(req.body))));
  router.get('/runtime', route(async (_req, res) => res.json(await service.runner.status())));
  router.get('/projects/:projectId', route(async (req, res) => res.json(service.get(req.params.projectId))));
  router.get('/projects/:projectId/context/:targetId', route(async (req, res) => res.json(service.context(req.params.projectId, req.params.targetId, String(req.query.dialogues ?? '').split(',').filter(Boolean), String(req.query.references ?? '').split(',').filter(Boolean)))));
  router.post('/projects/:projectId/commands', route(async (req, res) => res.json(service.command(req.params.projectId, req.body.revision, req.body.command))));
  router.post('/projects/:projectId/assets', route(async (req, res) => res.json(await service.upload(req.params.projectId, req.body.revision, req.body))));
  router.get('/projects/:projectId/assets/:assetId', route(async (req, res) => { const { asset, file } = service.assetFile(req.params.projectId, req.params.assetId); res.set('Content-Type', asset.mimeType).set('X-Content-Type-Options', 'nosniff').sendFile(path.basename(file), { root: path.dirname(file) }); }));
  router.post('/projects/:projectId/discuss', route(async (req, res) => res.json(await service.discuss(req.params.projectId, req.body.revision, req.body))));
  router.post('/projects/:projectId/runs', route(async (req, res) => res.json(service.startRun(req.params.projectId, req.body.revision, req.body))));
  router.post('/projects/:projectId/tasks/:taskId/cancel', route(async (req, res) => res.json(service.cancel(req.params.projectId, req.params.taskId))));
  router.post('/projects/:projectId/runs/:runId/reconcile', route(async (req, res) => res.json(await service.reconcile(req.params.projectId, req.params.runId))));
  router.post('/projects/:projectId/tasks/:taskId/answer', route(async (req, res) => res.json(service.answer(req.params.projectId, req.params.taskId, req.body.requestId, req.body.response))));
  router.post('/projects/:projectId/artifacts/:artifactId/preview', route(async (req, res) => res.json(await service.preview(req.params.projectId, req.params.artifactId))));
  router.get('/projects/:projectId/artifacts/:artifactId/screenshot', route(async (req, res) => {
    const project = service.get(req.params.projectId); requireValue(project.artifacts.some((entry) => entry.id === req.params.artifactId), '成果不存在。', 404);
    res.type('png').sendFile('screenshot.png', { root: path.join(service.dataDir, 'projects', project.id, 'artifacts', req.params.artifactId) });
  }));
  router.get('/projects/:projectId/export', route(async (req, res) => {
    const data = await service.export(req.params.projectId);
    res.set('Content-Type', 'application/gzip').set('Content-Disposition', `attachment; filename="project-${req.params.projectId}.projectcanvas.gz"`).send(data);
  }));
  router.get('/events', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' }); res.write(': connected\n\n');
    const unsubscribe = service.store.subscribe((event) => res.write(`data: ${JSON.stringify(event)}\n\n`));
    const timer = setInterval(() => res.write(': heartbeat\n\n'), 20000);
    req.on('close', () => { clearInterval(timer); unsubscribe(); });
  });
  const mcp = createMcpHandler(service);
  router.post('/mcp', route(async (req, res) => { const response = await mcp(req.body); if (response) res.json(response); else res.status(204).end(); }));
  router.use((error, _req, res, _next) => {
    res.status(error instanceof BoardError ? error.status : 500).json({ error: error.message ?? '项目服务出错。' });
  });
  return router;
}

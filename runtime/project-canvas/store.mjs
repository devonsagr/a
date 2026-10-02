import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BoardError, now } from './domain.mjs';

export class BoardStore {
  constructor(dataDir) {
    this.dataDir = path.resolve(dataDir);
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.lockPath = path.join(this.dataDir, 'service.lock'); this.lockId = randomUUID();
    if (fs.existsSync(this.lockPath)) {
      let previous;
      try { previous = JSON.parse(fs.readFileSync(this.lockPath, 'utf8')); } catch { throw new BoardError('数据目录锁无效，请检查是否还有服务在运行。', 409); }
      let alive = true;
      try { process.kill(previous.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
      if (alive) throw new BoardError('这个数据目录已有项目画板服务在使用。', 409);
      fs.unlinkSync(this.lockPath);
    }
    fs.writeFileSync(this.lockPath, JSON.stringify({ pid: process.pid, id: this.lockId }), { flag: 'wx' });
    this.db = new DatabaseSync(path.join(this.dataDir, 'board.sqlite'));
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, document TEXT NOT NULL);');
    this.listeners = new Set();
  }
  list() { return this.db.prepare('SELECT document, revision FROM projects').all().map((row) => { const p = JSON.parse(row.document); return { id: p.id, name: p.name, revision: row.revision, updatedAt: p.updatedAt }; }); }
  get(projectId) {
    const row = this.db.prepare('SELECT document, revision FROM projects WHERE id=?').get(projectId);
    if (!row) throw new BoardError('项目不存在。', 404);
    return { ...JSON.parse(row.document), revision: row.revision };
  }
  create(document) {
    this.db.prepare('INSERT INTO projects VALUES (?, 1, ?)').run(document.id, JSON.stringify(document));
    this.publish(document.id, 1);
    return this.get(document.id);
  }
  change(projectId, expectedRevision, mutate) {
    this.db.exec('BEGIN IMMEDIATE');
    let revision;
    try {
      const current = this.get(projectId);
      if (expectedRevision != null && current.revision !== expectedRevision) throw new BoardError('项目已有新变更，已刷新，请检查后重试。', 409);
      const next = mutate(structuredClone(current)) ?? current;
      revision = current.revision + 1;
      next.updatedAt = now(); delete next.revision;
      this.db.prepare('UPDATE projects SET document=?, revision=? WHERE id=?').run(JSON.stringify(next), revision, projectId);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    this.publish(projectId, revision);
    return this.get(projectId);
  }
  publish(projectId, revision) { for (const listener of this.listeners) { try { listener({ projectId, revision }); } catch { /* a disconnected browser is not a failed transaction */ } } }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  close() {
    this.listeners.clear(); this.db.close();
    if (fs.existsSync(this.lockPath) && JSON.parse(fs.readFileSync(this.lockPath, 'utf8')).id === this.lockId) fs.unlinkSync(this.lockPath);
  }
}

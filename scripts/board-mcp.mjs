#!/usr/bin/env node
import readline from 'node:readline';

const endpoint = process.env.PROJECT_CANVAS_URL || 'http://127.0.0.1:4317';
const url = new URL(endpoint);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('The local bridge requires a loopback Project Canvas URL.');
const input = readline.createInterface({ input: process.stdin });
let pending = Promise.resolve();
for await (const line of input) {
  if (!line.trim()) continue;
  pending = pending.then(async () => {
    let request;
    try {
      request = JSON.parse(line);
      const response = await fetch(new URL('/api/board/mcp', url), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal: AbortSignal.timeout(30000) });
      if (response.status === 204) return;
      if (!response.ok) throw new Error(`Project Canvas HTTP ${response.status}`);
      process.stdout.write(JSON.stringify(await response.json()) + '\n');
    } catch (error) {
      if (request?.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: error.message } }) + '\n');
      else process.stderr.write(error.message + '\n');
    }
  });
}
await pending;

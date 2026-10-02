import fs from 'node:fs/promises';
import { requireValue, text, find, id, now } from './domain.mjs';
import { APP_VERSION } from './config.mjs';

const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const str = { type: 'string' };
export const BOARD_TOOLS = [
  { name: 'list_projects', description: 'List locally managed projects.', inputSchema: schema({}) },
  { name: 'get_project', description: 'Read the canonical canvas, requirements, branches, runs and reviews.', inputSchema: schema({ projectId: str }, ['projectId']) },
  { name: 'get_context', description: 'Get confirmed requirements, selected dialogue ancestry and reference image regions for a target.', inputSchema: schema({ projectId: str, targetId: str, dialogueIds: { type: 'array', items: str }, referenceIds: { type: 'array', items: str } }, ['projectId', 'targetId']) },
  { name: 'read_asset', description: 'Read the original reference image. Regions and intended uses are in get_context.', inputSchema: schema({ projectId: str, assetId: str }, ['projectId', 'assetId']) },
  { name: 'apply_canvas_command', description: 'Create draft dialogues/targets, reference relations or layout changes. Formal confirmation, adoption, execution and acceptance are human actions.', inputSchema: schema({ projectId: str, revision: { type: 'integer' }, command: { type: 'object' } }, ['projectId', 'revision', 'command']) },
  { name: 'propose_requirement', description: 'Submit a candidate requirement, optionally with scoped image references. It does not become effective until a user confirms it.', inputSchema: schema({ projectId: str, revision: { type: 'integer' }, targetId: str, text: str, sourceDialogueIds: { type: 'array', items: str }, supersedesId: str, references: { type: 'array', items: { type: 'object' } } }, ['projectId', 'revision', 'targetId', 'text']) },
  { name: 'propose_artifact', description: 'Propose a result by referencing its real completed run and code commit. The server verifies the reference; this never marks a result accepted.', inputSchema: schema({ projectId: str, revision: { type: 'integer' }, runId: str, commit: str, description: str }, ['projectId', 'revision', 'runId', 'commit', 'description']) },
];
const textContent = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
export function createMcpHandler(service) {
  return async (request) => {
    const result = (value) => ({ jsonrpc: '2.0', id: request.id, result: value });
    if (request.id === undefined) return null;
    try {
      if (request.method === 'initialize') return result({ protocolVersion: request.params?.protocolVersion || '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'project-canvas', version: APP_VERSION } });
      if (request.method === 'ping') return result({});
      if (request.method === 'tools/list') return result({ tools: BOARD_TOOLS });
      requireValue(request.method === 'tools/call', 'Unsupported MCP method.');
      const { name, arguments: args = {} } = request.params ?? {};
      switch (name) {
        case 'list_projects': return result(textContent(service.list()));
        case 'get_project': return result(textContent(service.get(args.projectId)));
        case 'get_context': return result(textContent(service.context(args.projectId, args.targetId, args.dialogueIds ?? [], args.referenceIds ?? [])));
        case 'read_asset': {
          const { asset, file } = service.assetFile(args.projectId, args.assetId);
          return result({ content: [{ type: 'text', text: JSON.stringify(asset) }, { type: 'image', mimeType: asset.mimeType, data: (await fs.readFile(file)).toString('base64') }] });
        }
        case 'apply_canvas_command': {
          requireValue(['target.add', 'dialogue.draft', 'dialogue.edit', 'requirement.edit', 'layout.update', 'relation.add'].includes(args.command?.type), 'This operation is not available to an AI client.');
          return result(textContent(service.command(args.projectId, args.revision, args.command, 'mcp')));
        }
        case 'propose_requirement': return result(textContent(service.command(args.projectId, args.revision, { type: 'requirement.propose', input: args }, 'mcp')));
        case 'propose_artifact': {
          const project = service.store.get(args.projectId), run = find(project.runs, args.runId, '执行记录');
          requireValue(run.status === 'completed' && run.commit === args.commit && run.checks?.build?.passed, '必须引用构建通过的真实执行与代码提交。');
          const updated = service.store.change(args.projectId, args.revision, (p) => { p.drafts.push({ id: id(), kind: 'artifact-proposal', runId: run.id, commit: run.commit, description: text(args.description, '成果说明'), createdAt: now() }); return p; });
          return result(textContent(updated));
        }
        default: throw new Error('Unknown tool.');
      }
    } catch (error) {
      if (request.method === 'tools/call') return result({ isError: true, content: [{ type: 'text', text: error.message }] });
      return { jsonrpc: '2.0', id: request.id, error: { code: -32601, message: error.message } };
    }
  };
}

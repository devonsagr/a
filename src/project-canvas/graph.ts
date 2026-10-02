import type { Node, Edge } from '@xyflow/react';
import { autoLayout } from '../lib/layout';
import type { ThoughtNode, ThoughtEdge } from '../types';
import type { Project, BoardSelection } from './types';
import { screenshotUrl, assetUrl } from './store';

export interface CardData extends Record<string, unknown> { kind: BoardSelection['kind']; title: string; body: string; status?: string; image?: string; detail?: string }
export type CardNode = Node<CardData, 'card'>;
export const LABELS: Record<string, string> = { pending: '待开发', running: '执行中', checking: '正在检查', queued: '排队中', waiting: '等待回复', accepted: '已验收', review: '待验收', stale: '需复核', failed: '执行失败', interrupted: '待核对', cancelled: '已取消', draft: '草稿', completed: '已完成', candidate: '候选要求', confirmed: '正式要求', superseded: '历史要求', rejected: '未采纳' };
export const KIND_LABELS = { target: '项目对象', dialogue: '对话', requirement: '要求', asset: '参考图', run: '开发记录', artifact: '页面成果' };

export function projectGraph(project: Project): { nodes: CardNode[]; edges: Edge[] } {
  const nodes: CardNode[] = [], edges: Edge[] = [];
  const columnCounts = new Map<number, number>();
  const add = (id: string, column: number, data: CardData) => {
    const row = columnCounts.get(column) ?? 0; columnCounts.set(column, row + 1);
    nodes.push({ id, type: 'card', position: project.layout.positions[id] ?? { x: column * 340, y: row * 270 }, data });
  };
  const link = (source: string, target: string, kind: string, label?: string) => edges.push({ id: `${kind}:${source}:${target}`, source, target, label, type: 'smoothstep', style: { stroke: kind === 'context' ? '#ffb800' : '#66685e', strokeWidth: 1.4, ...(kind !== 'context' ? { strokeDasharray: '5 4' } : {}) }, labelStyle: { fill: '#aaa99d', fontSize: 11 } });
  const hiddenTargets = new Set<string>();
  for (const collapsedId of project.layout.collapsed) {
    const hide = (parentId: string) => { for (const target of project.targets.filter((entry) => entry.parentId === parentId)) { hiddenTargets.add(target.id); hide(target.id); } }; hide(collapsedId);
  }
  const visible = (targetId: string) => !hiddenTargets.has(targetId);
  for (const target of project.targets) if (visible(target.id)) {
    add(target.id, 0, { kind: 'target', title: target.label, body: target.description || (target.kind === 'project' ? '页面、局部对象和项目要求都从这里组织。' : target.kind === 'page' ? '关联页面的讨论、视觉要求和成果。' : '把细节要求关联到这个具体对象。'), status: target.status, detail: project.layout.collapsed.includes(target.id) ? '已折叠' : target.kind === 'component' ? '局部对象' : target.kind === 'page' ? '页面' : '项目' });
    if (target.parentId) link(target.parentId, target.id, 'hierarchy');
  }
  for (const rule of project.requirements) if (visible(rule.targetId) && rule.status !== 'rejected' && rule.status !== 'superseded') {
    add(rule.id, 1, { kind: 'requirement', title: rule.text.slice(0, 48), body: rule.text, status: rule.status, detail: `版本 ${rule.version}` }); link(rule.id, rule.targetId, 'applies', '适用于');
    for (const reference of rule.references) link(reference.assetId, rule.id, 'reference', '参考');
    for (const source of rule.sourceDialogueIds) link(source, rule.id, 'source', '提出');
  }
  for (const asset of project.assets) add(asset.id, 1, { kind: 'asset', title: asset.name, body: '原图和圈选用途会随要求一起保留。', image: assetUrl(project.id, asset.id), detail: `${asset.width} × ${asset.height}` });
  for (const dialogue of project.dialogues) if (visible(dialogue.targetId)) {
    add(dialogue.id, 2, { kind: 'dialogue', title: dialogue.question || '未发送的讨论', body: dialogue.answer || dialogue.error || '在右侧继续输入问题。', status: dialogue.status, detail: dialogue.parentIds.length > 1 ? `${dialogue.parentIds.length} 条对话汇合` : '上下文可查看' });
    for (const parent of dialogue.parentIds) link(parent, dialogue.id, 'context');
    if (!dialogue.parentIds.length) link(dialogue.targetId, dialogue.id, 'object');
  }
  for (const run of project.runs) if (visible(run.targetId)) { add(run.id, 3, { kind: 'run', title: project.branches.find((entry) => entry.id === run.branchId)?.name || '开发任务', body: run.error || run.output || run.instruction, status: run.status, detail: run.commit ? `代码 ${run.commit.slice(0, 7)}` : '已冻结执行上下文' }); link(run.dialogueId, run.id, 'execution', '执行'); }
  for (const artifact of project.artifacts) if (visible(artifact.targetId)) {
    const review = project.reviews.filter((entry) => entry.artifactId === artifact.id).at(-1);
    add(artifact.id, 4, { kind: 'artifact', title: project.branches.find((entry) => entry.id === artifact.branchId)?.name || '页面成果', body: review?.note || '打开页面预览，对照规范验收。', status: artifact.stale ? 'stale' : review?.result === 'accepted' ? 'accepted' : 'review', image: screenshotUrl(project.id, artifact.id), detail: project.currentArtifactId === artifact.id ? '当前采用方案' : '独立方案' }); link(artifact.runId, artifact.id, 'produces', '产出');
  }
  for (const relation of project.relations) link(relation.source, relation.target, relation.kind, ({ applies: '适用于', produces: '产出', supersedes: '替代', reviews: '验收', reference: '参考' } as Record<string, string>)[relation.kind]);
  const ids = new Set(nodes.map((node) => node.id));
  const unique = new Map(edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)).map((edge) => [edge.id, edge]));
  return { nodes, edges: [...unique.values()] };
}

export function tidyPositions(nodes: CardNode[], edges: Edge[]) {
  const thoughts = nodes.map((node) => ({ ...node, type: 'thought', measured: { width: 288, height: 220 }, data: { question: node.data.title, response: '', isCollapsed: true, attachments: [], highlights: [], isBranch: false } })) as unknown as ThoughtNode[];
  // The layout sees only causal directions, not arbitrary project relations.
  const layoutEdges = edges.filter((edge) => edge.id.startsWith('context:') || edge.id.startsWith('hierarchy:') || edge.id.startsWith('execution:') || edge.id.startsWith('produces:')) as ThoughtEdge[];
  return Object.fromEntries(autoLayout(thoughts, layoutEdges).map((node) => [node.id, node.position]));
}

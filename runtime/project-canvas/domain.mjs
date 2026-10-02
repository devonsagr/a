import { randomUUID, createHash } from 'node:crypto';

export const id = () => randomUUID();
export const now = () => new Date().toISOString();
export class BoardError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export function requireValue(condition, message, status = 400) {
  if (!condition) throw new BoardError(message, status);
}
export function text(value, name, limit = 30000) {
  requireValue(typeof value === 'string' && value.trim().length > 0 && value.length <= limit, `${name}不能为空，且不能超过 ${limit} 字。`);
  return value.trim();
}
export function find(items, itemId, label = '记录') {
  const item = items.find((entry) => entry.id === itemId);
  requireValue(item, `${label}不存在。`, 404);
  return item;
}
export function ancestors(project, targetId) {
  const out = [];
  const seen = new Set();
  let target = find(project.targets, targetId, '项目对象');
  while (target) {
    requireValue(!seen.has(target.id), '对象层级存在循环。');
    seen.add(target.id); out.unshift(target);
    target = target.parentId ? find(project.targets, target.parentId, '上级对象') : null;
  }
  return out;
}
export function validateRegion(region) {
  if (!region) return null;
  const { x, y, width, height } = region;
  requireValue([x, y, width, height].every((v) => typeof v === 'number' && Number.isFinite(v)), '区域坐标无效。');
  requireValue(x >= 0 && y >= 0 && width > 0 && height > 0 && x + width <= 1.000001 && y + height <= 1.000001, '圈选区域必须在原图范围内。');
  return { x, y, width, height };
}
export function effectiveRequirements(project, targetId) {
  const scope = new Set(ancestors(project, targetId).map((target) => target.id));
  return project.requirements.filter((rule) => rule.status === 'confirmed' && scope.has(rule.targetId));
}
export function dialogueContext(project, selectedIds = []) {
  const done = new Set(), visiting = new Set(), out = [];
  const visit = (dialogueId) => {
    if (done.has(dialogueId)) return;
    requireValue(!visiting.has(dialogueId), '对话上下文不能形成循环。');
    const dialogue = find(project.dialogues, dialogueId, '对话');
    visiting.add(dialogueId);
    for (const parent of dialogue.parentIds) visit(parent);
    visiting.delete(dialogueId); done.add(dialogueId);
    out.push({ id: dialogue.id, question: dialogue.question, answer: dialogue.answer, status: dialogue.status });
  };
  for (const selectedId of selectedIds) visit(selectedId);
  return out;
}
export function fingerprint(requirements) {
  return createHash('sha256').update(JSON.stringify(requirements.map((rule) => ({
    id: rule.id, requirementId: rule.requirementId, targetId: rule.targetId, text: rule.text, references: rule.references,
  })).sort((a, b) => a.id.localeCompare(b.id)))).digest('hex');
}
export function compileContext(project, targetId, selectedIds = [], referenceIds = []) {
  const targets = ancestors(project, targetId);
  const requirements = structuredClone(effectiveRequirements(project, targetId));
  const dialogues = dialogueContext(project, selectedIds);
  const extraReferenceIds = [...new Set([...referenceIds, ...dialogues.flatMap((dialogue) => find(project.dialogues, dialogue.id).referenceIds ?? [])])];
  for (const assetId of extraReferenceIds) find(project.assets, assetId, '参考材料');
  const assetIds = new Set([...extraReferenceIds, ...requirements.flatMap((rule) => rule.references.map((ref) => ref.assetId))]);
  const assets = project.assets.filter((asset) => assetIds.has(asset.id)).map((asset) => structuredClone(asset));
  return { projectId: project.id, targetId, targets, requirements, dialogues, assets, extraReferenceIds, fingerprint: fingerprint(requirements), capturedAt: now() };
}
export function isArtifactStale(project, artifact) {
  const review = [...project.reviews].reverse().find((entry) => entry.artifactId === artifact.id && entry.result === 'accepted');
  const original = find(project.runs, artifact.runId, '执行记录').snapshot.fingerprint;
  return (review?.fingerprint ?? original) !== fingerprint(effectiveRequirements(project, artifact.targetId));
}
export function targetStatus(project, targetId) {
  if (project.runs.some((run) => run.targetId === targetId && ['queued', 'running', 'checking', 'waiting'].includes(run.status))) return 'running';
  const branchId = project.currentBranchId;
  const artifacts = project.artifacts.filter((artifact) => artifact.targetId === targetId && (!branchId || artifact.branchId === branchId));
  const adopted = project.artifacts.find((artifact) => artifact.id === project.currentArtifactId && artifact.targetId === targetId);
  const artifact = adopted ?? artifacts.at(-1);
  const latestRun = project.runs.filter((run) => run.targetId === targetId && (!branchId || run.branchId === branchId)).at(-1);
  if (!adopted && latestRun && ['failed', 'cancelled', 'interrupted'].includes(latestRun.status) && (!artifact || latestRun.id !== artifact.runId && latestRun.createdAt >= artifact.createdAt)) return 'failed';
  if (artifact) {
    if (isArtifactStale(project, artifact)) return 'stale';
    const review = project.reviews.filter((entry) => entry.artifactId === artifact.id).at(-1);
    return review?.result === 'accepted' ? 'accepted' : 'review';
  }
  const run = project.runs.filter((entry) => entry.targetId === targetId).at(-1);
  return run && ['failed', 'cancelled', 'interrupted'].includes(run.status) ? 'failed' : 'pending';
}
export function projection(project) {
  return { ...project,
    targets: project.targets.map((target) => ({ ...target, status: targetStatus(project, target.id) })),
    artifacts: project.artifacts.map((artifact) => ({ ...artifact, stale: isArtifactStale(project, artifact) })),
  };
}
export function applyCommand(project, command, actor = 'human') {
  const p = structuredClone(project);
  const input = command.input ?? {};
  const human = () => requireValue(actor === 'human', '此操作需要用户在画布中确认。', 403);
  switch (command.type) {
    case 'dialogue.edit': {
      const dialogue = find(p.dialogues, input.id, '对话草稿');
      requireValue(dialogue.status === 'draft', '只能修改尚未发送的对话草稿。');
      dialogue.question = text(input.question, '问题');
      if (input.targetId) { find(p.targets, input.targetId, '项目对象'); dialogue.targetId = input.targetId; }
      if (input.parentIds) { dialogue.parentIds = [...new Set(input.parentIds)]; dialogueContext(p, [dialogue.id]); }
      break;
    }
    case 'target.add': {
      const parent = find(p.targets, input.parentId, '上级对象');
      requireValue(['page', 'component'].includes(input.kind), '请选择页面或局部对象。');
      p.targets.push({ id: id(), parentId: parent.id, kind: input.kind, label: text(input.label, '对象名称', 120), description: input.description ?? '' });
      break;
    }
    case 'requirement.propose': {
      find(p.targets, input.targetId, '项目对象');
      const previous = input.supersedesId ? find(p.requirements, input.supersedesId, '旧规范') : null;
      requireValue(!previous || previous.status === 'confirmed', '只能为当前有效规范提出新版本。');
      const references = (input.references ?? []).map((ref) => {
        find(p.assets, ref.assetId, '参考图');
        return { assetId: ref.assetId, region: validateRegion(ref.region), purpose: text(ref.purpose, '参考用途', 3000), ignore: String(ref.ignore ?? '').slice(0, 3000) };
      });
      const sourceDialogueIds = [...new Set(input.sourceDialogueIds ?? [])];
      for (const sourceId of sourceDialogueIds) find(p.dialogues, sourceId, '来源对话');
      p.requirements.push({ id: id(), requirementId: previous?.requirementId ?? id(), version: previous ? previous.version + 1 : 1,
        targetId: input.targetId, text: text(input.text, '要求内容'), status: 'candidate', references, sourceDialogueIds,
        supersedesId: previous?.id ?? null, actor, createdAt: now() });
      break;
    }
    case 'requirement.confirm': {
      human(); const rule = find(p.requirements, input.id, '候选要求');
      requireValue(rule.status === 'candidate', '此要求已处理，请刷新后查看。', 409);
      if (rule.supersedesId) {
        const previous = find(p.requirements, rule.supersedesId, '旧规范');
        requireValue(previous.status === 'confirmed', '旧规范已经更新，请重新提出候选。', 409);
        previous.status = 'superseded';
      }
      rule.status = 'confirmed'; rule.confirmedAt = now(); break;
    }
    case 'requirement.edit': {
      const rule = find(p.requirements, input.id, '候选要求');
      requireValue(rule.status === 'candidate', '正式要求已经冻结，请提出新版本。');
      find(p.targets, input.targetId, '项目对象');
      rule.text = text(input.text, '要求内容'); rule.targetId = input.targetId;
      break;
    }
    case 'requirement.reject': {
      human(); const rule = find(p.requirements, input.id, '候选要求');
      requireValue(rule.status === 'candidate', '正式要求不能直接删除，请提出新版本。');
      rule.status = 'rejected'; break;
    }
    case 'branch.adopt': {
      human(); const branch = find(p.branches, input.id, '方案');
      const artifact = input.artifactId ? find(p.artifacts, input.artifactId, '成果') : p.artifacts.filter((entry) => entry.branchId === branch.id).at(-1);
      requireValue(artifact?.branchId === branch.id && artifact.checks.build.passed, '方案需要先有构建成功的成果。');
      p.currentBranchId = branch.id; p.currentArtifactId = artifact.id; break;
    }
    case 'artifact.review': {
      human(); const artifact = find(p.artifacts, input.id, '成果');
      requireValue(['accepted', 'changes'].includes(input.result), '验收结果无效。');
      requireValue(artifact.checks.build.passed && find(p.runs, artifact.runId).status === 'completed', '执行或构建未成功，不能验收。');
      requireValue(!input.expectedFingerprint || input.expectedFingerprint === fingerprint(effectiveRequirements(p, artifact.targetId)), '验收期间规范已更新，请重新查看当前要求。', 409);
      const note = String(input.note ?? '').slice(0, 30000);
      requireValue(input.result !== 'changes' || note.trim(), '请说明需要修改的地方。');
      p.reviews.push({ id: id(), artifactId: artifact.id, result: input.result, note, fingerprint: fingerprint(effectiveRequirements(p, artifact.targetId)), requirementIds: effectiveRequirements(p, artifact.targetId).map((rule) => rule.id), createdAt: now() });
      if (input.result === 'changes') p.dialogues.push({ id: id(), targetId: artifact.targetId, question: note, answer: '', status: 'draft', parentIds: [artifact.dialogueId].filter(Boolean), baseCommit: artifact.commit, branchId: artifact.branchId, createdAt: now() });
      break;
    }
    case 'layout.update': {
      const validIds = new Set([...p.targets, ...p.dialogues, ...p.requirements, ...p.assets, ...p.artifacts, ...p.runs].map((entry) => entry.id));
      for (const [nodeId, position] of Object.entries(input.positions ?? {})) {
        requireValue(validIds.has(nodeId) && Number.isFinite(position.x) && Number.isFinite(position.y), '节点坐标无效。');
        p.layout.positions[nodeId] = { x: position.x, y: position.y };
      }
      if (input.collapsed) p.layout.collapsed = input.collapsed.filter((entry) => p.targets.some((target) => target.id === entry));
      if (input.viewport) { const { x, y, zoom } = input.viewport; requireValue([x, y, zoom].every(Number.isFinite) && zoom > 0 && zoom <= 4, '视口无效。'); p.layout.viewport = { x, y, zoom }; }
      break;
    }
    case 'relation.add': {
      requireValue(['context', 'applies', 'produces', 'supersedes', 'reviews', 'reference'].includes(input.kind), '关系类型无效。');
      const entities = [...p.targets, ...p.dialogues, ...p.requirements, ...p.assets, ...p.artifacts, ...p.runs];
      find(entities, input.source); find(entities, input.target);
      requireValue(input.source !== input.target, '不能连接节点自身。');
      if (input.kind === 'context') {
        find(p.dialogues, input.source, '来源对话');
        const target = find(p.dialogues, input.target, '目标对话');
        requireValue(target.status === 'draft', '已发送的对话上下文已冻结，请创建新分支。');
        target.parentIds = [...new Set([...target.parentIds, input.source])];
        dialogueContext(p, [target.id]);
      }
      requireValue(!p.relations.some((r) => r.source === input.source && r.target === input.target && r.kind === input.kind), '关系已存在。');
      p.relations.push({ id: id(), source: input.source, target: input.target, kind: input.kind }); break;
    }
    case 'dialogue.draft': {
      find(p.targets, input.targetId, '项目对象');
      dialogueContext(p, input.parentIds ?? []);
      const parent = input.parentIds?.length ? find(p.dialogues, input.parentIds.at(-1)) : null;
      const adopted = p.currentArtifactId ? find(p.artifacts, p.currentArtifactId) : null;
      const sourceRun = input.fromRunId ? find(p.runs, input.fromRunId, '执行记录') : null;
      requireValue(!sourceRun || sourceRun.commit && ['failed', 'cancelled', 'interrupted', 'completed'].includes(sourceRun.status), '这个执行还没有可继续的代码快照。');
      p.dialogues.push({ id: id(), targetId: input.targetId, question: String(input.question ?? '').slice(0, 30000), answer: '', status: 'draft', parentIds: input.parentIds ?? [], baseCommit: sourceRun?.commit ?? parent?.baseCommit ?? adopted?.commit ?? p.initialCommit, branchId: sourceRun?.branchId ?? parent?.branchId ?? p.currentBranchId, createdAt: now() }); break;
    }
    default: throw new BoardError('不支持的画布操作。');
  }
  p.updatedAt = now();
  return p;
}

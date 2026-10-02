import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ReactFlow, ReactFlowProvider, Background, BackgroundVariant, Controls, MiniMap, Handle, Position, applyNodeChanges, type NodeProps, type ReactFlowInstance, type NodeChange, type Connection } from '@xyflow/react';
import { FolderTree, Plus, MessageSquare, ImagePlus, GitBranch, Play, Check, X, FileCheck, ChevronRight, ChevronDown, ArrowUpRight, Download, RefreshCw, Layers, LayoutGrid, Link2, CircleHelp, Square, Search, Loader2 } from 'lucide-react';
import { Markdown } from '../components/Markdown';
import { isImeComposing } from '../utils';
import { useBoard, request, subscribeToBoard, assetUrl, screenshotUrl } from './store';
import { projectGraph, tidyPositions, LABELS, KIND_LABELS, type CardNode } from './graph';
import type { Artifact, BoardSelection, Context, Dialogue, Project, Region, Requirement, Run, Target } from './types';
import RegionEditor from './RegionEditor';
import '@xyflow/react/dist/style.css';
import '../index.css';
import './board.css';

const Card = memo(function Card({ data, selected }: NodeProps<CardNode>) {
  const Icon = ({ target: FolderTree, dialogue: MessageSquare, requirement: FileCheck, asset: ImagePlus, run: Play, artifact: Layers })[data.kind];
  return <article className={`board-card ${selected ? 'selected' : ''}`} data-testid={`card-${data.kind}`}>
    <Handle type="target" position={Position.Top} />
    <div className="board-card-kind"><span><Icon size={13} />{KIND_LABELS[data.kind]}</span>{data.status ? <span className={`board-status ${data.status}`}>{LABELS[data.status] || data.status}</span> : null}</div>
    <h3>{data.title}</h3>
    {data.image ? <img src={data.image} alt={data.title} loading="lazy" draggable={false} /> : <p className="board-card-body">{data.body}</p>}
    <footer>{data.detail}</footer>
    <Handle type="source" position={Position.Bottom} />
  </article>;
});
const NODE_TYPES = { card: Card };
function Modal({ title, children, close, wide = false }: { title: string; children: React.ReactNode; close: () => void; wide?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    box.current?.querySelector<HTMLElement>('input, textarea, button')?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
      if (event.key === 'Tab') {
        const elements = [...(box.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input, textarea, select, a[href]') ?? [])];
        const first = elements[0], last = elements.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('keydown', key); previous?.focus(); };
  }, [close]);
  return <div className="board-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
    <div ref={box} className={`board-modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
      <header><h2>{title}</h2><button className="board-icon" onClick={close} aria-label="关闭"><X size={19} /></button></header>{children}
    </div>
  </div>;
}
function ContextView({ context }: { context: Context | undefined }) {
  if (!context) return <p className="board-muted">暂无冻结的上下文。</p>;
  return <div className="board-context" data-testid="context-view">
    <h4>适用对象</h4><p>{context.targets.map((entry) => entry.label).join(' / ')}</p>
    <h4>已确认要求 · {context.requirements.length}</h4>
    {context.requirements.length ? context.requirements.map((rule) => <div className="board-context-item" key={rule.id}><small>版本 {rule.version}</small><p>{rule.text}</p>{rule.references.map((ref) => <p key={ref.assetId} className="board-muted">参考：{ref.purpose}{ref.ignore ? `；不采纳：${ref.ignore}` : ''}</p>)}</div>) : <p className="board-muted">这个对象暂时没有正式要求。</p>}
    <h4>对话来源 · {context.dialogues.length}</h4>
    {context.dialogues.map((dialogue) => <details key={dialogue.id}><summary>{dialogue.question.slice(0, 70)}</summary><div className="board-markdown"><Markdown>{dialogue.answer}</Markdown></div></details>)}
    <h4>参考资产 · {context.assets.length}</h4>{context.assets.map((asset) => <p key={asset.id}>{asset.name} <small>{asset.sha256.slice(0, 10)}</small></p>)}
  </div>;
}
function NewProject({ close }: { close: () => void }) {
  const [name, setName] = useState(''), [importPath, setPath] = useState(''), [creating, setCreating] = useState(false);
  const [buildScript, setBuild] = useState('build'), [outputDirectory, setOutput] = useState('dist'), [previewScript, setPreview] = useState(''), [testScript, setTest] = useState('');
  return <Modal title="建立项目" close={close}><form onSubmit={(event) => { event.preventDefault(); setCreating(true); void request<Project>('/projects', { name, importPath: importPath.trim() || undefined, settings: { buildScript, outputDirectory, previewScript: previewScript || undefined, testScript: testScript || undefined } }).then(async (project) => { await useBoard.getState().refreshList(); await useBoard.getState().open(project.id); close(); }).catch(useBoard.getState().fail).finally(() => setCreating(false)); }}>
    <label>项目名称<input required value={name} onChange={(event) => setName(event.target.value)} placeholder="给这个项目一个名字" maxLength={120} /></label>
    <label>已有 Git 项目路径（可选）<input value={importPath} onChange={(event) => setPath(event.target.value)} placeholder="例如 D:\\我的项目\\网站" /></label>
    <p className="board-muted">留空会创建可运行的前端项目。导入时保留原项目，使用其已提交的代码建立独立副本。</p>
    {importPath.trim() ? <details><summary>构建与预览设置</summary><label>构建脚本名<input value={buildScript} onChange={(event) => setBuild(event.target.value)} required /></label><label>静态输出目录<input value={outputDirectory} onChange={(event) => setOutput(event.target.value)} required /></label><label>现有预览脚本名（留空自动识别）<input value={previewScript} onChange={(event) => setPreview(event.target.value)} /></label><label>检查脚本名（留空自动识别 test）<input value={testScript} onChange={(event) => setTest(event.target.value)} /></label><p className="board-muted">填写 package.json 中的脚本名。画板保存现有预览命令，成果预览使用每次构建的静态副本；输出目录需包含 index.html。</p></details> : null}
    <div className="board-modal-actions"><button type="button" onClick={close}>取消</button><button className="primary" disabled={creating}>{creating ? <Loader2 className="spin" size={16} /> : <Plus size={16} />}{creating ? '正在建立' : '建立项目'}</button></div>
  </form></Modal>;
}
function DiscussionMaterials({ project, selected, change, close }: { project: Project; selected: string[]; change: (ids: string[]) => void; close: () => void }) {
  const [uploading, setUploading] = useState(false);
  const upload = async (file?: File) => {
    if (!file) return;
    setUploading(true);
    try {
      const source = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(file); });
      const dimensions = await new Promise<{ width: number; height: number }>((resolve, reject) => { const image = new Image(); image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight }); image.onerror = () => reject(new Error('无法读取这张图片。')); image.src = source; });
      const updated = await useBoard.getState().send('/assets', { name: file.name, mimeType: file.type, base64: source.split(',')[1], ...dimensions });
      change([...selected, updated.assets.at(-1)!.id]);
    } catch (error) { useBoard.getState().fail(error); } finally { setUploading(false); }
  };
  return <Modal title="本次讨论的参考材料" close={close}><p className="board-muted">选择或上传原图，先拿来讨论。只有你确认的要求才会成为正式规范。</p><label>上传讨论参考<input aria-label="上传讨论参考" type="file" accept="image/png,image/jpeg,image/webp" disabled={uploading} onChange={(event) => void upload(event.target.files?.[0])} /></label><div className="board-material-list">{project.assets.map((asset) => <label key={asset.id}><input type="checkbox" checked={selected.includes(asset.id)} onChange={(event) => change(event.target.checked ? [...selected, asset.id] : selected.filter((value) => value !== asset.id))} /><img src={assetUrl(project.id, asset.id)} alt="" />{asset.name}</label>)}</div><div className="board-modal-actions"><button className="primary" disabled={uploading} onClick={close}>{uploading ? '正在上传' : '完成选择'}</button></div></Modal>;
}
function AddTarget({ project, parent, close }: { project: Project; parent: Target; close: () => void }) {
  const [label, setLabel] = useState(''), [description, setDescription] = useState(''), [parentId, setParent] = useState(parent.id), [kind, setKind] = useState(parent.kind === 'project' ? 'page' : 'component');
  return <Modal title="添加项目对象" close={close}><form onSubmit={(event) => { event.preventDefault(); void useBoard.getState().command({ type: 'target.add', input: { parentId, kind, label, description } }).then(close).catch(() => {}); }}>
    <label>上级对象<select value={parentId} onChange={(event) => setParent(event.target.value)}>{project.targets.map((target) => <option key={target.id} value={target.id}>{target.label}</option>)}</select></label>
    <label>对象层级<select value={kind} onChange={(event) => setKind(event.target.value)}><option value="page">页面</option><option value="component">局部对象</option></select></label>
    <label>名称<input required value={label} onChange={(event) => setLabel(event.target.value)} placeholder="例如 登录页 / 提交按钮" /></label>
    <label>用途或说明<textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} /></label>
    <div className="board-modal-actions"><button type="button" onClick={close}>取消</button><button className="primary">添加对象</button></div>
  </form></Modal>;
}
function RequirementForm({ project, targetId, previous, quote, sourceIds = [], close }: { project: Project; targetId: string; previous?: Requirement; quote?: string; sourceIds?: string[]; close: () => void }) {
  const [scope, setScope] = useState(previous?.targetId || targetId), [body, setBody] = useState(previous?.text || quote || '');
  return <Modal title={previous?.status === 'candidate' ? '修改候选要求' : previous ? '提出规范的新版本' : '提出候选要求'} close={close}><form onSubmit={(event) => { event.preventDefault(); void useBoard.getState().command({ type: previous?.status === 'candidate' ? 'requirement.edit' : 'requirement.propose', input: { id: previous?.id, targetId: scope, text: body, references: previous?.references || [], sourceDialogueIds: sourceIds.length ? sourceIds : previous?.sourceDialogueIds || [], supersedesId: previous?.id } }).then(close).catch(() => {}); }}>
    <label>适用范围<select value={scope} onChange={(event) => setScope(event.target.value)}>{project.targets.map((target) => <option key={target.id} value={target.id}>{target.label}{target.kind === 'project' ? '（项目通用）' : ''}</option>)}</select></label>
    <label>要求内容<textarea aria-label="要求内容" required value={body} onChange={(event) => setBody(event.target.value)} rows={6} placeholder="描述可检查的具体要求" /></label>
    <p className="board-muted">保存后先作为候选。确认后，相关开发任务才会使用它。</p>
    <div className="board-modal-actions"><button type="button" onClick={close}>取消</button><button className="primary">保存候选</button></div>
  </form></Modal>;
}
function ReferenceForm({ project, targetId, close }: { project: Project; targetId: string; close: () => void }) {
  const [file, setFile] = useState<File | null>(null), [source, setSource] = useState(''), [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  const [assetId, setAsset] = useState(''), [region, setRegion] = useState<Region | null>(null), [purpose, setPurpose] = useState(''), [ignore, setIgnore] = useState(''), [body, setBody] = useState(''), [scope, setScope] = useState(targetId), [saving, setSaving] = useState(false);
  const loadFile = (chosen?: File) => { if (!chosen) return; const reader = new FileReader(); reader.onload = () => { const src = String(reader.result); const image = new Image(); image.onload = () => { setFile(chosen); setAsset(''); setSource(src); setDimensions({ width: image.naturalWidth, height: image.naturalHeight }); setRegion(null); }; image.onerror = () => useBoard.getState().fail(new Error('无法读取这张图片。')); image.src = src; }; reader.readAsDataURL(chosen); };
  return <Modal title="给视觉要求选择参考" close={close} wide><form onSubmit={(event) => {
    event.preventDefault(); setSaving(true);
    void (async () => {
      let selectedAssetId = assetId;
      if (file) {
        const state = useBoard.getState();
        const updated = await request<Project>(`/projects/${project.id}/assets`, { revision: state.project!.revision, name: file.name, mimeType: file.type, base64: source.split(',')[1], ...dimensions });
        useBoard.setState({ project: updated }); selectedAssetId = updated.assets.at(-1)!.id;
      }
      if (!selectedAssetId) throw new Error('请先选择参考图。');
      await useBoard.getState().command({ type: 'requirement.propose', input: { targetId: scope, text: body, references: [{ assetId: selectedAssetId, region, purpose, ignore }] } }); close();
    })().catch(useBoard.getState().fail).finally(() => setSaving(false));
  }}>
    <div className="board-reference-grid"><div>
      <label className="board-upload">上传图片<input aria-label="上传参考图" type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => loadFile(event.target.files?.[0])} /></label>
      {project.assets.length ? <label>或使用已有参考<select value={assetId} onChange={(event) => { setAsset(event.target.value); setFile(null); setRegion(null); const asset = project.assets.find((entry) => entry.id === event.target.value); setSource(asset ? assetUrl(project.id, asset.id) : ''); }}><option value="">选择已有图片</option>{project.assets.map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select></label> : null}
      {source ? <><RegionEditor src={source} value={region} onChange={setRegion} /><div className="board-region-caption"><span>{region ? '已圈选局部区域' : '拖动圈选具体部位，或使用整张图'}</span>{region ? <button type="button" onClick={() => setRegion(null)}>清除圈选</button> : null}</div></> : <div className="board-upload-empty" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); loadFile(event.dataTransfer.files[0]); }}><ImagePlus size={32} /><p>上传或拖入参考图</p><small>PNG、JPEG、WebP · 最大 20MB</small></div>}
    </div><div>
      <label>适用对象<select value={scope} onChange={(event) => setScope(event.target.value)}>{project.targets.map((target) => <option key={target.id} value={target.id}>{target.label}</option>)}</select></label>
      <label>采纳这张图的哪些部分<textarea required rows={3} value={purpose} onChange={(event) => setPurpose(event.target.value)} placeholder="例如 采用按钮颜色、圆角和边框" /></label>
      <label>不需要采纳的部分<textarea rows={2} value={ignore} onChange={(event) => setIgnore(event.target.value)} placeholder="例如 忽略文案、图标和背景" /></label>
      <label>形成的具体要求<textarea required rows={4} value={body} onChange={(event) => setBody(event.target.value)} placeholder="说明项目里的这个对象应当怎样呈现" /></label>
    </div></div>
    <div className="board-modal-actions"><button type="button" onClick={close}>取消</button><button className="primary" disabled={saving || !source}>{saving ? '正在保存' : '保存为候选要求'}</button></div>
  </form></Modal>;
}
function ExecutionForm({ project, dialogue, close }: { project: Project; dialogue: Dialogue; close: () => void }) {
  const [context, setContext] = useState<Context>(), [name, setName] = useState(`方案 ${project.branches.length + 1}`), [instruction, setInstruction] = useState(dialogue.question), [branchId, setBranchId] = useState('');
  const [referenceIds, setReferences] = useState<string[]>([]);
  useEffect(() => { let active = true; void request<Context>(`/projects/${project.id}/context/${dialogue.targetId}?dialogues=${dialogue.id}&references=${referenceIds.join(',')}`).then((value) => { if (active) setContext(value); }).catch(useBoard.getState().fail); return () => { active = false; }; }, [project.id, dialogue.id, dialogue.targetId, referenceIds]);
  return <Modal title="执行开发前查看输入" close={close} wide><form onSubmit={(event) => { event.preventDefault(); void useBoard.getState().send('/runs', { dialogueId: dialogue.id, name, instruction, referenceIds, branchId: branchId || undefined, expectedFingerprint: context?.fingerprint }).then(close).catch(() => {}); }}>
    <div className="board-execution-grid"><div><label>开发任务<textarea aria-label="开发任务" value={instruction} onChange={(event) => setInstruction(event.target.value)} rows={6} required /></label>
      <label>项目版本<select value={branchId} onChange={(event) => setBranchId(event.target.value)}><option value="">新建独立方案</option>{project.branches.filter((branch) => branch.headCommit === dialogue.baseCommit).map((branch) => <option key={branch.id} value={branch.id}>在 {branch.name} 继续</option>)}</select></label>
      {!branchId ? <label>方案名称<input value={name} onChange={(event) => setName(event.target.value)} required /></label> : null}
      <p className="board-muted">从所选节点的代码版本开始。执行会保留真实记录，并构建页面供你检查。</p>
      {project.assets.length ? <details><summary>增加参考材料</summary><div className="board-material-list">{project.assets.map((asset) => <label key={asset.id}><input type="checkbox" checked={referenceIds.includes(asset.id)} onChange={(event) => { setContext(undefined); setReferences((current) => event.target.checked ? [...current, asset.id] : current.filter((value) => value !== asset.id)); }} />{asset.name}</label>)}</div></details> : null}
    </div><div className="board-execution-context"><ContextView context={context} /></div></div>
    <div className="board-modal-actions"><button type="button" onClick={close}>返回讨论</button><button className="primary" disabled={!context}><Play size={15} />执行开发</button></div>
  </form></Modal>;
}
function ReviewForm({ artifact, result, close }: { artifact: Artifact; result: 'accepted' | 'changes'; close: () => void }) {
  const [note, setNote] = useState('');
  const [context, setContext] = useState<Context>();
  useEffect(() => { const projectId = useBoard.getState().project?.id; if (projectId) void request<Context>(`/projects/${projectId}/context/${artifact.targetId}`).then(setContext).catch(useBoard.getState().fail); }, [artifact.targetId]);
  return <Modal title={result === 'accepted' ? '记录验收结果' : '提出修改意见'} close={close}><form onSubmit={(event) => { event.preventDefault(); void useBoard.getState().command({ type: 'artifact.review', input: { id: artifact.id, result, note, expectedFingerprint: context?.fingerprint } }).then(() => { if (result === 'changes') { const draft = useBoard.getState().project?.dialogues.at(-1); if (draft) useBoard.getState().select({ kind: 'dialogue', id: draft.id }); } close(); }).catch(() => {}); }}>
    <p>{result === 'accepted' ? '确认你已对照当前适用要求检查这个成果。记录会关联当前规范版本。' : '修改意见会形成一个关联成果的新对话草稿，保留当前页面版本。'}</p>
    {result === 'accepted' ? <details open><summary>这次验收对照的当前要求</summary><ContextView context={context} /></details> : null}
    <label>{result === 'accepted' ? '验收说明（可选）' : '具体要修改什么'}<textarea required={result === 'changes'} rows={5} value={note} onChange={(event) => setNote(event.target.value)} /></label>
    <div className="board-modal-actions"><button type="button" onClick={close}>取消</button><button className="primary" disabled={!context}>{result === 'accepted' ? '确认已验收' : '保存修改意见'}</button></div>
  </form></Modal>;
}
function PreviewDialog({ project, artifacts, close }: { project: Project; artifacts: Artifact[]; close: () => void }) {
  const [urls, setUrls] = useState<Record<string, string>>({});
  useEffect(() => { for (const artifact of artifacts) void request<{ url: string }>(`/projects/${project.id}/artifacts/${artifact.id}/preview`, {}).then(({ url }) => setUrls((current) => ({ ...current, [artifact.id]: url }))).catch(useBoard.getState().fail); }, [project.id, artifacts]);
  return <Modal title={artifacts.length > 1 ? '比较独立方案' : '页面预览'} close={close} wide><div className={`board-previews ${artifacts.length > 1 ? 'compare' : ''}`}>{artifacts.map((artifact) => <section key={artifact.id}><header><span>{project.branches.find((branch) => branch.id === artifact.branchId)?.name}</span><small>{artifact.commit.slice(0, 7)}</small>{urls[artifact.id] ? <a href={urls[artifact.id]} target="_blank" rel="noreferrer">打开页面<ArrowUpRight size={13} /></a> : null}</header>{urls[artifact.id] ? <iframe title={`页面预览 ${artifact.id}`} src={urls[artifact.id]} sandbox="allow-scripts allow-same-origin allow-forms allow-popups" /> : <p>正在打开页面…</p>}</section>)}</div></Modal>;
}
function ApprovalList({ project, task }: { project: Project; task: Run | Dialogue }) {
  const [value, setValue] = useState('');
  return <>{task.approvals?.filter((entry) => entry.state === 'pending').map((approval) => <div className="board-approval" key={approval.id}><h4>开发连接需要你的回复</h4><p>{approval.message}</p>{approval.kind !== 'confirm' ? <input value={value} onChange={(event) => setValue(event.target.value)} placeholder="输入回复" /> : null}<div className="board-button-row"><button onClick={() => void useBoard.getState().send(`/tasks/${task.id}/answer`, { requestId: approval.id, response: { confirmed: false } }).catch(() => {})}>拒绝</button><button className="primary" onClick={() => void useBoard.getState().send(`/tasks/${task.id}/answer`, { requestId: approval.id, response: approval.kind === 'confirm' ? { confirmed: true } : { value } }).catch(() => {})}>{approval.kind === 'confirm' ? '允许本次操作' : '发送回复'}</button></div><small>请求属于项目：{project.name}</small></div>)}</>;
}
type OpenDialog = (kind: 'requirement' | 'reference' | 'materials' | 'execute' | 'accept' | 'changes' | 'preview' | 'compare' | 'target' | 'context', data?: unknown) => void;
function Inspector({ project, selection, target, openDialog, setParents, focusComposer }: { project: Project; selection: BoardSelection | null; target: Target; openDialog: OpenDialog; setParents: (ids: string[]) => void; focusComposer: () => void }) {
  const command = useBoard((state) => state.command);
  const safeCommand = (type: string, input: Record<string, unknown>) => void command({ type, input }).catch(() => {});
  let title = target.label, body: React.ReactNode;
  if (selection?.kind === 'dialogue') {
    const dialogue = project.dialogues.find((entry) => entry.id === selection.id)!; title = '对话与来源';
    body = <><span className={`board-status ${dialogue.status}`}>{LABELS[dialogue.status]}</span><h3>{dialogue.question || '对话草稿'}</h3><div className="board-markdown"><Markdown>{dialogue.answer || dialogue.error || '这个问题尚未发送。'}</Markdown></div>
      <ApprovalList project={project} task={dialogue} />
      <div className="board-button-row"><button onClick={() => { setParents([dialogue.id]); focusComposer(); }} disabled={dialogue.status !== 'completed'}><GitBranch size={14} />拉出分支</button><button onClick={() => openDialog('requirement', { quote: window.getSelection()?.toString() || dialogue.question, sourceIds: [dialogue.id] })}><FileCheck size={14} />提取要求</button></div>
      {dialogue.status === 'completed' ? <button className="primary full" onClick={() => openDialog('execute', dialogue)}><Play size={15} />执行开发</button> : ['queued', 'running', 'waiting'].includes(dialogue.status) ? <button onClick={() => void useBoard.getState().send(`/tasks/${dialogue.id}/cancel`, {}).catch(() => {})}><Square size={13} />取消讨论</button> : null}
      <details><summary>本次上下文</summary><ContextView context={dialogue.snapshot} /></details><small>代码来源：{dialogue.baseCommit.slice(0, 10)}</small>
    </>;
  } else if (selection?.kind === 'requirement') {
    const rule = project.requirements.find((entry) => entry.id === selection.id)!; title = '要求与适用范围';
    body = <><span className={`board-status ${rule.status}`}>{LABELS[rule.status]}</span><h3>{rule.text}</h3><p className="board-muted">适用于：{project.targets.find((entry) => entry.id === rule.targetId)?.label} · 版本 {rule.version}</p>
      {rule.status === 'candidate' ? <div className="board-button-row"><button onClick={() => openDialog('requirement', { previous: rule })}>修改</button><button onClick={() => safeCommand('requirement.reject', { id: rule.id })}>不采纳</button><button className="primary" onClick={() => safeCommand('requirement.confirm', { id: rule.id })}><Check size={14} />确认生效</button></div> : rule.status === 'confirmed' ? <button onClick={() => openDialog('requirement', { previous: rule })}><RefreshCw size={14} />提出新版本</button> : null}
      {rule.references.map((ref) => <section className="board-inspector-section" key={ref.assetId}><RegionEditor src={assetUrl(project.id, ref.assetId)} value={ref.region} readOnly /><h4>采纳范围</h4><p>{ref.purpose}</p>{ref.ignore ? <><h4>不采纳</h4><p>{ref.ignore}</p></> : null}</section>)}
      <h4>来源对话</h4>{rule.sourceDialogueIds.length ? rule.sourceDialogueIds.map((sourceId) => <button key={sourceId} className="board-link" onClick={() => useBoard.getState().select({ kind: 'dialogue', id: sourceId })}>{project.dialogues.find((entry) => entry.id === sourceId)?.question}<ArrowUpRight size={13} /></button>) : <p className="board-muted">由用户或外部连接提出。</p>}
      <details><summary>全部历史版本</summary>{project.requirements.filter((entry) => entry.requirementId === rule.requirementId).map((entry) => <button className="board-link" key={entry.id} onClick={() => useBoard.getState().select({ kind: 'requirement', id: entry.id })}>版本 {entry.version} · {LABELS[entry.status]}</button>)}</details>
    </>;
  } else if (selection?.kind === 'artifact') {
    const artifact = project.artifacts.find((entry) => entry.id === selection.id)!; title = '成果与验收';
    const run = project.runs.find((entry) => entry.id === artifact.runId)!;
    body = <><img className="board-result-image" src={screenshotUrl(project.id, artifact.id)} alt="这个方案的实际页面截图" /><h3>{project.branches.find((entry) => entry.id === artifact.branchId)?.name}</h3><span className={`board-status ${artifact.stale ? 'stale' : 'completed'}`}>{artifact.stale ? '规范已变更，需复核' : '构建已通过'}</span>
      <div className="board-button-row"><button onClick={() => openDialog('preview', [artifact])}><ArrowUpRight size={14} />页面预览</button><button onClick={() => openDialog('compare', artifact)}><Layers size={14} />比较方案</button></div>
      <button className="primary full" onClick={() => openDialog('accept', artifact)}><FileCheck size={15} />{artifact.stale ? '复核并验收' : '记录验收'}</button>
      <div className="board-button-row"><button onClick={() => openDialog('changes', artifact)}>提出修改意见</button><button disabled={project.currentArtifactId === artifact.id} onClick={() => safeCommand('branch.adopt', { id: artifact.branchId, artifactId: artifact.id })}><Check size={14} />{project.currentArtifactId === artifact.id ? '当前方案' : '采纳方案'}</button></div>
      <button className="board-link" onClick={() => useBoard.getState().select({ kind: 'run', id: run.id })}>查看实际执行记录<ArrowUpRight size={13} /></button>
      <details><summary>本次使用的要求</summary><ContextView context={run.snapshot} /></details><h4>验收历史</h4>{project.reviews.filter((entry) => entry.artifactId === artifact.id).map((review) => <p key={review.id}>{review.result === 'accepted' ? '已验收' : '需要修改'}：{review.note || '对照当前要求检查通过'}</p>)}
      <small>代码版本：{artifact.commit}</small>
    </>;
  } else if (selection?.kind === 'run') {
    const run = project.runs.find((entry) => entry.id === selection.id)!; title = '真实执行记录';
    body = <><span className={`board-status ${run.status}`}>{LABELS[run.status]}</span><h3>{run.instruction}</h3><ApprovalList project={project} task={run} /><div className="board-markdown"><Markdown>{run.output || '开发连接正在处理这个任务。'}</Markdown></div>{run.error ? <p className="board-inline-error">{run.error}</p> : null}
      {['queued', 'running', 'checking', 'waiting'].includes(run.status) ? <button onClick={() => void useBoard.getState().send(`/tasks/${run.id}/cancel`, {}).catch(() => {})}><Square size={14} />取消任务</button> : null}
      {run.status === 'interrupted' ? <button onClick={() => void useBoard.getState().send(`/runs/${run.id}/reconcile`, {}).catch(() => {})}><RefreshCw size={14} />核对中断状态</button> : null}
      {run.commit && ['failed', 'cancelled', 'interrupted'].includes(run.status) ? <button onClick={() => { void command({ type: 'dialogue.draft', input: { targetId: run.targetId, parentIds: [run.dialogueId], fromRunId: run.id, question: `继续处理：${run.instruction}\n上次结果：${run.error || run.status}` } }).then(() => { const draft = useBoard.getState().project?.dialogues.at(-1); if (draft) useBoard.getState().select({ kind: 'dialogue', id: draft.id }); focusComposer(); }).catch(() => {}); }}><GitBranch size={14} />从保存的版本继续</button> : null}
      <details open><summary>实际使用的输入</summary><ContextView context={run.deliveredContext || run.snapshot} /></details>
      {run.checks ? <details><summary>构建与检查结果</summary>{Object.entries(run.checks).filter(([, value]) => value).map(([key, value]) => <div key={key}><h4>{key === 'build' ? '构建' : key === 'test' ? '测试' : '依赖准备'} · {value!.passed ? '通过' : '未通过'}</h4><pre>{value!.output || '完成'}</pre></div>)}</details> : null}
      <details><summary>工具执行记录 · {run.events.length}</summary>{run.events.map((event, index) => <pre key={index}>{JSON.stringify(event, null, 2)}</pre>)}</details><small>起始代码：{run.baseCommit.slice(0, 12)}{run.commit ? ` → ${run.commit.slice(0, 12)}` : ''}</small>
    </>;
  } else if (selection?.kind === 'asset') {
    const asset = project.assets.find((entry) => entry.id === selection.id)!; title = '参考资产';
    body = <><img className="board-result-image" src={assetUrl(project.id, asset.id)} alt={asset.name} /><h3>{asset.name}</h3><p>{asset.width} × {asset.height}</p><button onClick={() => openDialog('reference')}><FileCheck size={14} />关联为视觉要求</button><h4>使用这张图的要求</h4>{project.requirements.filter((rule) => rule.references.some((ref) => ref.assetId === asset.id)).map((rule) => <button className="board-link" key={rule.id} onClick={() => useBoard.getState().select({ kind: 'requirement', id: rule.id })}>{rule.text}</button>)}</>;
  } else {
    const rules = project.requirements.filter((rule) => rule.targetId === target.id && ['candidate', 'confirmed'].includes(rule.status));
    const artifacts = project.artifacts.filter((artifact) => artifact.targetId === target.id);
    body = <><span className={`board-status ${target.status}`}>{LABELS[target.status]}</span><h3>{target.label}</h3><p className="board-muted">{target.description || '把这个对象的要求、讨论和成果放在一起。'}</p>
      <div className="board-button-row"><button onClick={() => openDialog('requirement')}><FileCheck size={14} />提出要求</button><button onClick={() => openDialog('reference')}><ImagePlus size={14} />视觉参考</button></div><button className="board-link" onClick={() => { setParents([]); focusComposer(); }}><MessageSquare size={14} />从这个对象开始讨论</button>
      <h4>要求 · {rules.length}</h4>{rules.map((rule) => <button className="board-list-item" key={rule.id} onClick={() => useBoard.getState().select({ kind: 'requirement', id: rule.id })}><span className={`board-status ${rule.status}`}>{LABELS[rule.status]}</span><p>{rule.text}</p></button>)}
      <h4>页面成果 · {artifacts.length}</h4>{artifacts.map((artifact) => <button className="board-list-item" key={artifact.id} onClick={() => useBoard.getState().select({ kind: 'artifact', id: artifact.id })}><img src={screenshotUrl(project.id, artifact.id)} alt="页面成果" /><p>{project.branches.find((entry) => entry.id === artifact.branchId)?.name} {artifact.stale ? '· 需复核' : ''}</p></button>)}
      {!rules.length && !artifacts.length ? <div className="board-inspector-empty"><CircleHelp size={24} /><p>先讨论想做什么，再把明确的细节保存为要求。</p></div> : null}
    </>;
  }
  return <aside className="board-inspector"><header><span>{title}</span><span className="board-muted">详情</span></header><div className="board-inspector-content">{body}</div></aside>;
}

function BoardWorkspace() {
  const { project, projects, selection, targetId, connection, error, busy } = useBoard();
  const [dialog, setDialog] = useState<{ kind: string; data?: unknown } | null>(null), [parents, setParents] = useState<string[]>([]), [question, setQuestion] = useState(''), [search, setSearch] = useState(''), [chatOnly, setChatOnly] = useState(false);
  const [referenceIds, setReferences] = useState<string[]>([]);
  const [context, setContext] = useState<Context>(), [runtime, setRuntime] = useState<{ installed: boolean; defaultModel: string | null; mock?: boolean } | null>(null);
  const [runtimeError, setRuntimeError] = useState(''), [nodes, setNodes] = useState<CardNode[]>(() => project ? projectGraph(project).nodes : []);
  const flow = useRef<ReactFlowInstance<CardNode>>(null), composer = useRef<HTMLTextAreaElement>(null);
  const projectRef = useRef(project);
  useEffect(() => { projectRef.current = project; }, [project]);
  const graph = useMemo(() => project ? projectGraph(project) : { nodes: [], edges: [] }, [project]);
  const target = project?.targets.find((entry) => entry.id === targetId) || project?.targets[0];
  useEffect(() => subscribeToBoard(), []);
  useEffect(() => useBoard.subscribe((state, previous) => {
    if (state.selection?.id !== previous.selection?.id && state.selection?.kind === 'dialogue') {
      const draft = state.project?.dialogues.find((entry) => entry.id === state.selection?.id && entry.status === 'draft');
      if (draft) { setQuestion(draft.question); setParents(draft.parentIds); composer.current?.focus(); }
    }
    if (state.project === previous.project) return;
    const next = state.project ? projectGraph(state.project).nodes : [];
    setNodes((current) => {
      const byId = new Map(current.map((node) => [node.id, node]));
      return next.map((node) => ({ ...node, measured: byId.get(node.id)?.measured }));
    });
  }), []);
  useEffect(() => { void useBoard.getState().refreshList().catch(useBoard.getState().fail); }, []);
  const checkRuntime = useCallback(() => { void request<{ installed: boolean; defaultModel: string | null; mock?: boolean }>('/runtime').then((value) => { setRuntime(value); setRuntimeError(''); }).catch((failure) => setRuntimeError(failure.message)); }, []);
  useEffect(() => { checkRuntime(); }, [checkRuntime]);
  const close = useCallback(() => setDialog(null), []);
  const openDialog = useCallback<OpenDialog>((kind, data) => {
    if (kind === 'compare' && projectRef.current) {
      const artifact = data as Artifact;
      const other = [...projectRef.current.artifacts].reverse().find((entry) => entry.branchId !== artifact.branchId && entry.targetId === artifact.targetId);
      if (!other) { useBoard.getState().fail(new Error('这个对象还需要另一个独立方案，才能并排比较。')); return; }
      setDialog({ kind: 'preview', data: [artifact, other] }); return;
    }
    if (kind === 'context' && projectRef.current && targetId) {
      void request<Context>(`/projects/${projectRef.current.id}/context/${targetId}?dialogues=${parents.join(',')}&references=${referenceIds.join(',')}`).then((value) => { setContext(value); setDialog({ kind }); }).catch(useBoard.getState().fail); return;
    }
    setDialog({ kind, data });
  }, [targetId, parents, referenceIds]);
  const select = (picked: BoardSelection) => {
    useBoard.getState().select(picked);
    const draft = picked.kind === 'dialogue' ? projectRef.current?.dialogues.find((entry) => entry.id === picked.id && entry.status === 'draft') : null;
    if (draft) { setQuestion(draft.question); setParents(draft.parentIds); composer.current?.focus(); }
  };
  const connect = (link: Connection) => {
    if (!link.source || !link.target) return;
    const source = graph.nodes.find((entry) => entry.id === link.source), destination = graph.nodes.find((entry) => entry.id === link.target);
    const kind = source?.data.kind === 'dialogue' && destination?.data.kind === 'dialogue' ? 'context' : 'reference';
    void useBoard.getState().command({ type: 'relation.add', input: { source: link.source, target: link.target, kind } }).catch(() => {});
  };
  const sendQuestion = (event: React.FormEvent) => {
    event.preventDefault(); if (!target || !question.trim()) return;
    const draft = selection?.kind === 'dialogue' ? project?.dialogues.find((entry) => entry.id === selection.id && entry.status === 'draft') : null;
    void useBoard.getState().send('/discuss', { question, targetId: target.id, parentIds: draft?.parentIds || parents, draftId: draft?.id, referenceIds }).then(() => { setQuestion(''); setParents([]); setReferences([]); const latest = useBoard.getState().project?.dialogues.at(-1); if (latest) select({ kind: 'dialogue', id: latest.id }); }).catch(() => {});
  };
  const filteredNodes = nodes.map((node) => ({ ...node, selected: selection?.id === node.id, hidden: Boolean((chatOnly && node.data.kind !== 'dialogue') || (search && !node.data.title.includes(search) && !node.data.body.includes(search))) }));
  const tree = (parentId: string | null, level = 0): React.ReactNode => project?.targets.filter((entry) => entry.parentId === parentId).map((entry) => {
    const children = project.targets.some((child) => child.parentId === entry.id), collapsed = project.layout.collapsed.includes(entry.id);
    return <div key={entry.id}><div className={`board-tree-row ${targetId === entry.id ? 'active' : ''}`} style={{ paddingLeft: 12 + level * 16 }}>
      {children ? <button aria-label={collapsed ? `展开 ${entry.label}` : `折叠 ${entry.label}`} className="board-tree-toggle" onClick={() => void useBoard.getState().command({ type: 'layout.update', input: { collapsed: collapsed ? project.layout.collapsed.filter((item) => item !== entry.id) : [...project.layout.collapsed, entry.id] } }).catch(() => {})}>{collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}</button> : <span className="board-tree-spacer" />}
      <button aria-label={entry.label} onClick={() => select({ kind: 'target', id: entry.id })}><span>{entry.label}</span><i className={entry.status} title={LABELS[entry.status]} /></button></div>{collapsed ? null : tree(entry.id, level + 1)}</div>;
  });
  return <div className="board-app">
    <header className="board-topbar"><div className="board-brand"><FolderTree size={23} /><strong>项目画板</strong><span>从讨论到成果</span></div><div className="board-top-actions"><button onClick={() => setDialog({ kind: 'help' })}><CircleHelp size={15} />使用说明</button><button onClick={checkRuntime} title={runtimeError || runtime?.defaultModel || '检查开发连接'}><span className={`board-connection ${runtime?.installed ? 'connected' : ''}`} />{runtimeError ? '开发连接失败' : runtime?.mock ? '模拟开发连接' : runtime?.installed ? '开发连接就绪' : '检查开发连接'}</button></div></header>
    <aside className="board-sidebar"><div className="board-sidebar-heading"><span>项目</span><button className="board-icon" aria-label="建立项目" onClick={() => setDialog({ kind: 'project' })}><Plus size={16} /></button></div>
      <div className="board-project-list">{projects.map((entry) => <button className={project?.id === entry.id ? 'active' : ''} key={entry.id} onClick={() => { setParents([]); setQuestion(''); setReferences([]); void useBoard.getState().open(entry.id); }}><FolderTree size={16} /><span>{entry.name}</span><ChevronRight size={13} /></button>)}</div>
      {project ? <><div className="board-sidebar-heading"><span>项目对象</span><button className="board-icon" aria-label="添加对象" onClick={() => openDialog('target')}><Plus size={16} /></button></div><div className="board-tree">{tree(null)}</div>
        <div className="board-sidebar-summary"><h4>项目当前状态</h4><p>{project.currentBranchId ? project.branches.find((entry) => entry.id === project.currentBranchId)?.name : '尚未采纳方案'}</p><span>{project.targets.filter((entry) => entry.status === 'stale').length} 个对象需复核</span>{project.currentArtifactId ? <button className="board-link" onClick={() => openDialog('preview', project.artifacts.filter((entry) => entry.id === project.currentArtifactId))}>打开当前方案<ArrowUpRight size={13} /></button> : null}</div>
        <div className="board-sidebar-bottom"><a href={`/api/board/projects/${project.id}/export`}><Download size={15} />导出交接包</a><button onClick={() => setChatOnly((value) => !value)}><MessageSquare size={15} />{chatOnly ? '显示完整项目' : '只看对话分支'}</button></div>
      </> : <div className="board-sidebar-empty"><p>建立项目后，这里会显示页面和局部对象。</p></div>}
    </aside>
    <main className="board-canvas">
      {project && target ? <><div className="board-canvas-toolbar"><div><span className="board-breadcrumb">{project.name}<ChevronRight size={13} />{target.label}</span><span className={`board-status ${target.status}`}>{LABELS[target.status]}</span></div><div className="board-toolbar-actions"><label className="board-search"><Search size={14} /><input aria-label="搜索画布" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="查找要求或讨论" /></label><button title="整理布局" onClick={() => void useBoard.getState().command({ type: 'layout.update', input: { positions: tidyPositions(graph.nodes, graph.edges) } }).then(() => flow.current?.fitView({ padding: 0.18, maxZoom: 1 })).catch(() => {})}><LayoutGrid size={15} /></button><button title="查看全部" onClick={() => flow.current?.fitView({ padding: 0.15, maxZoom: 1 })}><Layers size={15} /></button></div></div>
        <ReactFlow<CardNode> key={project.id} nodes={filteredNodes} edges={graph.edges} nodeTypes={NODE_TYPES} onInit={(instance) => { flow.current = instance; setTimeout(() => { if (Object.keys(project.layout.positions).length) void instance.setViewport(project.layout.viewport); else void instance.fitView({ padding: 0.2, maxZoom: 1 }); }, 100); }}
          onNodesChange={(changes: NodeChange<CardNode>[]) => setNodes((current) => applyNodeChanges(changes, current))} onNodeClick={(_event, node) => select({ kind: node.data.kind, id: node.id })}
          onNodeDragStop={(_event, node) => void useBoard.getState().command({ type: 'layout.update', input: { positions: { [node.id]: node.position } } }).catch(() => {})}
          onMoveEnd={(_event, viewport) => { const current = projectRef.current; if (current && JSON.stringify(current.layout.viewport) !== JSON.stringify(viewport)) void useBoard.getState().command({ type: 'layout.update', input: { viewport } }).catch(() => {}); }}
          onConnect={connect} minZoom={0.15} maxZoom={2.5} deleteKeyCode={null} panOnDrag colorMode="dark" fitView fitViewOptions={{ maxZoom: 1, padding: 0.2 }} proOptions={{ hideAttribution: true }}>
          <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="#33352d" /><Controls fitViewOptions={{ maxZoom: 1, padding: 0.2 }} showInteractive={false} position="bottom-left" /><MiniMap nodeColor="#5c5e52" maskColor="rgba(11,12,10,.8)" position="bottom-right" />
        </ReactFlow>
        <form className="board-composer" onSubmit={sendQuestion}><div className="board-composer-context"><span><MessageSquare size={14} />讨论 · {target.label}</span><button type="button" onClick={() => openDialog('context')}><Link2 size={13} />查看输入来源</button><button type="button" onClick={() => openDialog('materials')} aria-label="选择讨论参考"><ImagePlus size={15} />{referenceIds.length ? `${referenceIds.length} 张参考` : '参考材料'}</button></div>
          {parents.length ? <div className="board-parent-chips">{parents.map((parentId) => <button type="button" key={parentId} onClick={() => setParents((current) => current.filter((entry) => entry !== parentId))}>{project.dialogues.find((entry) => entry.id === parentId)?.question.slice(0, 24)}<X size={12} /></button>)}</div> : null}
          <textarea ref={composer} aria-label="讨论输入" value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="讨论这个对象的目标、顾虑或具体细节…" rows={2} onKeyDown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !isImeComposing(event)) { event.preventDefault(); sendQuestion(event); } }} />
          <footer><span>讨论保持只读，选择“执行开发”后才修改代码。</span><details><summary>引用对话</summary><div className="board-context-choices">{project.dialogues.filter((entry) => entry.status === 'completed').map((dialogue) => <label key={dialogue.id}><input type="checkbox" checked={parents.includes(dialogue.id)} onChange={(event) => setParents((current) => event.target.checked ? [...current, dialogue.id] : current.filter((entry) => entry !== dialogue.id))} />{dialogue.question.slice(0, 50)}</label>)}</div></details><button className="primary" disabled={busy || connection === 'offline' || !question.trim()}><ArrowUpRight size={16} />发送</button></footer>
        </form>
      </> : <div className="board-welcome"><div className="board-welcome-grid"><span /><span /><span /></div><FolderTree size={40} /><p>项目画板</p><h1>让项目的每一步<br />都有迹可循。</h1><div className="board-welcome-description">把讨论、参考、正式要求和页面成果放在一起。<br />从一个具体对象出发，看懂它为什么这样做。</div><button className="primary" onClick={() => setDialog({ kind: 'project' })}><Plus size={16} />建立第一个项目</button><small>本机保存 · 独立方案 · 人工验收</small></div>}
    </main>
    {project && target ? <Inspector project={project} selection={selection} target={target} openDialog={openDialog} setParents={setParents} focusComposer={() => composer.current?.focus()} /> : <aside className="board-inspector welcome"><header>一个项目，清楚的来路</header><ol><li><strong>从对象开始</strong><p>页面和按钮都有自己的讨论与要求。</p></li><li><strong>把细节说明白</strong><p>圈出参考图的具体部位，确认要采纳什么。</p></li><li><strong>看见真实成果</strong><p>比较独立方案，检查页面，再记录验收。</p></li></ol></aside>}
    <footer className="board-footer"><span><i className={connection} />{connection === 'connected' ? '本机数据已连接' : connection === 'offline' ? '连接断开，正在重连' : '正在连接本机服务'}</span><span>{project ? `${project.targets.length} 个对象 · ${project.requirements.filter((rule) => rule.status === 'confirmed').length} 项有效要求 · ${project.artifacts.length} 个成果` : '项目数据保存在本机'}</span></footer>
    {error || runtimeError ? <div className="board-toast" role="alert"><span>{error || runtimeError}</span><button aria-label="关闭提示" onClick={() => { useBoard.getState().clearError(); setRuntimeError(''); }}><X size={15} /></button></div> : null}
    {dialog?.kind === 'project' ? <NewProject close={close} /> : null}
    {project && target && dialog?.kind === 'target' ? <AddTarget project={project} parent={target} close={close} /> : null}
    {project && target && dialog?.kind === 'requirement' ? <RequirementForm project={project} targetId={target.id} {...(dialog.data as { previous?: Requirement; quote?: string; sourceIds?: string[] } || {})} close={close} /> : null}
    {project && dialog?.kind === 'materials' ? <DiscussionMaterials project={project} selected={referenceIds} change={setReferences} close={close} /> : null}
    {project && target && dialog?.kind === 'reference' ? <ReferenceForm project={project} targetId={target.id} close={close} /> : null}
    {project && dialog?.kind === 'execute' ? <ExecutionForm project={project} dialogue={dialog.data as Dialogue} close={close} /> : null}
    {dialog?.kind === 'accept' || dialog?.kind === 'changes' ? <ReviewForm artifact={dialog.data as Artifact} result={dialog.kind === 'accept' ? 'accepted' : 'changes'} close={close} /> : null}
    {project && dialog?.kind === 'preview' ? <PreviewDialog project={project} artifacts={dialog.data as Artifact[]} close={close} /> : null}
    {dialog?.kind === 'context' ? <Modal title="下一次讨论会使用的输入" close={close}><ContextView context={context} /></Modal> : null}
    {dialog?.kind === 'help' ? <Modal title="怎样用画板管理项目" close={close}><div className="board-help"><h3>建立对象，再围绕对象讨论</h3><p>在左侧添加页面或局部对象。聊天默认只读，完成的对话可以拉出分支，也可以同时引用多条讨论。</p><h3>确认要求，再执行开发</h3><p>AI 提炼的内容和手动提出的内容都是候选。确认后才成为正式要求。视觉参考可以圈选局部并说明采纳范围。</p><h3>比较成果，再记录验收</h3><p>执行开发会保留独立代码版本和页面截图。验收与采纳方案分别记录：采纳决定后续使用哪个版本，验收表示你已经检查成果。</p><h3>规范变化，关联成果需复核</h3><p>旧版本和验收记录会保留。你选择重新检查或修改，系统不会自动重做所有方案。</p></div></Modal> : null}
  </div>;
}
export default function BoardApp() { return <ReactFlowProvider><BoardWorkspace /></ReactFlowProvider>; }

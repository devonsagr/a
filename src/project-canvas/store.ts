import { create } from 'zustand';
import type { Project, ProjectSummary, BoardSelection, Command } from './types';

const BASE = '/api/board';
export async function request<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(BASE + url, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `服务请求失败 (${response.status})`);
  return data as T;
}
interface State {
  projects: ProjectSummary[]; project: Project | null; selection: BoardSelection | null; targetId: string | null;
  connection: 'connecting' | 'connected' | 'offline'; error: string | null; busy: boolean;
  refreshList: () => Promise<void>; open: (id: string) => Promise<void>; refresh: () => Promise<void>;
  select: (selection: BoardSelection) => void; command: (command: Command) => Promise<void>;
  send: (url: string, input: Record<string, unknown>) => Promise<Project>;
  fail: (error: unknown) => void; clearError: () => void;
}
export const useBoard = create<State>((set, get) => ({
  projects: [], project: null, selection: null, targetId: null, connection: 'connecting', error: null, busy: false,
  fail: (error) => set({ error: error instanceof Error ? error.message : String(error), busy: false }),
  clearError: () => set({ error: null }),
  refreshList: async () => { const projects = await request<ProjectSummary[]>('/projects'); set({ projects }); const activeId = localStorage.getItem('project-canvas.active'); if (!get().project && activeId && projects.some((entry) => entry.id === activeId)) await get().open(activeId); },
  open: async (projectId) => {
    set({ busy: true });
    try { const project = await request<Project>(`/projects/${projectId}`); localStorage.setItem('project-canvas.active', project.id); set({ project, targetId: project.targets[0].id, selection: { kind: 'target', id: project.targets[0].id }, busy: false, error: null }); }
    catch (error) { get().fail(error); }
  },
  refresh: async () => {
    const projectId = get().project?.id; if (!projectId) return;
    const project = await request<Project>(`/projects/${projectId}`);
    if (get().project?.id === projectId && project.revision >= get().project!.revision) set({ project });
  },
  select: (selection) => {
    const project = get().project; if (!project) return;
    const entity = selection.kind === 'target' ? project.targets.find((item) => item.id === selection.id)
      : selection.kind === 'dialogue' ? project.dialogues.find((item) => item.id === selection.id)
      : selection.kind === 'requirement' ? project.requirements.find((item) => item.id === selection.id)
      : selection.kind === 'artifact' ? project.artifacts.find((item) => item.id === selection.id)
      : selection.kind === 'run' ? project.runs.find((item) => item.id === selection.id) : null;
    set({ selection, ...(selection.kind === 'target' ? { targetId: selection.id } : entity && 'targetId' in entity ? { targetId: entity.targetId } : {}) });
  },
  command: async (command) => { await get().send('/commands', { command }); },
  send: async (url, input) => {
    const project = get().project; if (!project) throw new Error('请先打开项目。');
    set({ busy: true, error: null });
    try { const updated = await request<Project>(`/projects/${project.id}${url}`, { revision: project.revision, ...input }); if (get().project?.id === project.id && updated.revision >= get().project!.revision) set({ project: updated }); set({ busy: false }); return updated; }
    catch (error) { await get().refresh().catch(() => {}); get().fail(error); throw error; }
  },
}));

export function subscribeToBoard(): () => void {
  const events = new EventSource(BASE + '/events');
  let timer: ReturnType<typeof setTimeout> | undefined;
  events.onopen = () => { useBoard.setState({ connection: 'connected' }); void useBoard.getState().refreshList().catch(useBoard.getState().fail); void useBoard.getState().refresh().catch(useBoard.getState().fail); };
  events.onerror = () => useBoard.setState({ connection: 'offline' });
  events.onmessage = (message) => {
    const event = JSON.parse(message.data) as { projectId: string };
    if (event.projectId !== useBoard.getState().project?.id) { void useBoard.getState().refreshList().catch(() => {}); return; }
    clearTimeout(timer); timer = setTimeout(() => void useBoard.getState().refresh().catch(useBoard.getState().fail), 90);
  };
  return () => { clearTimeout(timer); events.close(); };
}
export const assetUrl = (projectId: string, assetId: string) => `${BASE}/projects/${projectId}/assets/${assetId}`;
export const screenshotUrl = (projectId: string, artifactId: string) => `${BASE}/projects/${projectId}/artifacts/${artifactId}/screenshot`;

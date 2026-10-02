export interface Target { id: string; parentId: string | null; kind: 'project' | 'page' | 'component'; label: string; description: string; status: string }
export interface Region { x: number; y: number; width: number; height: number }
export interface Asset { id: string; name: string; mimeType: string; width: number; height: number; sha256: string; extension: string; version: number }
export interface Reference { assetId: string; region: Region | null; purpose: string; ignore: string }
export interface Requirement { id: string; requirementId: string; version: number; targetId: string; text: string; status: 'candidate' | 'confirmed' | 'superseded' | 'rejected'; references: Reference[]; sourceDialogueIds: string[]; supersedesId: string | null; actor: string }
export interface Context { targetId: string; targets: Target[]; requirements: Requirement[]; dialogues: Pick<Dialogue, 'id' | 'question' | 'answer' | 'status'>[]; assets: Asset[]; fingerprint: string; capturedAt: string }
export interface Approval { id: string; kind: string; title: string; message: string; options: string[]; state: string }
export interface Dialogue { id: string; targetId: string; question: string; answer: string; parentIds: string[]; referenceIds?: string[]; status: string; baseCommit: string; branchId: string | null; snapshot?: Context; runId?: string; approvals?: Approval[]; error?: string; session?: { threadId: string; model: string } }
export interface Branch { id: string; name: string; baseCommit: string; headCommit: string; parentDialogueId: string }
export interface Check { passed: boolean; exitCode: number | null; output: string }
export interface Checks { install: Check; build: Check; test: Check | null }
export interface Run { id: string; dialogueId: string; targetId: string; branchId: string; instruction: string; snapshot: Context; deliveredContext?: Context; prompt?: string; status: string; output: string; baseCommit: string; commit?: string; events: Record<string, unknown>[]; approvals: Approval[]; checks: Checks | null; error?: string }
export interface Artifact { id: string; targetId: string; runId: string; branchId: string; dialogueId: string; commit: string; checks: Checks; stale: boolean }
export interface Review { id: string; artifactId: string; result: 'accepted' | 'changes'; note: string; fingerprint: string; requirementIds: string[] }
export interface Relation { id: string; source: string; target: string; kind: string }
export interface Project { id: string; name: string; revision: number; initialCommit: string; currentBranchId: string | null; currentArtifactId: string | null; targets: Target[]; requirements: Requirement[]; dialogues: Dialogue[]; branches: Branch[]; runs: Run[]; assets: Asset[]; artifacts: Artifact[]; reviews: Review[]; relations: Relation[]; layout: { positions: Record<string, { x: number; y: number }>; collapsed: string[]; viewport: { x: number; y: number; zoom: number } }; settings: { previewScript: string | null; outputDirectory: string; buildScript: string; testScript: string | null; model: string | null } }
export interface ProjectSummary { id: string; name: string; revision: number; updatedAt: string }
export interface BoardSelection { kind: 'target' | 'dialogue' | 'requirement' | 'asset' | 'run' | 'artifact'; id: string }
export interface Command { type: string; input: Record<string, unknown> }

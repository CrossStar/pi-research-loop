export type WorkMode = "brainstorming" | "exploration" | "experiment";

export type ExperimentIntent = "reproduction" | "diagnostic" | "exploratory" | "ablation";

export interface ExperimentContext {
  title: string;
  question: string;
  intent: ExperimentIntent;
  plannedDataScope: string;
  reference?: string;
}

export type ArtifactKind = "file" | "dataset";

export interface ArtifactMetadata {
  kind: ArtifactKind;
  path: string;
  name: string;
  extension: string;
  size: number;
  mtimeMs: number;
  discoveredAt: number;
  fileCount?: number;
  fileCountCapped?: boolean;
  samplePath?: string;
}

export interface ResearchState {
  enabled: boolean;
  workMode: WorkMode;
  objective?: string;
  experiment?: ExperimentContext;
  artifacts: ArtifactMetadata[];
}

export type ApprovalKind = "cost-escalation" | "protocol-deviation";

export interface ApprovalRequest {
  kind: ApprovalKind;
  title: string;
  message: string;
  declineReason: string;
}

export interface GateDecision {
  block: boolean;
  reason?: string;
  approval?: ApprovalRequest;
}

export interface ToolGateDecision extends GateDecision {
  terminate?: boolean;
}

export interface StatusProjection {
  text: string;
  tone: "dim" | "success" | "warning" | "accent";
}

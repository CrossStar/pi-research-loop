import type { ResearchMode } from "./governor.js";

export type ArtifactKind = "file" | "dataset";

export interface ArtifactRecord {
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

export type ResearchResultRole = "evidence" | "diagnostic" | "dataset" | "intermediate";

export interface ResearchState {
  mode: ResearchMode;
  artifacts: ArtifactRecord[];
}

export interface CheckpointResult {
  artifact: ArtifactRecord;
  absolutePath: string;
  url: string;
  title: string;
  role: ResearchResultRole;
  description: string;
  takeaway?: string;
  columns?: string[];
  preview?: string;
}

export type ExperimentVariableRole = "independent" | "dependent" | "control" | "derived";

export interface ExperimentVariable {
  name: string;
  role: ExperimentVariableRole;
  description: string;
  value?: string;
}

export interface ExperimentSetupDetail {
  name: string;
  value: string;
  description?: string;
}

export interface ExperimentParameter {
  name: string;
  value: string;
  rationale?: string;
}

export interface ExperimentDetails {
  rationale: string;
  design: string;
  setup: ExperimentSetupDetail[];
  variables: ExperimentVariable[];
  parameters: ExperimentParameter[];
}

export interface CheckpointMetric {
  name: string;
  value: number;
  unit?: string;
  baseline?: number;
  change?: number;
  changeUnit?: string;
  significantDigits?: number;
  note?: string;
}

export interface CheckpointDetails {
  hypothesis: string;
  experiment?: ExperimentDetails;
  observation: string;
  metrics: CheckpointMetric[];
  analysis: string;
  uncertainty: string;
  next: string;
  actionCount: number;
  results: CheckpointResult[];
}

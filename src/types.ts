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
  experiment?: string;
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

export interface ResultTableCell {
  text?: string;
  value?: number;
  unit?: string;
  significantDigits?: number;
}

export interface ExperimentResultTable {
  title?: string;
  columns: string[];
  rows: ResultTableCell[][];
}

export type ExperimentIntent = "reproduction" | "diagnostic" | "exploratory" | "ablation";

export interface ProtocolDeviation {
  field: string;
  reference: string;
  actual: string;
  reason: string;
  approvedByUser: boolean;
}

export interface ExperimentProtocol {
  intent: ExperimentIntent;
  reference?: string;
  dataScope: string;
  deviations: ProtocolDeviation[];
}

export interface CheckpointExperiment extends ExperimentDetails {
  title: string;
  protocol?: ExperimentProtocol;
  observation: string;
  tables: ExperimentResultTable[];
  analysis: string;
}

export interface CheckpointDetails {
  title?: string;
  researchQuestion?: string;
  hypothesis: string;
  experiments?: CheckpointExperiment[];
  overallAnalysis?: string;
  conclusion?: string;
  uncertainty: string;
  next: string;
  actionCount: number;
  results: CheckpointResult[];

  // Retained so checkpoint messages created by older package versions still render.
  experiment?: ExperimentDetails;
  observation?: string;
  metrics?: CheckpointMetric[];
  analysis?: string;
}

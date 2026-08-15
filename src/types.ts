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

export interface CheckpointDetails {
  hypothesis: string;
  observation: string;
  uncertainty: string;
  next: string;
  quantumUsed: number;
  results: CheckpointResult[];
}

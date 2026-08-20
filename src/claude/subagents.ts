import type { ArtifactMetadata, ToolGateDecision, WorkMode } from "../core/types.js";

export type SubagentCapability = "read" | "review";

export interface SubagentDispatch {
  schemaVersion: 1;
  dispatchId: string;
  parentSessionId: string;
  agentType: string;
  description: string;
  objective: string;
  mode: WorkMode;
  capabilities: SubagentCapability[];
  createdAt: number;
}

export interface SubagentLease {
  schemaVersion: 1;
  agentId: string;
  parentSessionId: string;
  agentType: string;
  description: string;
  objective: string;
  mode: WorkMode;
  capabilities: SubagentCapability[];
  active: boolean;
  startedAt: number;
  updatedAt: number;
}

export interface SubagentArtifactEvent {
  schemaVersion: 1;
  kind: "artifact";
  eventId: string;
  agentId: string;
  createdAt: number;
  artifact: ArtifactMetadata;
}

const SUPPORTED_AGENT_TYPES = new Set([
  "explore",
  "research-explorer",
  "research-reviewer",
]);

const READ_ONLY_TOOLS = new Set([
  "read",
  "grep",
  "glob",
  "webfetch",
  "websearch",
  "toolsearch",
]);

const LIFECYCLE_TOOLS = [
  "research_set_enabled",
  "research_mode",
  "research_checkpoint",
  "research_abort_experiment",
];

export function normalizeAgentType(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return value.trim().toLowerCase().split(":").at(-1);
}

export function isAgentTool(toolName: string | undefined): boolean {
  return toolName?.toLowerCase() === "agent";
}

export function isLifecycleTool(toolName: string | undefined): boolean {
  if (!toolName) return false;
  return LIFECYCLE_TOOLS.some((name) => toolName === name || toolName.endsWith(`__${name}`));
}

export function isResearchStateTool(toolName: string | undefined): boolean {
  return Boolean(toolName && (toolName === "research_state" || toolName.endsWith("__research_state")));
}

export function createDispatch(input: {
  dispatchId: string;
  parentSessionId: string;
  mode: WorkMode;
  toolInput?: Record<string, unknown>;
}): SubagentDispatch | ToolGateDecision {
  const agentType = normalizeAgentType(input.toolInput?.subagent_type);
  if (!agentType || !SUPPORTED_AGENT_TYPES.has(agentType)) {
    return {
      block: true,
      reason:
        "Research Loop currently supports only read-only Explore, research-explorer, and research-reviewer subagents.",
    };
  }
  const description = stringValue(input.toolInput?.description) ?? agentType;
  const objective = stringValue(input.toolInput?.prompt) ?? description;
  return {
    schemaVersion: 1,
    dispatchId: input.dispatchId,
    parentSessionId: input.parentSessionId,
    agentType,
    description,
    objective,
    mode: input.mode,
    capabilities: agentType === "research-reviewer" ? ["read", "review"] : ["read"],
    createdAt: Date.now(),
  };
}

export function evaluateSubagentTool(lease: SubagentLease, toolName: string): ToolGateDecision | undefined {
  if (!lease.active) return { block: true, reason: "This research subagent task has ended." };
  if (isLifecycleTool(toolName)) {
    return {
      block: true,
      reason: "Research mode and checkpoint tools can only be called from the main session.",
    };
  }
  if (isResearchStateTool(toolName)) return undefined;
  if (isAgentTool(toolName)) {
    return { block: true, reason: "Return the findings to the main session instead of starting another agent." };
  }
  if (READ_ONLY_TOOLS.has(toolName.toLowerCase())) return undefined;
  return {
    block: true,
    reason: "This research subagent can only read. Use Read, Grep, Glob, or return the task to the main session.",
  };
}

export function subagentPolicy(lease: SubagentLease): string {
  const task = lease.capabilities.includes("review")
    ? "Check the requested method or result against the relevant material and cite the important differences."
    : "Trace only the code and materials needed for the objective and cite useful repository locations.";
  return [
    `[RESEARCH SUBAGENT: ${lease.mode.toUpperCase()}]`,
    `Objective: ${lease.objective}`,
    "Use Read, Grep, Glob, and other read-only lookup tools. Do not edit files, run commands or experiments, or start another agent.",
    task,
    "Return the relevant findings directly.",
  ].join("\n");
}

export function inferAgentId(input: {
  agent_id?: string;
  transcript_path?: string;
  agent_transcript_path?: string;
}): string | undefined {
  if (typeof input.agent_id === "string" && input.agent_id.trim()) return input.agent_id.trim();
  const transcriptPath = input.agent_transcript_path ?? input.transcript_path;
  const match = transcriptPath?.replace(/\\/g, "/").match(/\/subagents\/agent-([^/]+)\.jsonl$/);
  return match?.[1];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

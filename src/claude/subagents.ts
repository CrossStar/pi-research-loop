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
  if (!lease.active) return { block: true, reason: "This Research Subagent lease is no longer active." };
  if (isLifecycleTool(toolName)) {
    return {
      block: true,
      reason: "Research lifecycle tools are parent-owned and cannot be called from a subagent.",
    };
  }
  if (isResearchStateTool(toolName)) return undefined;
  if (isAgentTool(toolName)) {
    return { block: true, reason: "Nested Agent dispatch is not allowed from a Research Subagent." };
  }
  if (READ_ONLY_TOOLS.has(toolName.toLowerCase())) return undefined;
  return {
    block: true,
    reason:
      `Research Subagent ${lease.agentType} has a read-only ${lease.mode} lease. Use Read, Grep, Glob, or return control to the parent agent.`,
  };
}

export function subagentPolicy(lease: SubagentLease): string {
  const review = lease.capabilities.includes("review")
    ? "Review protocol fidelity, source conflicts, evidence quality, and claim boundaries."
    : "Build minimum sufficient understanding with precise repository-relative citations.";
  return [
    `[RESEARCH SUBAGENT | ${lease.mode.toUpperCase()} LEASE]`,
    `Agent: ${lease.agentType}`,
    `Objective: ${lease.objective}`,
    "The parent agent owns Research Loop state, Work Mode, Experiment lifecycle, and Checkpoint decisions.",
    "This lease is read-only. Do not edit files, run shell commands or empirical work, dispatch nested agents, or call lifecycle MCP tools.",
    review,
    "Return a compact result with findings, citations, conflicts or uncertainty, and a recommended next step.",
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

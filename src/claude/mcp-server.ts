#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { resolveArtifactMetadata } from "../core/artifacts.js";
import {
  formatCheckpointReport,
  normalizeCheckpointExperiment,
  validateCheckpoint,
  type CheckpointDetails,
  type PortableCheckpointResult,
} from "../core/checkpoint.js";
import type { ResearchCore } from "../core/research-core.js";
import type { ExperimentContext } from "../core/types.js";
import { ClaudeStateStore } from "./state-store.js";
import {
  claudePluginRoot,
  getClaudeStatusLineStatus,
  installClaudeStatusLine,
  uninstallClaudeStatusLine,
} from "./statusline-config.js";

const VERSION = "0.5.0";
const store = new ClaudeStateStore();
const server = new McpServer({ name: "research-loop", version: VERSION });

const modeSchema = z.enum(["brainstorming", "exploration", "experiment"]);
const intentSchema = z.enum(["reproduction", "diagnostic", "exploratory", "ablation"]);
const sourceSchema = z.object({
  kind: z.enum(["paper", "readme", "issue"]),
  status: z.enum(["consulted", "not-found", "inaccessible"]),
  reference: z.string().optional(),
  summary: z.string().min(1),
});
const deviationSchema = z.object({
  field: z.string().min(1),
  reference: z.string().min(1),
  actual: z.string().min(1),
  reason: z.string().min(1),
  approvedByUser: z.boolean(),
});
const setupSchema = z.object({
  name: z.string().min(1),
  value: z.string(),
  description: z.string().optional(),
});
const variableSchema = z.object({
  name: z.string().min(1),
  role: z.enum(["independent", "dependent", "control", "derived"]),
  description: z.string().min(1),
  value: z.string().optional(),
});
const parameterSchema = z.object({
  name: z.string().min(1),
  value: z.string(),
  rationale: z.string().optional(),
});
const cellSchema = z.object({
  text: z.string().optional(),
  value: z.number().optional(),
  unit: z.string().optional(),
  significantDigits: z.number().int().min(1).max(8).optional(),
}).refine((cell) => cell.text !== undefined || cell.value !== undefined, {
  message: "A result cell requires text or value.",
});
const tableSchema = z.object({
  title: z.string().optional(),
  columns: z.array(z.string()).min(1).max(6),
  rows: z.array(z.array(cellSchema).min(1).max(6)).max(20),
});
const experimentSchema = z.object({
  title: z.string().min(1),
  protocol: z.object({
    intent: intentSchema,
    reference: z.string().optional(),
    dataScope: z.string().min(1),
    sources: z.array(sourceSchema).max(12),
    deviations: z.array(deviationSchema).max(12),
  }),
  rationale: z.string().min(1),
  design: z.string().min(1),
  setup: z.array(setupSchema).max(12).optional(),
  variables: z.array(variableSchema).max(12).optional(),
  parameters: z.array(parameterSchema).max(12).optional(),
  observation: z.string().min(1),
  tables: z.array(tableSchema).max(4).optional(),
  analysis: z.string().min(1),
});
const resultSchema = z.object({
  path: z.string().min(1),
  title: z.string().min(1),
  role: z.enum(["evidence", "diagnostic", "dataset", "intermediate"]),
  description: z.string().min(1),
  takeaway: z.string().optional(),
  columns: z.array(z.string()).max(6).optional(),
  experiment: z.string().optional(),
});

server.registerTool(
  "research_set_enabled",
  {
    title: "Enable or disable Research Loop",
    description: "Enable or disable the session-wide Research Loop state. Enabling always starts in Exploration Mode.",
    inputSchema: { enabled: z.boolean() },
  },
  async ({ enabled }) => {
    const core = await store.loadCore();
    const activeAgentError = await activeSubagentError();
    if (activeAgentError) return finishLifecycle(core, errorResult(activeAgentError));
    if (!enabled && core.workMode === "experiment") {
      return finishLifecycle(core, errorResult(
        "Experiment Mode must end with research_checkpoint or research_abort_experiment before disabling Research Loop.",
      ));
    }
    core.setEnabled(enabled);
    return finishLifecycle(
      core,
      textResult(`${core.projectStatus().text}\n\n${core.policy() ?? "Research Loop is off."}`),
    );
  },
);

server.registerTool(
  "research_mode",
  {
    title: "Select Research Work Mode",
    description:
      "Set the current mode for the main Claude session. Experiment Mode requires title, question, intent, and plannedDataScope and must end through checkpoint or abort.",
    inputSchema: {
      mode: modeSchema,
      objective: z.string().min(1),
      title: z.string().optional(),
      question: z.string().optional(),
      intent: intentSchema.optional(),
      plannedDataScope: z.string().optional(),
      reference: z.string().optional(),
    },
  },
  async (input) => {
    const core = await store.loadCore();
    const activeAgentError = await activeSubagentError();
    if (activeAgentError) return finishLifecycle(core, errorResult(activeAgentError));
    const experiment = experimentFromModeInput(input);
    if (input.mode === "experiment" && !experiment) {
      return finishLifecycle(core, errorResult(
        "Experiment Mode requires title, question, intent, and plannedDataScope before empirical execution.",
      ));
    }
    const decision = core.enterMode(input.mode, input.objective, experiment);
    if (decision.block) {
      return finishLifecycle(core, errorResult(decision.reason ?? "Mode transition rejected."));
    }
    return finishLifecycle(core, textResult(`${core.projectStatus().text}\n\n${core.policy() ?? ""}`));
  },
);

server.registerTool(
  "research_state",
  {
    title: "Read Research Loop state",
    description: "Return the saved Research Loop mode, active experiment, artifacts, and current guidance.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => {
    const core = await store.loadCore();
    const activeSubagents = await store.activeSubagentCount();
    return textResult([
      core.projectStatus().text,
      `Active Research Subagents: ${activeSubagents}`,
      JSON.stringify(core.researchState, null, 2),
      core.policy() ?? "Research Loop is off.",
    ].join("\n\n"));
  },
);

server.registerTool(
  "research_configure_statusline",
  {
    title: "Configure Research Loop Status Line",
    description:
      "Install, inspect, or uninstall the Claude Code Research Loop status line. Installation preserves and composes with an existing command status line. Restart Claude Code after changing it.",
    inputSchema: {
      action: z.enum(["install", "status", "uninstall"]),
    },
    annotations: { destructiveHint: true },
  },
  async ({ action }) => {
    const result = action === "install"
      ? await installClaudeStatusLine(claudePluginRoot(import.meta.url))
      : action === "uninstall"
        ? await uninstallClaudeStatusLine()
        : await getClaudeStatusLineStatus();
    const summary = result.installed ? "INSTALLED" : "NOT INSTALLED";
    const preservation = result.preservesPreviousStatusLine
      ? "The previous command status line is preserved and rendered above Research Loop."
      : "No previous command status line is being composed.";
    return textResult([
      `Research Loop status line: ${summary}`,
      `Claude settings: ${result.settingsPath}`,
      preservation,
      action === "status" ? "" : "Restart Claude Code for the status line setting to take effect.",
    ].filter(Boolean).join("\n"));
  },
);

server.registerTool(
  "research_abort_experiment",
  {
    title: "Abort Research Experiment",
    description:
      "Leave Experiment Mode only when no interpretable empirical evidence was produced. Negative, failed, or diagnostic evidence must be reported with research_checkpoint instead.",
    inputSchema: {
      reason: z.string().min(1),
      noInterpretableEvidence: z.literal(true).describe(
        "Explicit attestation that this phase produced no interpretable evidence of any kind",
      ),
    },
  },
  async ({ reason }) => {
    const core = await store.loadCore();
    const activeAgentError = await activeSubagentError();
    if (activeAgentError) return finishLifecycle(core, errorResult(activeAgentError));
    const decision = core.abortExperiment();
    if (decision.block) return finishLifecycle(core, errorResult(decision.reason ?? "Abort rejected."));
    return finishLifecycle(core, textResult(`Experiment aborted: ${reason}\n\n${core.projectStatus().text}`));
  },
);

server.registerTool(
  "research_checkpoint",
  {
    title: "Reach Research Checkpoint",
    description:
      "Record the completed runs and their results, end the active Experiment, and return Research Loop to Exploration Mode. Reproduction entries must include their reference sources and any changed settings.",
    inputSchema: {
      title: z.string().min(1),
      researchQuestion: z.string().min(1),
      hypothesis: z.string().min(1),
      experiments: z.array(experimentSchema).min(1).max(6),
      overallAnalysis: z.string().min(1),
      conclusion: z.string().optional(),
      uncertainty: z.string().min(1),
      next: z.string().min(1),
      results: z.array(resultSchema).max(8).optional(),
    },
  },
  async (input) => {
    const core = await store.loadCore();
    const activeAgentError = await activeSubagentError();
    if (activeAgentError) return finishLifecycle(core, errorResult(activeAgentError));
    if (core.workMode !== "experiment") {
      return finishLifecycle(core, errorResult("research_checkpoint is available only in Experiment Mode."));
    }

    const results: PortableCheckpointResult[] = [];
    for (const requested of input.results ?? []) {
      const artifact = await resolveArtifactMetadata(store.cwd, requested.path);
      if (artifact) core.upsertArtifact(artifact);
      results.push({ ...requested, artifact });
    }
    const details: CheckpointDetails = {
      title: input.title,
      researchQuestion: input.researchQuestion,
      hypothesis: input.hypothesis,
      experiments: input.experiments.map((experiment) =>
        normalizeCheckpointExperiment(experiment, input.hypothesis),
      ),
      overallAnalysis: input.overallAnalysis,
      conclusion: input.conclusion,
      uncertainty: input.uncertainty,
      next: input.next,
      results,
    };
    const validation = validateCheckpoint(details);
    if (!validation.valid) {
      return finishLifecycle(core, errorResult(validation.errors.join("\n")));
    }

    core.reachCheckpoint(results.length);
    const warnings = validation.warnings.length > 0
      ? `\n\n## Protocol Warnings\n\n${validation.warnings.map((warning) => `- ${warning}`).join("\n")}`
      : "";
    return finishLifecycle(core, textResult(`${formatCheckpointReport(details)}${warnings}`));
  },
);

async function activeSubagentError(): Promise<string | undefined> {
  const count = await store.activeSubagentCount();
  return count > 0
    ? `Wait for ${count} active research subagent${count === 1 ? "" : "s"} to finish before changing Research Loop state.`
    : undefined;
}

async function finishLifecycle<T>(core: ResearchCore, result: T): Promise<T> {
  core.completeLifecycleTransition();
  await store.saveCore(core);
  return result;
}

function experimentFromModeInput(input: {
  mode: z.infer<typeof modeSchema>;
  title?: string;
  question?: string;
  intent?: z.infer<typeof intentSchema>;
  plannedDataScope?: string;
  reference?: string;
}): ExperimentContext | undefined {
  if (
    input.mode !== "experiment"
    || !input.title
    || !input.question
    || !input.intent
    || !input.plannedDataScope
  ) return undefined;
  return {
    title: input.title,
    question: input.question,
    intent: input.intent,
    plannedDataScope: input.plannedDataScope,
    reference: input.reference,
  };
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function errorResult(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

await server.connect(new StdioServerTransport());

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Container, Image, Text } from "@earendil-works/pi-tui";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Type } from "typebox";
import {
  formatSize,
  loadArtifactPreview,
  resolveArtifactRecord,
  type ArtifactRecord,
  type ArtifactPreview,
} from "./artifacts.js";
import {
  formatCheckpointReport as formatCoreCheckpointReport,
  formatExperimentDetails,
  formatProtocolDeviations,
  formatProtocolSources,
  formatResultTable,
  normalizeCheckpointExperiment as normalizeCoreCheckpointExperiment,
} from "./core/checkpoint.js";

export type ResearchResultRole = "evidence" | "diagnostic" | "dataset" | "intermediate";
export type ExperimentVariableRole = "independent" | "dependent" | "control" | "derived";
export type ExperimentIntent = "reproduction" | "diagnostic" | "exploratory" | "ablation";
export type ProtocolSourceKind = "paper" | "readme" | "issue";
export type ProtocolSourceStatus = "consulted" | "not-found" | "inaccessible";

export interface CheckpointResultInput {
  path: string;
  title: string;
  role: ResearchResultRole;
  description: string;
  takeaway?: string;
  columns?: string[];
  experiment?: string;
}

export interface CheckpointResult {
  path: string;
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
  image?: ArtifactPreview["image"];
}

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

export interface ProtocolDeviation {
  field: string;
  reference: string;
  actual: string;
  reason: string;
  approvedByUser: boolean;
}

export interface ProtocolSource {
  kind: ProtocolSourceKind;
  status: ProtocolSourceStatus;
  reference?: string;
  summary: string;
}

export interface ExperimentProtocol {
  intent: ExperimentIntent;
  reference?: string;
  dataScope: string;
  sources: ProtocolSource[];
  deviations: ProtocolDeviation[];
}

export interface CheckpointExperiment {
  title: string;
  protocol: ExperimentProtocol;
  rationale: string;
  design: string;
  setup: ExperimentSetupDetail[];
  variables: ExperimentVariable[];
  parameters: ExperimentParameter[];
  observation: string;
  tables: ExperimentResultTable[];
  analysis: string;
}

export interface CheckpointDetails {
  title: string;
  researchQuestion: string;
  hypothesis: string;
  experiments: CheckpointExperiment[];
  overallAnalysis: string;
  conclusion?: string;
  uncertainty: string;
  next: string;
  results: CheckpointResult[];
}

interface CheckpointDependencies {
  getArtifacts: () => ArtifactRecord[];
  onReached: (resultCount: number, ctx: ExtensionContext) => void;
}

export function registerResearchCheckpoint(
  pi: ExtensionAPI,
  dependencies: CheckpointDependencies,
): void {
  pi.registerTool({
    name: "research_checkpoint",
    label: "Research Checkpoint",
    description:
      "Record at least one completed empirical run, end the active Experiment, and return Research Loop to Normal Mode. Reproduction entries must include the official paper, matching repository README, relevant issue status, actual settings, and any changes from the reference. Call this alone as the final tool action.",
    promptSnippet: "Record completed experiment results and return to Normal Mode",
    promptGuidelines: [
      "For a reproduction, consult the official paper (including appendix or supplement), the README for the matching repository revision, and relevant open or closed issues before execution. Record what each source contributed, the settings actually used, and every approved or unapproved change from the reference.",
    ],
    parameters: Type.Object({
      title: Type.String({ description: "Concise finding-oriented checkpoint title, without the 'Checkpoint:' prefix" }),
      researchQuestion: Type.String({ description: "Research question and the distinction this interval is trying to resolve" }),
      hypothesis: Type.String({ description: "Current working hypothesis after considering this interval's evidence" }),
      experiments: Type.Array(
        Type.Object({
          title: Type.String({ description: "Short experiment name, without numbering" }),
          protocol: Type.Object({
            intent: StringEnum(["reproduction", "diagnostic", "exploratory", "ablation"] as const, {
              description: "Scientific intent. A diagnostic cannot be presented as reproduction evidence.",
            }),
            reference: Type.Optional(Type.String({ description: "Reference paper, official run, baseline, or protocol being followed" })),
            dataScope: Type.String({ description: "Actual dataset, split, sample count, and sampling scope used" }),
            sources: Type.Array(
              Type.Object({
                kind: StringEnum(["paper", "readme", "issue"] as const, {
                  description: "Reproduction source category",
                }),
                status: StringEnum(["consulted", "not-found", "inaccessible"] as const, {
                  description: "Whether the source was reviewed or why it was unavailable",
                }),
                reference: Type.Optional(Type.String({ description: "Exact paper citation/URL, README revision/path, or issue URL/number" })),
                summary: Type.String({ description: "Protocol guidance, correction, known bug, conflict, or documented search outcome" }),
              }),
              {
                maxItems: 12,
                description: "Sources checked for this experiment. Reproductions require paper, README, and issue-search coverage.",
              },
            ),
            deviations: Type.Array(
              Type.Object({
                field: Type.String({ description: "Protocol field that differs, such as sample count, split, model, preprocessing, or seeds" }),
                reference: Type.String({ description: "Reference protocol value" }),
                actual: Type.String({ description: "Value actually used" }),
                reason: Type.String({ description: "Why the deviation was made and what it limits" }),
                approvedByUser: Type.Boolean({ description: "Whether the user explicitly approved this deviation before execution" }),
              }),
              { maxItems: 12, description: "All deviations from the referenced protocol; empty only when none exist" },
            ),
          }),
          rationale: Type.String({ description: "Why this experiment was needed in the research sequence" }),
          design: Type.String({ description: "Self-contained narrative of conditions, controls, sample, and comparison" }),
          setup: Type.Optional(
            Type.Array(
              Type.Object({
                name: Type.String({ description: "Essential setup component such as model, dataset, loss, optimizer, or evaluation protocol" }),
                value: Type.String({ description: "Component choice or configuration" }),
                description: Type.Optional(Type.String({ description: "Why this detail matters" })),
              }),
              { maxItems: 12, description: "Essential experiment context, excluding infrastructure" },
            ),
          ),
          variables: Type.Optional(
            Type.Array(
              Type.Object({
                name: Type.String({ description: "Variable name" }),
                role: StringEnum(["independent", "dependent", "control", "derived"] as const),
                description: Type.String({ description: "What the variable represents" }),
                value: Type.Optional(Type.String({ description: "Fixed value, levels, or range" })),
              }),
              { maxItems: 12, description: "Variables necessary to interpret the experiment" },
            ),
          ),
          parameters: Type.Optional(
            Type.Array(
              Type.Object({
                name: Type.String({ description: "Experiment hyperparameter name" }),
                value: Type.String({ description: "Value used" }),
                rationale: Type.Optional(Type.String({ description: "Why this value matters" })),
              }),
              {
                maxItems: 12,
                description: "Experiment-only hyperparameters. Exclude Slurm, queue, allocation, logging, and orchestration settings.",
              },
            ),
          ),
          observation: Type.String({ description: "Observed result before interpretation" }),
          tables: Type.Optional(
            Type.Array(
              Type.Object({
                title: Type.Optional(Type.String({ description: "Short table title or lead-in" })),
                columns: Type.Array(Type.String(), { minItems: 1, maxItems: 6 }),
                rows: Type.Array(
                  Type.Array(
                    Type.Object({
                      text: Type.Optional(Type.String({ description: "Text cell; use when the cell is not numeric" })),
                      value: Type.Optional(Type.Number({ description: "Numeric cell value" })),
                      unit: Type.Optional(Type.String({ description: "Optional unit appended to a numeric value" })),
                      significantDigits: Type.Optional(
                        Type.Integer({ minimum: 1, maximum: 8, description: "Significant digits justified by the measurement" }),
                      ),
                    }),
                    { minItems: 1, maxItems: 6 },
                  ),
                  { maxItems: 20 },
                ),
              }),
              { maxItems: 4, description: "Structured result tables rendered directly in the terminal" },
            ),
          ),
          analysis: Type.String({ description: "Interpretation, causal limits, and what this experiment adds" }),
        }),
        { minItems: 1, maxItems: 6, description: "Key empirical experiments actually completed in this interval, in execution order" },
      ),
      overallAnalysis: Type.String({ description: "Synthesis across experiments and how the evidence updates the hypothesis" }),
      conclusion: Type.Optional(Type.String({ description: "Strongest conclusion currently justified, stated in one compact passage" })),
      uncertainty: Type.String({ description: "Unresolved confounders, limitations, and generalization gaps" }),
      next: Type.String({ description: "Concrete next experiment or user decision, including secondary priority when useful" }),
      results: Type.Optional(
        Type.Array(
          Type.Object({
            path: Type.String({ description: "Path to a result file or dataset directory" }),
            title: Type.String({ description: "Human-readable artifact title" }),
            role: StringEnum(["evidence", "diagnostic", "dataset", "intermediate"] as const, {
              description: "How this artifact participates in the checkpoint",
            }),
            description: Type.String({ description: "Why this artifact exists and how it relates to the evidence" }),
            takeaway: Type.Optional(Type.String({ description: "What the user should notice" })),
            columns: Type.Optional(Type.Array(Type.String(), { maxItems: 6, description: "Relevant preview columns" })),
            experiment: Type.Optional(Type.String({ description: "Exact experiment title this artifact belongs to" })),
          }),
          { maxItems: 8, description: "Curated artifacts only; omit files whose purpose is not understood" },
        ),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const results = await prepareCheckpointResults(pi, ctx, dependencies.getArtifacts(), params.results);
      const experiments = params.experiments.map((experiment) =>
        normalizeCheckpointExperiment(experiment, params.hypothesis),
      );
      const details: CheckpointDetails = {
        title: params.title,
        researchQuestion: params.researchQuestion,
        hypothesis: params.hypothesis,
        experiments,
        overallAnalysis: params.overallAnalysis,
        conclusion: params.conclusion,
        uncertainty: params.uncertainty,
        next: params.next,
        results,
      };
      dependencies.onReached(results.length, ctx);
      return {
        content: [{ type: "text" as const, text: formatCheckpointReport(details) }],
        details,
        terminate: true,
      };
    },
    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("Research Checkpoint")), 0, 0);
    },
    renderResult(result, _options, theme) {
      const details = result.details as CheckpointDetails | undefined;
      if (!details) return new Text("Research checkpoint reached.", 0, 0);
      return renderCheckpoint(details, theme);
    },
  });
}

export function normalizeCheckpointExperiment(
  experiment: Omit<CheckpointExperiment, "setup" | "variables" | "parameters" | "tables"> &
    Partial<Pick<CheckpointExperiment, "setup" | "variables" | "parameters" | "tables">>,
  hypothesis: string,
): CheckpointExperiment {
  return normalizeCoreCheckpointExperiment(experiment, hypothesis);
}

export function formatCheckpointReport(details: CheckpointDetails): string {
  return formatCoreCheckpointReport(details);
}

async function prepareCheckpointResults(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  discovered: ArtifactRecord[],
  requestedResults: CheckpointResultInput[] | undefined,
): Promise<CheckpointResult[]> {
  const results: CheckpointResult[] = [];
  for (const requested of requestedResults ?? []) {
    const resolvedRecord = await resolveArtifactRecord(ctx.cwd, requested.path);
    if (!resolvedRecord) continue;
    const absolutePath = resolve(ctx.cwd, resolvedRecord.path);
    const artifact = discovered.find((candidate) => resolve(ctx.cwd, candidate.path) === absolutePath) ?? resolvedRecord;
    const result: CheckpointResult = {
      path: artifact.path,
      artifact,
      absolutePath,
      url: pathToFileURL(absolutePath).href,
      title: requested.title,
      role: requested.role,
      description: requested.description,
      takeaway: requested.takeaway,
      columns: requested.columns,
      experiment: requested.experiment,
    };
    if (requested.role !== "intermediate") {
      try {
        const preview = await loadArtifactPreview(pi, ctx.cwd, artifact, requested.columns);
        result.preview = preview.image ? undefined : preview.text;
        result.image = preview.image;
      } catch {
        // The semantic description and file link remain useful without a preview.
      }
    }
    results.push(result);
  }
  return results;
}

function renderCheckpoint(details: CheckpointDetails, theme: Theme): Container {
  const container = new Container();
  const appendResult = (result: CheckpointResult, index: number) => {
    const semantics = [
      `${theme.fg("muted", result.role.toUpperCase())} | ${result.description}`,
      result.takeaway ? `${theme.fg("success", "Takeaway")} ${result.takeaway}` : undefined,
      terminalLink(result.url, `${result.artifact.name} (${formatSize(result.artifact.size)})`),
      theme.fg("muted", result.absolutePath),
    ].filter((line): line is string => Boolean(line));
    container.addChild(new Text(`${theme.bold(`${index + 1}. ${result.title}`)}\n${semantics.join("\n")}`, 0, 1));
    if (result.image) {
      container.addChild(
        new Image(result.image.data, result.image.mimeType, { fallbackColor: (value) => theme.fg("muted", value) }, {
          maxWidthCells: 72,
          maxHeightCells: 24,
          filename: result.artifact.name,
        }),
      );
    } else if (result.preview) container.addChild(new Text(result.preview, 0, 1));
  };

  container.addChild(new Text(theme.fg("accent", theme.bold(`Checkpoint: ${details.title}`)), 0, 0));
  container.addChild(new Text(theme.fg("accent", theme.bold("Research Question")), 0, 1));
  container.addChild(new Text([details.researchQuestion, "", theme.bold("Working hypothesis"), details.hypothesis].join("\n"), 0, 0));
  container.addChild(new Text(theme.fg("accent", theme.bold("Condition & Result")), 0, 1));

  details.experiments.forEach((experiment, experimentIndex) => {
    container.addChild(
      new Text(
        [
          theme.fg("accent", theme.bold(`Experiment ${experimentIndex + 1} - ${experiment.title}`)),
          experiment.rationale,
          "",
          experiment.design,
        ].join("\n"),
        0,
        1,
      ),
    );
    const experimentDetails = formatExperimentDetails(experiment);
    if (experimentDetails) container.addChild(new Text(`${theme.bold("Experimental Details")}\n${experimentDetails}`, 0, 1));
    const protocolSources = formatProtocolSources(experiment);
    if (protocolSources) container.addChild(new Text(`${theme.bold("Reference Sources")}\n${protocolSources}`, 0, 1));
    const protocolDeviations = formatProtocolDeviations(experiment);
    if (protocolDeviations) {
      container.addChild(new Text(`${theme.fg("warning", theme.bold("Protocol Deviations"))}\n${protocolDeviations}`, 0, 1));
    }
    container.addChild(new Text(experiment.observation, 0, 1));
    experiment.tables.forEach((table) => {
      const title = table.title ? `${theme.bold(table.title)}\n` : "";
      container.addChild(new Text(`${title}${formatResultTable(table)}`, 0, 1));
    });
    container.addChild(new Text(experiment.analysis, 0, 1));
    details.results.filter((result) => result.experiment === experiment.title).forEach(appendResult);
  });

  const experimentTitles = new Set(details.experiments.map((experiment) => experiment.title));
  const unassignedResults = details.results.filter(
    (result) => !result.experiment || !experimentTitles.has(result.experiment),
  );
  if (unassignedResults.length > 0) {
    container.addChild(new Text(theme.fg("accent", theme.bold("Additional Evidence")), 0, 1));
    unassignedResults.forEach(appendResult);
  }

  container.addChild(new Text(theme.fg("accent", theme.bold("Overall Analysis")), 0, 1));
  container.addChild(
    new Text(
      [details.overallAnalysis, details.conclusion ? `\n> ${details.conclusion}` : undefined]
        .filter((line): line is string => Boolean(line))
        .join("\n"),
      0,
      0,
    ),
  );
  container.addChild(new Text(theme.fg("warning", theme.bold("Uncertainty")), 0, 1));
  container.addChild(new Text(details.uncertainty, 0, 0));
  container.addChild(new Text(theme.fg("accent", theme.bold("Next")), 0, 1));
  container.addChild(new Text(details.next, 0, 0));

  if (details.results.length > 0) {
    const links = details.results.map((result) => `- ${terminalLink(result.url, result.artifact.path)}`);
    container.addChild(new Text(`${theme.fg("accent", theme.bold("Relevant Artifacts"))}\n${links.join("\n")}`, 0, 1));
  }
  return container;
}

function terminalLink(url: string, label: string): string {
  return `\u001b]8;;${url}\u001b\\${label}\u001b]8;;\u001b\\`;
}

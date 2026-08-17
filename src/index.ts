import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Image, Key, matchesKey, Text } from "@earendil-works/pi-tui";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Type } from "typebox";
import { ArtifactRadar, formatSize, loadArtifactPreview, resolveArtifactRecord } from "./artifacts.js";
import { evaluateFastCommand, researchPolicy, type ResearchMode } from "./governor.js";
import { formatSignificant, formatTable } from "./table.js";
import type {
  ArtifactRecord,
  CheckpointDetails,
  CheckpointExperiment,
  CheckpointMetric,
  CheckpointResult,
  ExperimentDetails,
  ExperimentParameter,
  ExperimentResultTable,
  ExperimentSetupDetail,
  ExperimentVariable,
  ResultTableCell,
  ResearchResultRole,
  ResearchState,
} from "./types.js";

const STATE_ENTRY = "research-loop-state";
const POLICY_MESSAGE = "research-loop-policy";
const CHECKPOINT_REVIEW_INTERVAL = 6;

interface CheckpointResultInput {
  path: string;
  title: string;
  role: ResearchResultRole;
  description: string;
  takeaway?: string;
  columns?: string[];
  experiment?: string;
}

export default function researchLoop(pi: ExtensionAPI): void {
  let state: ResearchState = { mode: "off", artifacts: [] };
  let roundActions = 0;
  let nextCheckpointReviewAt = CHECKPOINT_REVIEW_INTERVAL;
  let checkpointReviewPending = false;
  let checkpointReviewRaisedThisTurn = false;
  let checkpointReached = false;
  let checkpointResultCount = 0;
  let toolCallsThisTurn = 0;
  let checkpointAccepted = false;
  let currentUserPrompt = "";
  const checkpointImages = new Map<string, { data: string; mimeType: string }>();
  let radar: ArtifactRadar | undefined;
  let activeContext: ExtensionContext | undefined;

  function resetRound(): void {
    roundActions = 0;
    nextCheckpointReviewAt = CHECKPOINT_REVIEW_INTERVAL;
    checkpointReviewPending = false;
    checkpointReviewRaisedThisTurn = false;
    checkpointReached = false;
    checkpointResultCount = 0;
  }

  function setCheckpointToolActive(mode: ResearchMode): void {
    const active = pi.getActiveTools();
    if (mode === "off") {
      pi.setActiveTools(active.filter((name) => name !== "research_checkpoint"));
    } else if (!active.includes("research_checkpoint")) {
      pi.setActiveTools([...active, "research_checkpoint"]);
    }
  }

  function updateStatus(ctx: ExtensionContext): void {
    let text: string;
    let color: "dim" | "success" | "warning" | "accent";

    if (state.mode === "off") {
      text = "RESEARCH OFF";
      color = "dim";
    } else if (checkpointReached) {
      text = `RESEARCH ${state.mode.toUpperCase()} | CHECKPOINT REACHED | RESULTS ${checkpointResultCount}`;
      color = "success";
    } else {
      const parts = [
        `RESEARCH ${state.mode.toUpperCase()}`,
        `ACTIONS ${roundActions}`,
        checkpointReviewPending ? "CHECKPOINT REVIEW" : undefined,
        `OUTPUTS ${state.artifacts.length}`,
      ].filter((part): part is string => Boolean(part));
      text = parts.join(" | ");
      color = checkpointReviewPending ? "warning" : state.mode === "fast" ? "success" : "accent";
    }

    ctx.ui.setStatus("research-loop", undefined);
    ctx.ui.setWidget(
      "research-loop-status",
      [ctx.ui.theme.fg(color, text)],
      { placement: "belowEditor" },
    );
  }

  function persistState(): void {
    pi.appendEntry(STATE_ENTRY, {
      mode: state.mode,
      artifacts: state.artifacts,
    } satisfies ResearchState);
  }

  function changeMode(mode: ResearchMode, ctx: ExtensionContext): void {
    state.mode = mode;
    resetRound();
    setCheckpointToolActive(mode);
    persistState();
    updateStatus(ctx);
    ctx.ui.notify(`Research mode: ${mode.toUpperCase()}`, "info");
  }

  async function prepareCheckpointResults(
    requestedResults: CheckpointResultInput[] | undefined,
    ctx: ExtensionContext,
  ): Promise<CheckpointResult[]> {
    const discovered = radar?.getArtifacts() ?? state.artifacts;
    const results: CheckpointResult[] = [];

    for (const requested of requestedResults ?? []) {
      const resolvedRecord = await resolveArtifactRecord(ctx.cwd, requested.path);
      if (!resolvedRecord) continue;
      const absolutePath = resolve(ctx.cwd, resolvedRecord.path);
      const record =
        discovered.find((candidate) => resolve(ctx.cwd, candidate.path) === absolutePath) ?? resolvedRecord;
      const result: CheckpointResult = {
        artifact: record,
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
          const preview = await loadArtifactPreview(ctx.cwd, record, requested.columns);
          if (preview.image) checkpointImages.set(checkpointImageKey(record), preview.image);
          else result.preview = preview.text;

          if (record.extension === ".parquet") {
            const samplePath = resolve(ctx.cwd, record.samplePath ?? record.path);
            const parquetPreview = await previewParquet(pi, samplePath, requested.columns, record.kind === "dataset");
            if (parquetPreview) result.preview = `${preview.text}\n\n${parquetPreview}`;
          }
        } catch {
          // Semantic context and the result link remain available without a preview.
        }
      }
      results.push(result);
    }
    return results;
  }

  pi.registerTool({
    name: "research_checkpoint",
    label: "Research Checkpoint",
    description:
      "End the current research interval with a report-style checkpoint. Cover all key experiments completed since the previous checkpoint or user calibration, each with its own condition, structured result tables, analysis, and linked artifacts. Then synthesize overall analysis, uncertainty, and next actions. Exclude Slurm and infrastructure settings unless systems behavior is under study. Call this alone as the final tool action.",
    promptSnippet: "End a research interval with a multi-experiment report and return control",
    promptGuidelines: [
      "Write a report-style checkpoint with Research Question, Condition & Result, Overall Analysis, Uncertainty, Next, and Relevant Artifacts. Include every key experiment completed since the previous checkpoint, in execution order. Use structured tables for quantitative comparisons and associate artifacts with the experiment they support. Do not report Slurm or infrastructure parameters unless the research question studies systems behavior.",
    ],
    parameters: Type.Object({
      title: Type.String({ description: "Concise finding-oriented checkpoint title, without the 'Checkpoint:' prefix" }),
      researchQuestion: Type.String({ description: "Research question and the distinction this interval is trying to resolve" }),
      hypothesis: Type.String({ description: "Current working hypothesis after considering this interval's evidence" }),
      experiments: Type.Optional(
        Type.Array(
          Type.Object({
            title: Type.String({ description: "Short experiment name, without numbering" }),
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
          { minItems: 1, maxItems: 6, description: "Key experiments completed in this interval, in execution order" },
        ),
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
      const results = await prepareCheckpointResults(params.results, ctx);
      const experiments = (params.experiments ?? []).map((experiment) =>
        sanitizeCheckpointExperiment(
          {
            ...experiment,
            setup: experiment.setup ?? [],
            variables: experiment.variables ?? [],
            parameters: experiment.parameters ?? [],
            tables: experiment.tables ?? [],
          },
          params.hypothesis,
        ),
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
        actionCount: roundActions,
        results,
      };
      checkpointReached = true;
      checkpointResultCount = results.length;
      checkpointReviewPending = false;
      updateStatus(ctx);
      persistState();
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

      const container = new Container();
      const appendResult = (researchResult: CheckpointResult, index: number) => {
        const artifact = researchResult.artifact;
        const label = `${index + 1}. ${researchResult.title}`;
        const semantics = [
          `${theme.fg("muted", researchResult.role.toUpperCase())} | ${researchResult.description}`,
          researchResult.takeaway ? `${theme.fg("success", "Takeaway")} ${researchResult.takeaway}` : undefined,
          terminalLink(researchResult.url, `${artifact.name} (${formatSize(artifact.size)})`),
          theme.fg("muted", researchResult.absolutePath),
        ].filter((line): line is string => Boolean(line));
        container.addChild(new Text(`${theme.bold(label)}\n${semantics.join("\n")}`, 0, 1));

        const image = checkpointImages.get(checkpointImageKey(artifact)) ?? radar?.getCachedImage(artifact);
        if (image) {
          container.addChild(
            new Image(image.data, image.mimeType, { fallbackColor: (value) => theme.fg("muted", value) }, {
              maxWidthCells: 72,
              maxHeightCells: 24,
              filename: artifact.name,
            }),
          );
        } else if (researchResult.preview) {
          container.addChild(new Text(researchResult.preview, 0, 1));
        }
      };

      if (details.researchQuestion || details.experiments) {
        const experiments = details.experiments ?? [];
        const results = details.results ?? [];
        container.addChild(new Text(theme.fg("accent", theme.bold(`Checkpoint: ${details.title ?? "Research Update"}`)), 0, 0));
        container.addChild(new Text(theme.fg("accent", theme.bold("Research Question")), 0, 1));
        container.addChild(
          new Text(
            [details.researchQuestion ?? "", "", theme.bold("Working hypothesis"), details.hypothesis].join("\n"),
            0,
            0,
          ),
        );

        if (experiments.length > 0) {
          container.addChild(new Text(theme.fg("accent", theme.bold("Condition & Result")), 0, 1));
        }
        experiments.forEach((experiment, experimentIndex) => {
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
          if (experimentDetails) {
            container.addChild(new Text(`${theme.bold("Experimental Details")}\n${experimentDetails}`, 0, 1));
          }
          container.addChild(new Text(experiment.observation, 0, 1));
          experiment.tables.forEach((table) => {
            const title = table.title ? `${theme.bold(table.title)}\n` : "";
            container.addChild(new Text(`${title}${formatResultTable(table)}`, 0, 1));
          });
          container.addChild(new Text(experiment.analysis, 0, 1));
          results
            .filter((researchResult) => researchResult.experiment === experiment.title)
            .forEach(appendResult);
        });

        const experimentTitles = new Set(experiments.map((experiment) => experiment.title));
        const unassignedResults = results.filter(
          (researchResult) => !researchResult.experiment || !experimentTitles.has(researchResult.experiment),
        );
        if (unassignedResults.length > 0) {
          container.addChild(new Text(theme.fg("accent", theme.bold("Additional Evidence")), 0, 1));
          unassignedResults.forEach(appendResult);
        }

        container.addChild(new Text(theme.fg("accent", theme.bold("Overall Analysis")), 0, 1));
        container.addChild(
          new Text(
            [details.overallAnalysis ?? "", details.conclusion ? `\n> ${details.conclusion}` : undefined]
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

        if (results.length > 0) {
          const links = results.map((researchResult) =>
            `- ${terminalLink(researchResult.url, researchResult.artifact.path)}`,
          );
          container.addChild(
            new Text(`${theme.fg("accent", theme.bold("Relevant Artifacts"))}\n${links.join("\n")}`, 0, 1),
          );
        }
        return container;
      }

      const sections = [
        theme.fg("accent", theme.bold("Hypothesis")),
        details.hypothesis,
      ];

      if (details.experiment) {
        sections.push(
          "",
          theme.fg("accent", theme.bold("Why This Experiment")),
          details.experiment.rationale,
          "",
          theme.fg("accent", theme.bold("Experimental Design")),
          details.experiment.design,
          "",
          theme.fg("accent", theme.bold("Experimental Setup")),
          formatSetupTable(details.experiment.setup ?? []),
          "",
          theme.fg("accent", theme.bold("Key Variables")),
          formatVariableTable(details.experiment.variables),
          "",
          theme.fg("accent", theme.bold("Experiment Hyperparameters")),
          formatParameterTable(details.experiment.parameters),
        );
      }

      sections.push(
        "",
        theme.fg("success", theme.bold("Main Result")),
        details.observation ?? "",
      );
      if ((details.metrics ?? []).length > 0) {
        sections.push("", theme.fg("success", theme.bold("Headline Metrics")), formatMetricTable(details.metrics ?? []));
      }
      if (details.analysis) {
        sections.push("", theme.fg("accent", theme.bold("Analysis")), details.analysis);
      }
      sections.push(
        "",
        theme.fg("warning", theme.bold("Uncertainty")),
        details.uncertainty,
        "",
        theme.fg("accent", theme.bold("Next")),
        details.next,
      );
      container.addChild(new Text(sections.join("\n"), 0, 0));

      const results = details.results ?? [];
      if (results.length > 0) {
        container.addChild(new Text(theme.fg("accent", theme.bold("Curated Results")), 0, 1));
        results.forEach(appendResult);
      }
      return container;
    },
  });

  pi.registerCommand("research", {
    description: "Set research mode: fast, normal, or off",
    getArgumentCompletions(prefix) {
      const modes = ["fast", "normal", "off"];
      return modes.filter((mode) => mode.startsWith(prefix)).map((mode) => ({ value: mode, label: mode }));
    },
    handler: async (args, ctx) => {
      const mode = args.trim().toLowerCase();
      if (mode === "fast" || mode === "normal" || mode === "off") {
        changeMode(mode, ctx);
        return;
      }
      ctx.ui.notify(`Current mode: ${state.mode.toUpperCase()}. Usage: /research fast|normal|off`, "info");
    },
  });

  pi.registerCommand("artifacts", {
    description: "List and preview artifacts from the current research session",
    handler: async (_args, ctx) => {
      const artifacts = radar?.getArtifacts() ?? state.artifacts;
      if (artifacts.length === 0) {
        ctx.ui.notify("No research artifacts discovered in this session.", "info");
        return;
      }

      const labels = artifacts.map((artifact, index) => {
        const summary = artifact.kind === "dataset"
          ? `${artifact.fileCountCapped ? ">=" : ""}${artifact.fileCount ?? 0} files, ${formatSize(artifact.size)} sampled`
          : formatSize(artifact.size);
        return `${index + 1}. ${artifact.name} [${artifact.kind}] (${summary}) - ${artifact.path}`;
      });

      if (ctx.mode !== "tui") {
        ctx.ui.notify(labels.join("\n"), "info");
        return;
      }

      const selected = await ctx.ui.select("Research artifacts", labels);
      if (!selected) return;
      const index = Number.parseInt(selected, 10) - 1;
      const artifact = artifacts[index];
      if (!artifact) return;

      try {
        const preview = await loadArtifactPreview(ctx.cwd, artifact);
        await ctx.ui.custom<void>((_tui, theme, _keybindings, done) => {
          const container = new Container();
          container.addChild(new Text(theme.fg("accent", theme.bold(preview.title)), 0, 0));
          container.addChild(new Text(preview.text, 0, 1));
          if (preview.image) {
            container.addChild(
              new Image(
                preview.image.data,
                preview.image.mimeType,
                { fallbackColor: (text) => theme.fg("muted", text) },
                { maxWidthCells: 80, maxHeightCells: 28, filename: artifact.name },
              ),
            );
          }
          container.addChild(new Text(theme.fg("dim", "Enter/Esc to close"), 0, 1));

          return {
            render: (width) => container.render(width),
            invalidate: () => container.invalidate(),
            handleInput: (data) => {
              if (matchesKey(data, Key.enter) || matchesKey(data, Key.escape)) done(undefined);
            },
          };
        });
      } catch (error) {
        ctx.ui.notify(`Could not preview ${artifact.path}: ${String(error)}`, "warning");
      }
    },
  });

  pi.on("session_start", (_event, ctx) => {
    activeContext = ctx;
    resetRound();
    checkpointImages.clear();

    const latestState = ctx.sessionManager
      .getBranch()
      .filter((entry) => entry.type === "custom" && entry.customType === STATE_ENTRY)
      .at(-1) as { data?: ResearchState } | undefined;
    if (latestState?.data) {
      state = {
        mode: latestState.data.mode ?? "off",
        artifacts: latestState.data.artifacts ?? [],
      };
    }

    radar?.stop();
    radar = new ArtifactRadar(ctx.cwd, state.artifacts, (artifact, isNew) => {
      state.artifacts = radar?.getArtifacts() ?? state.artifacts;
      persistState();
      if (activeContext) updateStatus(activeContext);
      const summary = artifact.kind === "dataset"
        ? `${artifact.fileCount ?? 0} ${artifact.extension.slice(1).toUpperCase()} files`
        : formatSize(artifact.size);
      activeContext?.ui.notify(
        `${isNew ? "Indexed" : "Updated"} ${artifact.kind}: ${artifact.path} (${summary})`,
        "info",
      );
    });

    try {
      radar.start();
    } catch (error) {
      ctx.ui.notify(`Artifact Radar unavailable: ${String(error)}`, "warning");
    }

    setCheckpointToolActive(state.mode);
    updateStatus(ctx);
  });

  pi.on("session_shutdown", () => {
    radar?.stop();
    radar = undefined;
    activeContext = undefined;
  });

  pi.on("before_agent_start", (event, ctx) => {
    currentUserPrompt = event.prompt;
    resetRound();
    checkpointImages.clear();
    updateStatus(ctx);
    if (state.mode === "off") return;

    return {
      systemPrompt: `${event.systemPrompt}\n\n${researchPolicy(state.mode, roundActions, checkpointReviewPending)}`,
    };
  });

  pi.on("context", (event) => {
    const messages = event.messages.filter(
      (message) => !(message.role === "custom" && "customType" in message && message.customType === POLICY_MESSAGE),
    );
    if (state.mode === "off") return { messages };

    const policyMessage = {
      role: "custom" as const,
      customType: POLICY_MESSAGE,
      content: researchPolicy(state.mode, roundActions, checkpointReviewPending),
      display: false,
      timestamp: Date.now(),
    } as (typeof event.messages)[number];
    return { messages: [...messages, policyMessage] };
  });

  pi.on("turn_start", () => {
    toolCallsThisTurn = 0;
    checkpointAccepted = false;
    checkpointReviewRaisedThisTurn = false;
  });

  pi.on("tool_call", (event, ctx) => {
    if (state.mode === "off") return;

    if (event.toolName === "research_checkpoint") {
      if (toolCallsThisTurn > 0) {
        return {
          block: true,
          reason:
            "research_checkpoint must be the only tool in its batch. Finish the current tool batch, then call research_checkpoint alone on the next turn.",
        };
      }
      checkpointAccepted = true;
      toolCallsThisTurn += 1;
      return;
    }

    if (checkpointAccepted) {
      toolCallsThisTurn += 1;
      return {
        block: true,
        reason: "No work tool may run after research_checkpoint in the same batch.",
        terminate: true,
      };
    }

    toolCallsThisTurn += 1;
    if (state.mode === "fast" && event.toolName === "bash") {
      const command = (event.input as { command?: string }).command ?? "";
      const decision = evaluateFastCommand(command, currentUserPrompt);
      if (decision.block) return { block: true, reason: decision.reason };
    }

    if (checkpointReviewPending && !checkpointReviewRaisedThisTurn) {
      checkpointReviewPending = false;
      while (nextCheckpointReviewAt <= roundActions) {
        nextCheckpointReviewAt += CHECKPOINT_REVIEW_INTERVAL;
      }
    }

    roundActions += 1;
    if (roundActions >= nextCheckpointReviewAt) {
      checkpointReviewPending = true;
      checkpointReviewRaisedThisTurn = true;
    }
    updateStatus(ctx);
  });

  pi.on("tool_execution_start", () => {
    if (state.mode !== "off") radar?.beginCapture();
  });

  pi.on("tool_execution_end", () => {
    if (state.mode !== "off") radar?.endCapture();
  });
}

const PARQUET_PREVIEW_SCRIPT = `import json, sys
import pyarrow.parquet as pq
parquet = pq.ParquetFile(sys.argv[1])
all_columns = parquet.schema_arrow.names
requested = json.loads(sys.argv[2])
columns = [column for column in requested if column in all_columns][:6] or all_columns[:6]
rows = []
if parquet.num_row_groups:
    rows = parquet.read_row_group(0, columns=columns).slice(0, 5).to_pylist()
print(json.dumps({
    "rowCount": parquet.metadata.num_rows,
    "columnCount": len(all_columns),
    "columns": columns,
    "rows": rows,
}, default=str))`;

async function previewParquet(
  pi: ExtensionAPI,
  absolutePath: string,
  selectedColumns?: string[],
  sampleShard = false,
): Promise<string | undefined> {
  const python = process.platform === "win32" ? "python" : "python3";
  const result = await pi.exec(
    python,
    ["-c", PARQUET_PREVIEW_SCRIPT, absolutePath, JSON.stringify(selectedColumns ?? [])],
    { timeout: 5000 },
  );
  if (result.code !== 0) return undefined;

  const data = JSON.parse(result.stdout) as {
    rowCount: number;
    columnCount: number;
    columns: string[];
    rows: Array<Record<string, unknown>>;
  };
  const table = formatTable(
    data.columns,
    data.rows.map((row) => data.columns.map((column) => formatCheckpointCell(row[column]))),
    16,
  );
  const columnLabel = selectedColumns?.length
    ? `; selected columns: ${data.columns.join(", ")}`
    : data.columnCount > data.columns.length ? `; showing first ${data.columns.length} columns` : "";
  const shapeLabel = sampleShard ? "Sample shard shape" : "Shape";
  return `${shapeLabel}: ${data.rowCount} rows x ${data.columnCount} columns${columnLabel}\n\n${table}`;
}

const INFRASTRUCTURE_FIELD = /(?:^|[._-])(?:slurm|partition|qos|account|job[_-]?name|node(?:s)?|ntasks|cpus?[_-]?per[_-]?task|gres|walltime|time[_-]?limit)(?:$|[._-])/i;
const SYSTEMS_RESEARCH = /\b(?:slurm|scheduler|scheduling|cluster throughput|cluster utilization|distributed scaling)\b|系统性能|集群吞吐|调度/i;

function sanitizeExperiment(experiment: ExperimentDetails, hypothesis: string): ExperimentDetails {
  if (SYSTEMS_RESEARCH.test(`${hypothesis}\n${experiment.rationale}\n${experiment.design}`)) return experiment;
  return {
    ...experiment,
    setup: experiment.setup.filter((detail) => !INFRASTRUCTURE_FIELD.test(detail.name)),
    parameters: experiment.parameters.filter((parameter) => !INFRASTRUCTURE_FIELD.test(parameter.name)),
  };
}

function sanitizeCheckpointExperiment(
  experiment: CheckpointExperiment,
  hypothesis: string,
): CheckpointExperiment {
  const sanitized = sanitizeExperiment(experiment, hypothesis);
  return {
    ...experiment,
    setup: sanitized.setup,
    parameters: sanitized.parameters,
  };
}

function formatCheckpointReport(details: CheckpointDetails): string {
  const sections = [
    `# Checkpoint: ${details.title ?? "Research Update"}`,
    `## Research Question\n\n${details.researchQuestion ?? ""}\n\nWorking hypothesis: ${details.hypothesis}`,
  ];
  const experiments = details.experiments ?? [];
  if (experiments.length > 0) {
    const experimentReports = experiments.map((experiment, index) => {
      const parts = [
        `### Experiment ${index + 1} - ${experiment.title}`,
        experiment.rationale,
        experiment.design,
      ];
      const experimentDetails = formatExperimentDetails(experiment);
      if (experimentDetails) parts.push(`Experimental Details\n\n${experimentDetails}`);
      parts.push(experiment.observation);
      experiment.tables.forEach((table) => {
        parts.push(table.title ? `${table.title}\n\n${formatResultTable(table)}` : formatResultTable(table));
      });
      parts.push(experiment.analysis);
      const relatedResults = details.results.filter((result) => result.experiment === experiment.title);
      relatedResults.forEach((result) => {
        if ([".png", ".jpg", ".jpeg"].includes(result.artifact.extension)) {
          parts.push(`![${result.title}](${result.artifact.path})`);
        } else {
          parts.push(`Related artifact: ${result.artifact.path}`);
        }
      });
      return parts.join("\n\n");
    });
    sections.push(`## Condition & Result\n\n${experimentReports.join("\n\n")}`);
  }

  const conclusion = details.conclusion
    ? `\n\n${details.conclusion.split("\n").map((line) => `> ${line}`).join("\n")}`
    : "";
  sections.push(`## Overall Analysis\n\n${details.overallAnalysis ?? ""}${conclusion}`);
  sections.push(`## Uncertainty\n\n${details.uncertainty}`);
  sections.push(`## Next\n\n${details.next}`);
  if (details.results.length > 0) {
    sections.push(`## Relevant Artifacts\n\n${details.results.map((result) => `- ${result.artifact.path}`).join("\n")}`);
  }
  return sections.join("\n\n");
}

function formatExperimentDetails(experiment: CheckpointExperiment): string | undefined {
  const rows = [
    ...experiment.setup.map((detail) => ["Setup", detail.name, detail.value, detail.description ?? ""]),
    ...experiment.variables.map((variable) => [
      variable.role,
      variable.name,
      variable.value ?? "",
      variable.description,
    ]),
    ...experiment.parameters.map((parameter) => [
      "Hyperparameter",
      parameter.name,
      parameter.value,
      parameter.rationale ?? "",
    ]),
  ];
  if (rows.length === 0) return undefined;
  return formatTable(["Type", "Name", "Value / Levels", "Why it matters"], rows);
}

function formatResultTable(table: ExperimentResultTable): string {
  return formatTable(
    table.columns,
    table.rows.map((row) => table.columns.map((_, index) => formatResultCell(row[index]))),
  );
}

function formatResultCell(cell: ResultTableCell | undefined): string {
  if (!cell) return "";
  if (cell.value !== undefined) {
    return withUnit(
      formatSignificant(cell.value, cell.significantDigits ?? 4, cell.significantDigits !== undefined),
      cell.unit,
    );
  }
  return cell.text ?? "";
}

function formatSetupTable(setup: ExperimentSetupDetail[]): string {
  if (setup.length === 0) return "(not recorded)";
  return formatTable(
    ["Component", "Value", "Why it matters"],
    setup.map((detail) => [detail.name, detail.value, detail.description ?? ""]),
  );
}

function formatVariableTable(variables: ExperimentVariable[]): string {
  return formatTable(
    ["Variable", "Role", "Value / Levels", "Meaning"],
    variables.map((variable) => [variable.name, variable.role, variable.value ?? "", variable.description]),
  );
}

function formatParameterTable(parameters: ExperimentParameter[]): string {
  return formatTable(
    ["Hyperparameter", "Value", "Why it matters"],
    parameters.map((parameter) => [parameter.name, parameter.value, parameter.rationale ?? ""]),
  );
}

function formatMetricTable(metrics: CheckpointMetric[]): string {
  return formatTable(
    ["Metric", "Value", "Baseline", "Change", "Note"],
    metrics.map((metric) => {
      const digits = metric.significantDigits ?? 4;
      const preservePrecision = metric.significantDigits !== undefined;
      return [
        metric.name,
        withUnit(formatSignificant(metric.value, digits, preservePrecision), metric.unit),
        metric.baseline === undefined
          ? ""
          : withUnit(formatSignificant(metric.baseline, digits, preservePrecision), metric.unit),
        metric.change === undefined
          ? ""
          : withUnit(
              formatSignificant(metric.change, digits, preservePrecision),
              metric.changeUnit ?? metric.unit,
            ),
        metric.note ?? "",
      ];
    }),
  );
}

function withUnit(value: string, unit: string | undefined): string {
  return unit ? `${value} ${unit}` : value;
}

function formatCheckpointCell(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length <= 16 ? compact : `${compact.slice(0, 15)}...`;
}

function checkpointImageKey(record: ArtifactRecord): string {
  return `${record.path}:${record.mtimeMs}:${record.size}`;
}

function terminalLink(url: string, label: string): string {
  return `\u001b]8;;${url}\u001b\\${label}\u001b]8;;\u001b\\`;
}

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Image, Key, matchesKey, Text } from "@earendil-works/pi-tui";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Type } from "typebox";
import { ArtifactRadar, formatSize, loadArtifactPreview, resolveArtifactRecord } from "./artifacts.js";
import { evaluateFastCommand, researchPolicy, type ResearchMode } from "./governor.js";
import type {
  ArtifactRecord,
  CheckpointDetails,
  CheckpointResult,
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
    if (state.mode === "off") {
      ctx.ui.setStatus("research-loop", ctx.ui.theme.fg("dim", "RESEARCH OFF"));
      return;
    }

    if (checkpointReached) {
      const label = `RESEARCH ${state.mode.toUpperCase()} | CHECKPOINT REACHED | RESULTS ${checkpointResultCount}`;
      ctx.ui.setStatus("research-loop", ctx.ui.theme.fg("success", label));
      return;
    }

    const parts = [
      `RESEARCH ${state.mode.toUpperCase()}`,
      `ACTIONS ${roundActions}`,
      checkpointReviewPending ? "CHECKPOINT REVIEW" : undefined,
      `OUTPUTS ${state.artifacts.length}`,
    ].filter((part): part is string => Boolean(part));
    const color = checkpointReviewPending ? "warning" : state.mode === "fast" ? "success" : "accent";
    ctx.ui.setStatus("research-loop", ctx.ui.theme.fg(color, parts.join(" | ")));
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
      "End the current research round and return control to the user. Attach only semantically relevant results, each with a title, role, purpose, and optional takeaway/relevant columns. Result paths may point to files or dataset directories. Call this alone as the final tool action.",
    promptSnippet: "End a research round with structured evidence and return control to the user",
    promptGuidelines: [
      "Call research_checkpoint alone as the final tool action after meaningful evidence, at a decision branch, when progress stalls, or before materially higher cost. Attach only results you can explain; for each result state its purpose and role, and specify relevant table columns when known.",
    ],
    parameters: Type.Object({
      hypothesis: Type.String({ description: "The hypothesis currently being tested" }),
      observation: Type.String({ description: "The concrete evidence just observed" }),
      uncertainty: Type.String({ description: "What remains unknown or is not established by this evidence" }),
      next: Type.String({ description: "One concrete next action for user calibration" }),
      results: Type.Optional(
        Type.Array(
          Type.Object({
            path: Type.String({ description: "Path to a result file or dataset directory" }),
            title: Type.String({ description: "Human-readable name that explains what the result is" }),
            role: StringEnum(["evidence", "diagnostic", "dataset", "intermediate"] as const, {
              description: "How this result participates in the current research checkpoint",
            }),
            description: Type.String({ description: "Why this result exists and how it relates to the hypothesis" }),
            takeaway: Type.Optional(Type.String({ description: "What the user should notice in this result" })),
            columns: Type.Optional(
              Type.Array(Type.String(), {
                maxItems: 6,
                description: "Relevant table columns to preview, in display order",
              }),
            ),
          }),
          {
            maxItems: 6,
            description: "Curated results only. Omit files whose purpose is not understood.",
          },
        ),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const results = await prepareCheckpointResults(params.results, ctx);
      const details: CheckpointDetails = {
        hypothesis: params.hypothesis,
        observation: params.observation,
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
      const resultText = results
        .map((result) => `${result.title} [${result.role}]\n${result.description}\n${result.absolutePath}`)
        .join("\n\n");
      const artifactText = resultText ? `\nResults:\n${resultText}` : "";
      return {
        content: [
          {
            type: "text" as const,
            text: `Research checkpoint reached. Control returned to the user.${artifactText}`,
          },
        ],
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
      const text = [
        theme.fg("accent", theme.bold("Hypothesis")),
        details.hypothesis,
        "",
        theme.fg("success", theme.bold("Observation")),
        details.observation,
        "",
        theme.fg("warning", theme.bold("Uncertainty")),
        details.uncertainty,
        "",
        theme.fg("accent", theme.bold("Next")),
        details.next,
      ].join("\n");
      container.addChild(new Text(text, 0, 0));

      const results = details.results ?? [];
      if (results.length > 0) {
        container.addChild(new Text(theme.fg("accent", theme.bold("Curated Results")), 0, 1));
        results.forEach((researchResult, index) => {
          const artifact = researchResult.artifact;
          const label = `${index + 1}. ${researchResult.title}`;
          const semantics = [
            `${theme.fg("muted", researchResult.role.toUpperCase())} | ${researchResult.description}`,
            researchResult.takeaway ? `${theme.fg("success", "Takeaway")} ${researchResult.takeaway}` : undefined,
            terminalLink(researchResult.url, `${artifact.name} (${formatSize(artifact.size)})`),
            theme.fg("muted", researchResult.absolutePath),
          ].filter((line): line is string => Boolean(line));
          container.addChild(new Text(`${theme.bold(label)}\n${semantics.join("\n")}`, 0, 0));

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
        });
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
  const header = data.columns.map(formatCheckpointCell).join(" | ");
  const rows = data.rows
    .map((row) => data.columns.map((column) => formatCheckpointCell(row[column])).join(" | "))
    .join("\n");
  const columnLabel = selectedColumns?.length
    ? `; selected columns: ${data.columns.join(", ")}`
    : data.columnCount > data.columns.length ? `; showing first ${data.columns.length} columns` : "";
  const shapeLabel = sampleShard ? "Sample shard shape" : "Shape";
  return `${shapeLabel}: ${data.rowCount} rows x ${data.columnCount} columns${columnLabel}\n\n${header}${rows ? `\n${rows}` : ""}`;
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

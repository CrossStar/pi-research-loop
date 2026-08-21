import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { realpath, stat } from "node:fs/promises";
import { basename, extname, relative, resolve, sep } from "node:path";
import { Type } from "typebox";
import { loadArtifactPreview, resolveArtifactRecord, type ArtifactRecord } from "./artifacts.js";
import { formatSshPortForwardCommand } from "./checkpoint-server.js";
import {
  validateCheckpointDraft,
  type CheckpointArtifactInput,
  type CheckpointDraft,
  type PreparedCheckpointArtifact,
  type StoredCheckpoint,
} from "./checkpoint-store.js";
import { createTerminalImage } from "./terminal-image.js";

interface SavedCheckpoint {
  stored: StoredCheckpoint;
  viewerUrl?: string;
}

interface CheckpointDependencies {
  getArtifacts: () => ArtifactRecord[];
  save: (
    draft: CheckpointDraft,
    artifacts: PreparedCheckpointArtifact[],
    ctx: ExtensionContext,
  ) => Promise<SavedCheckpoint>;
  onReached: (resultCount: number, ctx: ExtensionContext) => void;
}

interface CheckpointToolDetails extends SavedCheckpoint {
  draft: CheckpointDraft;
  artifacts: PreparedCheckpointArtifact[];
  portForwardCommand?: string;
}

export function registerResearchCheckpoint(
  pi: ExtensionAPI,
  dependencies: CheckpointDependencies,
): void {
  pi.registerTool({
    name: "research_checkpoint",
    label: "Research Checkpoint",
    description:
      "Write a persistent Chinese Markdown research note for the completed experiment, save it under checkpoints/, and return Research Loop to Exploration Mode. The four Markdown bodies must read as a concise continuous research note rather than a log. Important figures must be referenced in resultsMarkdown. Call this alone as the final tool action.",
    promptSnippet: "Write the completed experiment as a persistent Markdown checkpoint",
    promptGuidelines: [
      "Write primarily in natural Chinese. Use Chinese (English term) the first time a necessary technical term appears, then use the Chinese term consistently.",
      "The four bodies map to 研究目的、实验设置、结果与分析、结论与下一步. Do not repeat those level-one or level-two headings inside the bodies.",
      "ResultsMarkdown must be the longest section and follow 实验现象 → 图表证据 → 图表含义 → 结果解释 → 局部结论. Every visual must form an independent 图（表）→ 正式标题 → 解析 unit, followed by a standalone --- separator before the next visual.",
      "Follow 上表下图：write a table title above the Markdown table as ### 表 N　标题; put a figure title below the image by using 图 N　标题 as the Markdown image caption. Do not place a ### 图 heading above an image. After each table, image, or checkpoint-chart, write a prose paragraph explaining what its content means.",
      "Never use the Chinese contrast construction 不是……而是…… or close variants such as 并非……而是……、不在于……而在于……、而不是 and 而非 anywhere in a checkpoint. State the observation and conclusion directly.",
      "Keep only result-essential settings in setupMarkdown. Put model revision, data revision, commit, seeds, full paths and audit details in structured reproduction/protocol fields.",
      "Use a fenced checkpoint-chart block containing JSON for lightweight presentation-only bar or line charts. Never create a PNG solely for checkpoint decoration.",
      "For a reproduction, record paper, README and issue coverage plus every approved or unapproved deviation.",
    ],
    parameters: Type.Object({
      title: Type.String({ description: "一句话概括本次实验及最重要现象，不加 Checkpoint 前缀" }),
      experimentId: Type.Optional(Type.String({ description: "Stable experiment/run identifier when one exists" })),
      shortConclusion: Type.String({ description: "第一屏显示的一句话最保守结论" }),
      purposeMarkdown: Type.String({
        description: "研究目的正文：前置现象、要区分的问题、解释 A/B、核心假设及双方预期；不要包含二级标题",
      }),
      setupMarkdown: Type.String({
        description: "实验设置正文：系统、任务、主要条件差异、方法、必要参数、指标与预先判断标准；不要堆砌审计信息",
      }),
      resultsMarkdown: Type.String({
        description:
          "结果与分析正文，也是全文主体。表格使用上方三级标题“### 表 N　标题”；图片 caption 使用“图 N　标题”，由 Viewer 显示在图下方。每个表格、图片或 checkpoint-chart 后必须单独写解析段落并添加 ---。图片目标使用 artifacts 中的项目相对路径。轻量图表可使用 ```checkpoint-chart 后跟 JSON，其 title 必须是“图 N　标题”；bar 格式为 {type,title,items:[{label,value,color?}]}，line 格式为 {type,title,series:[{name,color?,points:[{x,y}]}]}",
      }),
      conclusionMarkdown: Type.String({
        description: "结论与下一步正文：最终结论、关键证据、不能证明的内容、保守表述以及能直接区分机制的下一实验",
      }),
      protocols: Type.Array(
        Type.Object({
          title: Type.String({ description: "Protocol/run label" }),
          intent: StringEnum(["reproduction", "diagnostic", "exploratory", "ablation"] as const),
          reference: Type.Optional(Type.String({ description: "Reference protocol, paper, baseline or official run" })),
          dataScope: Type.String({ description: "Actual dataset, split, sample count and sampling scope" }),
          sources: Type.Array(
            Type.Object({
              kind: StringEnum(["paper", "readme", "issue"] as const),
              status: StringEnum(["consulted", "not-found", "inaccessible"] as const),
              reference: Type.Optional(Type.String()),
              summary: Type.String({ description: "Guidance, correction, conflict, bug or documented search outcome" }),
            }),
            { maxItems: 12 },
          ),
          deviations: Type.Array(
            Type.Object({
              field: Type.String(),
              reference: Type.String(),
              actual: Type.String(),
              reason: Type.String(),
              approvedByUser: Type.Boolean(),
            }),
            { maxItems: 12 },
          ),
        }),
        { minItems: 1, maxItems: 6 },
      ),
      reproduction: Type.Object({
        model: Type.String({ description: "Model or system name; use not-applicable when appropriate" }),
        modelRevision: Type.String({ description: "Model revision/checkpoint/tag" }),
        dataset: Type.String({ description: "Dataset, environment or task" }),
        dataRevision: Type.String({ description: "Dataset revision/split/version" }),
        codeCommit: Type.String({ description: "Git commit or exact code version" }),
        seeds: Type.Array(Type.String(), { maxItems: 24 }),
        parameters: Type.Array(
          Type.Object({ name: Type.String(), value: Type.String() }),
          { maxItems: 24, description: "Audit-level key parameters" },
        ),
        environment: Type.Optional(Type.String({ description: "GPU/node/runtime when useful" })),
      }),
      artifacts: Type.Optional(
        Type.Array(
          Type.Object({
            path: Type.String({ description: "Project-relative path to a real experiment artifact" }),
            title: Type.String(),
            role: StringEnum(["evidence", "diagnostic", "dataset", "intermediate"] as const),
            description: Type.String({ description: "One sentence explaining the artifact's research purpose" }),
            takeaway: Type.Optional(Type.String()),
            columns: Type.Optional(Type.Array(Type.String(), { maxItems: 8 })),
          }),
          { maxItems: 16, description: "Real experiment artifacts only; no checkpoint-only decorative images" },
        ),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      let artifacts: PreparedCheckpointArtifact[];
      try {
        artifacts = await prepareCheckpointArtifacts(
          pi,
          ctx,
          dependencies.getArtifacts(),
          params.artifacts as CheckpointArtifactInput[] | undefined,
        );
      } catch (error) {
        return failure(`Checkpoint artifacts could not be prepared: ${String(error)}`);
      }
      const draft: CheckpointDraft = {
        title: params.title,
        experimentId: params.experimentId,
        shortConclusion: params.shortConclusion,
        purposeMarkdown: params.purposeMarkdown,
        setupMarkdown: params.setupMarkdown,
        resultsMarkdown: params.resultsMarkdown,
        conclusionMarkdown: params.conclusionMarkdown,
        protocols: params.protocols,
        reproduction: params.reproduction,
      };
      const validation = validateCheckpointDraft(draft, artifacts);
      if (validation.errors.length) return failure(validation.errors.join("\n"));
      validation.warnings.forEach((warning) => ctx.ui.notify(warning, "warning"));

      let saved: SavedCheckpoint;
      try {
        saved = await dependencies.save(draft, artifacts, ctx);
      } catch (error) {
        return failure(`Checkpoint Markdown could not be saved: ${String(error)}`);
      }
      const portForwardCommand = saved.viewerUrl
        ? formatSshPortForwardCommand(saved.viewerUrl)
        : undefined;
      dependencies.onReached(artifacts.length, ctx);
      const details: CheckpointToolDetails = { draft, artifacts, ...saved, portForwardCommand };
      const lines = [
        "✓ Experiment completed",
        "✓ Checkpoint generated",
        "",
        `Saved: ${saved.stored.relativeMarkdownPath}`,
        saved.viewerUrl ? `\nCheckpoint:\n${saved.viewerUrl}` : undefined,
        portForwardCommand ? `\n${portForwardCommand}` : undefined,
      ].filter((line): line is string => line !== undefined);
      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details,
        terminate: true,
      };
    },
    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("Research Checkpoint")), 0, 0);
    },
    renderResult(result, _options, theme) {
      const details = result.details as CheckpointToolDetails | undefined;
      if (!details) return new Text("Research checkpoint reached.", 0, 0);
      return renderCheckpointResult(details, theme);
    },
  });
}

async function prepareCheckpointArtifacts(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  discovered: ArtifactRecord[],
  requested: CheckpointArtifactInput[] | undefined,
): Promise<PreparedCheckpointArtifact[]> {
  const prepared: PreparedCheckpointArtifact[] = [];
  const projectRoot = resolve(ctx.cwd);
  const realProjectRoot = await realpath(projectRoot);
  for (const item of requested ?? []) {
    const requestedPath = item.path.startsWith("@") ? item.path.slice(1) : item.path;
    const requestedAbsolutePath = resolve(projectRoot, requestedPath);
    if (requestedAbsolutePath !== projectRoot && !requestedAbsolutePath.startsWith(`${projectRoot}${sep}`)) {
      throw new Error(`Artifact must stay inside the project: ${item.path}`);
    }
    const resolvedRecord = await resolveCheckpointArtifactRecord(ctx.cwd, requestedPath);
    if (!resolvedRecord) throw new Error(`Artifact does not exist or is not a file/dataset: ${item.path}`);
    const absolutePath = resolve(ctx.cwd, resolvedRecord.path);
    const realArtifactPath = await realpath(absolutePath);
    if (realArtifactPath !== realProjectRoot && !realArtifactPath.startsWith(`${realProjectRoot}${sep}`)) {
      throw new Error(`Artifact must stay inside the project: ${item.path}`);
    }
    const artifact = discovered.find((candidate) => resolve(ctx.cwd, candidate.path) === absolutePath) ?? resolvedRecord;
    const result: PreparedCheckpointArtifact = { ...item, artifact, absolutePath };
    if (artifact.kind === "file" && [".png", ".jpg", ".jpeg"].includes(artifact.extension)) {
      try {
        const preview = await loadArtifactPreview(pi, ctx.cwd, artifact, item.columns);
        result.image = preview.image;
      } catch {
        // The persistent Markdown reference remains authoritative without a terminal preview.
      }
    }
    prepared.push(result);
  }
  return prepared;
}

async function resolveCheckpointArtifactRecord(cwd: string, inputPath: string): Promise<ArtifactRecord | undefined> {
  const known = await resolveArtifactRecord(cwd, inputPath);
  if (known) return known;
  const absolutePath = resolve(cwd, inputPath);
  try {
    const fileStat = await stat(absolutePath);
    if (!fileStat.isFile()) return undefined;
    return {
      kind: "file",
      path: relative(cwd, absolutePath).split(sep).join("/"),
      name: basename(absolutePath),
      extension: extname(absolutePath).toLowerCase(),
      size: fileStat.size,
      mtimeMs: fileStat.mtimeMs,
      discoveredAt: Date.now(),
    };
  } catch {
    return undefined;
  }
}

function renderCheckpointResult(details: CheckpointToolDetails, theme: Theme): Container {
  const container = new Container();
  container.addChild(new Text(theme.fg("success", theme.bold("✓ Experiment completed\n✓ Checkpoint generated")), 0, 0));
  container.addChild(new Text(theme.bold(details.draft.title), 0, 1));
  container.addChild(new Text(details.draft.shortConclusion, 0, 0));
  details.artifacts.filter((item) => item.image && item.role === "evidence").forEach((item) => {
    container.addChild(new Text(`${theme.bold(item.title)}\n${item.description}`, 0, 1));
    container.addChild(
      createTerminalImage(
        item.image!.data,
        item.image!.mimeType,
        { fallbackColor: (value) => theme.fg("muted", value) },
        { maxWidthCells: 72, maxHeightCells: 24, filename: item.artifact.name, chafaFormat: "sixels" },
      ),
    );
  });
  container.addChild(new Text(`${theme.fg("muted", "Saved")} ${details.stored.relativeMarkdownPath}`, 0, 1));
  if (details.viewerUrl) {
    const command = details.portForwardCommand ? `\n${details.portForwardCommand}` : "";
    container.addChild(
      new Text(
        `${theme.fg("accent", theme.bold("Checkpoint"))}\n${terminalLink(details.viewerUrl, details.viewerUrl)}${command}`,
        0,
        1,
      ),
    );
  }
  return container;
}

function failure(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    details: { accepted: false },
    isError: true,
  };
}

function terminalLink(url: string, label: string): string {
  return `\u001b]8;;${url}\u001b\\${label}\u001b]8;;\u001b\\`;
}

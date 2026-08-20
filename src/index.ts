import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Image, Key, matchesKey, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { ArtifactRadar, formatSize, loadArtifactPreview } from "./artifacts.js";
import { registerResearchCheckpoint } from "./checkpoint.js";
import { POLICY_MESSAGE, ResearchRuntime } from "./runtime.js";

export default function researchLoop(pi: ExtensionAPI): void {
  const runtime = new ResearchRuntime(pi);
  let radar: ArtifactRadar | undefined;
  let activeContext: ExtensionContext | undefined;

  const getArtifacts = () => radar?.getArtifacts() ?? runtime.artifacts;

  registerResearchCheckpoint(pi, {
    getArtifacts,
    onReached: (resultCount, ctx) => runtime.reachCheckpoint(resultCount, ctx),
  });

  pi.registerTool({
    name: "research_mode",
    label: "Research Work Mode",
    description:
      "Select the dominant work contract when Research Loop is on. Use Normal for direct work, Brainstorming for options and tradeoffs, Exploration for a researcher's Experiment Blueprint, and Experiment before empirical execution. Call this alone before mode-specific work.",
    parameters: Type.Object({
      mode: StringEnum(["normal", "brainstorming", "exploration", "experiment"] as const),
      objective: Type.String({ description: "Current objective that justifies this mode" }),
      title: Type.Optional(Type.String({ description: "Experiment phase title; required for Experiment Mode" })),
      question: Type.Optional(Type.String({ description: "Research Question; required for Experiment Mode" })),
      intent: Type.Optional(
        StringEnum(["reproduction", "diagnostic", "exploratory", "ablation"] as const, {
          description: "Scientific intent; required for Experiment Mode",
        }),
      ),
      plannedDataScope: Type.Optional(
        Type.String({ description: "Planned dataset, split, sample count, and scope; required for Experiment Mode" }),
      ),
      reference: Type.Optional(Type.String({ description: "Reference paper, result, or protocol when applicable" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const experiment = params.mode === "experiment"
        && params.title
        && params.question
        && params.intent
        && params.plannedDataScope
        ? {
            title: params.title,
            question: params.question,
            intent: params.intent,
            plannedDataScope: params.plannedDataScope,
            reference: params.reference,
          }
        : undefined;
      const decision = runtime.enterMode(params.mode, params.objective, experiment, ctx);
      const text = decision.block
        ? decision.reason ?? "Mode transition rejected."
        : `Research Work Mode: ${params.mode.toUpperCase()}\nObjective: ${params.objective}`;
      return { content: [{ type: "text" as const, text }], details: { accepted: !decision.block, mode: params.mode } };
    },
    renderCall(args, theme) {
      const mode = (args as { mode?: string }).mode?.toUpperCase() ?? "MODE";
      return new Text(theme.fg("toolTitle", theme.bold(`Research ${mode}`)), 0, 0);
    },
  });

  pi.registerTool({
    name: "research_abort_experiment",
    label: "Abort Experiment",
    description:
      "Leave Experiment Mode only when no interpretable empirical evidence was produced. If negative, failed, or diagnostic evidence exists, use research_checkpoint instead. Call this alone.",
    parameters: Type.Object({
      reason: Type.String({ description: "Why the phase produced no interpretable evidence" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const decision = runtime.abortExperiment(params.reason, ctx);
      return {
        content: [{
          type: "text" as const,
          text: decision.block ? decision.reason ?? "Abort rejected." : `Experiment aborted: ${params.reason}`,
        }],
        details: { accepted: !decision.block },
      };
    },
    renderCall(_args, theme) {
      return new Text(theme.fg("warning", theme.bold("Abort Experiment")), 0, 0);
    },
  });

  pi.registerCommand("research", {
    description: "Turn Research Loop on or off",
    getArgumentCompletions(prefix) {
      return ["on", "off"]
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value }));
    },
    handler: async (args, ctx) => {
      const value = args.trim().toLowerCase();
      if (value === "on" || value === "off") {
        runtime.setEnabled(value === "on", ctx);
        return;
      }
      ctx.ui.notify(`Research Loop: ${runtime.enabled ? "ON" : "OFF"}. Usage: /research on|off`, "info");
    },
  });

  pi.registerCommand("artifacts", {
    description: "List and preview artifacts from the current research session",
    handler: async (_args, ctx) => {
      const artifacts = getArtifacts();
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
        const preview = await loadArtifactPreview(pi, ctx.cwd, artifact);
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
    runtime.startSession(ctx);

    radar?.stop();
    radar = new ArtifactRadar(ctx.cwd, runtime.artifacts, (artifact, isNew) => {
      runtime.setArtifacts(getArtifacts(), activeContext);
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
  });

  pi.on("session_shutdown", (_event, ctx) => {
    runtime.clearStatus(ctx);
    radar?.stop();
    radar = undefined;
    activeContext = undefined;
  });

  pi.on("before_agent_start", (event, ctx) => {
    runtime.resetRequest(event.prompt, ctx);
  });

  pi.on("context", (event) => {
    const messages = event.messages.filter(
      (message) => !(message.role === "custom" && "customType" in message && message.customType === POLICY_MESSAGE),
    );
    const policy = runtime.policy();
    if (!policy) return { messages };

    const policyMessage = {
      role: "custom" as const,
      customType: POLICY_MESSAGE,
      content: policy,
      display: false,
      timestamp: Date.now(),
    } as (typeof event.messages)[number];
    return { messages: [...messages, policyMessage] };
  });

  pi.on("turn_start", () => runtime.startTurn());

  pi.on("tool_call", (event, ctx) => {
    return runtime.evaluateToolCall(event.toolName, event.input, ctx);
  });

  pi.on("tool_execution_start", () => {
    if (runtime.enabled) radar?.beginCapture();
  });

  pi.on("tool_execution_end", () => {
    if (runtime.enabled) radar?.endCapture();
  });
}

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ArtifactRecord } from "./artifacts.js";
import { ResearchCore } from "./core/research-core.js";
import type {
  ExperimentContext,
  GateDecision,
  ResearchState,
  ToolGateDecision,
  WorkMode,
} from "./core/types.js";

export const STATE_ENTRY = "research-loop-state";
export const POLICY_MESSAGE = "research-loop-policy";

const RESEARCH_TOOLS = ["research_mode", "research_checkpoint", "research_abort_experiment"];

export type { ResearchState, ToolGateDecision } from "./core/types.js";

/** Pi-specific persistence, tool registration, notification, and status adapter. */
export class ResearchRuntime {
  private readonly core = new ResearchCore();

  constructor(private readonly pi: ExtensionAPI) {}

  get enabled(): boolean {
    return this.core.enabled;
  }

  get workMode(): WorkMode {
    return this.core.workMode;
  }

  get experiment(): ExperimentContext | undefined {
    return this.core.experiment;
  }

  get artifacts(): ArtifactRecord[] {
    return this.core.artifacts;
  }

  startSession(ctx: ExtensionContext): void {
    const latest = ctx.sessionManager
      .getBranch()
      .filter((entry) => entry.type === "custom" && entry.customType === STATE_ENTRY)
      .at(-1) as { data?: Partial<ResearchState> } | undefined;
    this.core.restoreState(latest?.data ?? {});
    this.setToolAvailability();
    this.renderStatus(ctx);
  }

  setEnabled(enabled: boolean, ctx: ExtensionContext): void {
    this.core.setEnabled(enabled);
    this.setToolAvailability();
    this.persist();
    this.renderStatus(ctx);
    ctx.ui.notify(`Research Loop: ${enabled ? "ON" : "OFF"}`, "info");
  }

  enterMode(
    mode: WorkMode,
    objective: string,
    experiment: ExperimentContext | undefined,
    ctx: ExtensionContext,
  ): GateDecision {
    const decision = this.core.enterMode(mode, objective, experiment);
    if (decision.block) return decision;
    this.setToolAvailability();
    this.persist();
    this.renderStatus(ctx);
    return decision;
  }

  abortExperiment(reason: string, ctx: ExtensionContext): GateDecision {
    const decision = this.core.abortExperiment();
    if (decision.block) return decision;
    this.setToolAvailability();
    this.persist();
    this.renderStatus(ctx);
    ctx.ui.notify(`Experiment aborted: ${reason}`, "warning");
    return decision;
  }

  setArtifacts(artifacts: ArtifactRecord[], ctx?: ExtensionContext): void {
    this.core.setArtifacts(artifacts);
    this.persist();
    if (ctx) this.renderStatus(ctx);
  }

  resetRequest(prompt: string, ctx: ExtensionContext): void {
    this.core.resetRequest(prompt);
    this.renderStatus(ctx);
  }

  policy(): string | undefined {
    return this.core.policy();
  }

  startTurn(): void {
    this.core.startTurn();
  }

  evaluateToolCall(toolName: string, input: unknown, ctx: ExtensionContext): ToolGateDecision | undefined {
    const decision = this.core.evaluateToolCall(toolName, input);
    this.renderStatus(ctx);
    return decision;
  }

  reachCheckpoint(resultCount: number, ctx: ExtensionContext): void {
    this.core.reachCheckpoint(resultCount);
    this.setToolAvailability();
    this.persist();
    this.renderStatus(ctx);
  }

  renderStatus(ctx: ExtensionContext): void {
    const status = this.core.projectStatus();
    ctx.ui.setWidget(
      "research-loop-status",
      [ctx.ui.theme.fg(status.tone, status.text)],
      { placement: "belowEditor" },
    );
  }

  private persist(): void {
    this.pi.appendEntry(STATE_ENTRY, this.core.researchState satisfies ResearchState);
  }

  private setToolAvailability(): void {
    const active = this.pi.getActiveTools().filter((name) => !RESEARCH_TOOLS.includes(name));
    if (!this.core.enabled) {
      this.pi.setActiveTools(active);
      return;
    }
    active.push("research_mode");
    if (this.core.workMode === "experiment") {
      active.push("research_checkpoint", "research_abort_experiment");
    }
    this.pi.setActiveTools(active);
  }
}

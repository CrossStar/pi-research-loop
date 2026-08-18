import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ArtifactRecord } from "./artifacts.js";
import {
  evaluateResearchCommand,
  evaluateResearchFidelity,
  researchPolicy,
  type ExperimentContext,
  type GateDecision,
  type WorkMode,
} from "./governor.js";

export const STATE_ENTRY = "research-loop-state";
export const POLICY_MESSAGE = "research-loop-policy";

const SOFT_REVIEW_INTERVAL = 6;
const RESEARCH_TOOLS = ["research_mode", "research_checkpoint", "research_abort_experiment"];
const MUTATING_TOOLS = new Set(["edit", "write", "apply_patch"]);

export interface ResearchState {
  enabled: boolean;
  workMode: WorkMode;
  objective?: string;
  experiment?: ExperimentContext;
  artifacts: ArtifactRecord[];
}

export interface ToolGateDecision extends GateDecision {
  terminate?: boolean;
}

interface StatusProjection {
  text: string;
  color: "dim" | "success" | "warning" | "accent";
}

export class ResearchRuntime {
  private state: ResearchState = {
    enabled: false,
    workMode: "normal",
    artifacts: [],
  };
  private roundActions = 0;
  private nextSoftReviewAt = SOFT_REVIEW_INTERVAL;
  private softReviewPending = false;
  private softReviewRaisedThisTurn = false;
  private checkpointReached = false;
  private checkpointResultCount = 0;
  private toolCallsThisTurn = 0;
  private terminalToolAccepted = false;
  private currentUserPrompt = "";

  constructor(private readonly pi: ExtensionAPI) {}

  get enabled(): boolean {
    return this.state.enabled;
  }

  get workMode(): WorkMode {
    return this.state.workMode;
  }

  get experiment(): ExperimentContext | undefined {
    return this.state.experiment;
  }

  get artifacts(): ArtifactRecord[] {
    return this.state.artifacts;
  }

  startSession(ctx: ExtensionContext): void {
    this.resetRound();
    const latest = ctx.sessionManager
      .getBranch()
      .filter((entry) => entry.type === "custom" && entry.customType === STATE_ENTRY)
      .at(-1) as { data?: Partial<ResearchState> } | undefined;
    const restoredMode = isWorkMode(latest?.data?.workMode) ? latest.data.workMode : "normal";
    const mode = restoredMode === "experiment" && !latest?.data?.experiment ? "normal" : restoredMode;
    this.state = {
      enabled: latest?.data?.enabled ?? false,
      workMode: mode,
      objective: latest?.data?.objective,
      experiment: mode === "experiment" ? latest?.data?.experiment : undefined,
      artifacts: latest?.data?.artifacts ?? [],
    };
    this.setToolAvailability();
    this.renderStatus(ctx);
  }

  setEnabled(enabled: boolean, ctx: ExtensionContext): void {
    this.state.enabled = enabled;
    this.state.workMode = "normal";
    this.state.objective = undefined;
    this.state.experiment = undefined;
    this.resetRound();
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
    if (!this.state.enabled) return { block: true, reason: "Research Loop is off." };
    if (this.state.workMode === "experiment") {
      return {
        block: true,
        reason: "Experiment Mode is already active and must end with research_checkpoint or research_abort_experiment.",
      };
    }
    if (mode === "experiment" && !experiment) {
      return { block: true, reason: "Experiment Mode requires a declared experiment plan." };
    }

    this.state.workMode = mode;
    this.state.objective = objective;
    this.state.experiment = mode === "experiment" ? experiment : undefined;
    this.resetRound();
    this.setToolAvailability();
    this.persist();
    this.renderStatus(ctx);
    return { block: false };
  }

  abortExperiment(reason: string, ctx: ExtensionContext): GateDecision {
    if (this.state.workMode !== "experiment") {
      return { block: true, reason: "No Experiment Mode is active." };
    }
    this.state.workMode = "normal";
    this.state.objective = undefined;
    this.state.experiment = undefined;
    this.resetRound();
    this.setToolAvailability();
    this.persist();
    this.renderStatus(ctx);
    ctx.ui.notify(`Experiment aborted: ${reason}`, "warning");
    return { block: false };
  }

  setArtifacts(artifacts: ArtifactRecord[], ctx?: ExtensionContext): void {
    this.state.artifacts = artifacts;
    this.persist();
    if (ctx) this.renderStatus(ctx);
  }

  resetRequest(prompt: string, ctx: ExtensionContext): void {
    this.currentUserPrompt = prompt;
    this.resetRound();
    this.renderStatus(ctx);
  }

  policy(): string | undefined {
    if (!this.state.enabled) return undefined;
    return researchPolicy(
      this.state.workMode,
      this.roundActions,
      this.softReviewPending,
      this.state.objective,
      this.state.experiment,
    );
  }

  startTurn(): void {
    this.toolCallsThisTurn = 0;
    this.terminalToolAccepted = false;
    this.softReviewRaisedThisTurn = false;
  }

  evaluateToolCall(toolName: string, input: unknown, ctx: ExtensionContext): ToolGateDecision | undefined {
    if (!this.state.enabled) return undefined;

    if (toolName === "research_checkpoint") {
      if (this.state.workMode !== "experiment") {
        return { block: true, reason: "research_checkpoint is available only in Experiment Mode." };
      }
      return this.acceptTerminalTool(toolName);
    }
    if (toolName === "research_abort_experiment") {
      if (this.state.workMode !== "experiment") {
        return { block: true, reason: "No Experiment Mode is active." };
      }
      return this.acceptTerminalTool(toolName);
    }
    if (toolName === "research_mode") {
      if (this.state.workMode === "experiment") {
        return {
          block: true,
          reason: "Experiment Mode is already active and must end with research_checkpoint or research_abort_experiment.",
        };
      }
      return this.acceptTerminalTool(toolName);
    }
    if (this.terminalToolAccepted) {
      this.toolCallsThisTurn += 1;
      return {
        block: true,
        reason: "No work tool may run in the same batch after a research lifecycle transition.",
      };
    }

    this.toolCallsThisTurn += 1;
    if (
      (this.state.workMode === "brainstorming" || this.state.workMode === "exploration")
      && MUTATING_TOOLS.has(toolName)
    ) {
      return {
        block: true,
        reason: `${displayMode(this.state.workMode)} is read-oriented. Switch to Normal Mode before editing code.`,
      };
    }

    const fidelity = evaluateResearchFidelity(toolName, input, this.currentUserPrompt);
    if (fidelity.block) return fidelity;
    if (toolName === "bash") {
      const command = (input as { command?: string }).command ?? "";
      const decision = evaluateResearchCommand(command, this.currentUserPrompt);
      if (decision.block) return decision;
    }

    this.recordAction();
    this.renderStatus(ctx);
    return undefined;
  }

  reachCheckpoint(resultCount: number, ctx: ExtensionContext): void {
    this.state.workMode = "normal";
    this.state.objective = undefined;
    this.state.experiment = undefined;
    this.checkpointReached = true;
    this.checkpointResultCount = resultCount;
    this.softReviewPending = false;
    this.setToolAvailability();
    this.persist();
    this.renderStatus(ctx);
  }

  renderStatus(ctx: ExtensionContext): void {
    const status = this.projectStatus();
    ctx.ui.setWidget(
      "research-loop-status",
      [ctx.ui.theme.fg(status.color, status.text)],
      { placement: "belowEditor" },
    );
  }

  private acceptTerminalTool(toolName: string): ToolGateDecision | undefined {
    if (this.toolCallsThisTurn > 0) {
      return {
        block: true,
        reason: `${toolName} must be the only tool in its batch.`,
      };
    }
    this.terminalToolAccepted = true;
    this.toolCallsThisTurn += 1;
    return undefined;
  }

  private recordAction(): void {
    if (this.state.workMode === "experiment" && this.softReviewPending && !this.softReviewRaisedThisTurn) {
      this.softReviewPending = false;
      while (this.nextSoftReviewAt <= this.roundActions) {
        this.nextSoftReviewAt += SOFT_REVIEW_INTERVAL;
      }
    }

    this.roundActions += 1;
    if (this.state.workMode === "experiment" && this.roundActions >= this.nextSoftReviewAt) {
      this.softReviewPending = true;
      this.softReviewRaisedThisTurn = true;
    }
  }

  private resetRound(): void {
    this.roundActions = 0;
    this.nextSoftReviewAt = SOFT_REVIEW_INTERVAL;
    this.softReviewPending = false;
    this.softReviewRaisedThisTurn = false;
    this.checkpointReached = false;
    this.checkpointResultCount = 0;
  }

  private projectStatus(): StatusProjection {
    if (!this.state.enabled) return { text: "RESEARCH OFF", color: "dim" };
    if (this.checkpointReached) {
      return {
        text: `RESEARCH ON | CHECKPOINT REACHED | RESULTS ${this.checkpointResultCount}`,
        color: "success",
      };
    }

    const parts = [
      "RESEARCH ON",
      displayMode(this.state.workMode),
      `ACTIONS ${this.roundActions}`,
      this.softReviewPending ? "SOFT REVIEW" : undefined,
      `OUTPUTS ${this.state.artifacts.length}`,
    ].filter((part): part is string => Boolean(part));
    return {
      text: parts.join(" | "),
      color: this.softReviewPending
        ? "warning"
        : this.state.workMode === "experiment"
          ? "success"
          : "accent",
    };
  }

  private persist(): void {
    this.pi.appendEntry(STATE_ENTRY, this.state satisfies ResearchState);
  }

  private setToolAvailability(): void {
    const active = this.pi.getActiveTools().filter((name) => !RESEARCH_TOOLS.includes(name));
    if (!this.state.enabled) {
      this.pi.setActiveTools(active);
      return;
    }
    active.push("research_mode");
    if (this.state.workMode === "experiment") {
      active.push("research_checkpoint", "research_abort_experiment");
    }
    this.pi.setActiveTools(active);
  }
}

function isWorkMode(value: unknown): value is WorkMode {
  return value === "normal" || value === "brainstorming" || value === "exploration" || value === "experiment";
}

function displayMode(mode: WorkMode): string {
  return mode.toUpperCase();
}

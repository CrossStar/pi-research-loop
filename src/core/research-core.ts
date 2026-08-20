import {
  evaluateResearchCommand,
  evaluateResearchFidelity,
  researchPolicy,
} from "./governor.js";
import type {
  ArtifactMetadata,
  ExperimentContext,
  GateDecision,
  ResearchState,
  StatusProjection,
  ToolGateDecision,
  WorkMode,
} from "./types.js";

const SOFT_REVIEW_INTERVAL = 6;
const MUTATING_TOOLS = new Set(["edit", "write", "multiedit", "notebookedit", "apply_patch"]);
const EMPIRICAL_COMMAND =
  /(?:^|\s)(?:pytest|tox|nox|cargo\s+(?:run|test|bench)|go\s+test|(?:npm|pnpm|yarn)\s+(?:test|run\s+(?:test|bench|benchmark|train|eval))|python(?:3)?\s+[^\n]*\.py\b|torchrun|deepspeed|accelerate\s+launch)(?:\s|$)/i;

export interface ResearchCoreSnapshot {
  schemaVersion: 1;
  state: ResearchState;
  roundActions: number;
  nextSoftReviewAt: number;
  softReviewPending: boolean;
  checkpointReached: boolean;
  checkpointResultCount: number;
  toolCallsThisTurn: number;
  terminalToolAccepted: boolean;
  currentUserPrompt: string;
}

export class ResearchCore {
  private state: ResearchState;
  private roundActions = 0;
  private nextSoftReviewAt = SOFT_REVIEW_INTERVAL;
  private softReviewPending = false;
  private softReviewRaisedThisTurn = false;
  private checkpointReached = false;
  private checkpointResultCount = 0;
  private toolCallsThisTurn = 0;
  private terminalToolAccepted = false;
  private currentUserPrompt = "";

  constructor(initial?: Partial<ResearchState> | ResearchCoreSnapshot) {
    this.state = defaultState();
    if (initial && "schemaVersion" in initial) this.restoreSnapshot(initial);
    else if (initial) this.restoreState(initial);
  }

  get enabled(): boolean {
    return this.state.enabled;
  }

  get workMode(): WorkMode {
    return this.state.workMode;
  }

  get lifecycleTransitionPending(): boolean {
    return this.terminalToolAccepted;
  }

  get experiment(): ExperimentContext | undefined {
    return this.state.experiment ? { ...this.state.experiment } : undefined;
  }

  get artifacts(): ArtifactMetadata[] {
    return this.state.artifacts.map((artifact) => ({ ...artifact }));
  }

  get researchState(): ResearchState {
    return cloneState(this.state);
  }

  setEnabled(enabled: boolean): void {
    this.state.enabled = enabled;
    this.state.workMode = "exploration";
    this.state.objective = undefined;
    this.state.experiment = undefined;
    this.resetRound();
  }

  enterMode(mode: WorkMode, objective: string, experiment?: ExperimentContext): GateDecision {
    if (!isWorkMode(mode)) return { block: true, reason: `Unknown Research Work Mode: ${String(mode)}.` };
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
    this.state.experiment = mode === "experiment" ? { ...experiment! } : undefined;
    this.resetRound();
    return { block: false };
  }

  abortExperiment(): GateDecision {
    if (this.state.workMode !== "experiment") {
      return { block: true, reason: "No Experiment Mode is active." };
    }
    this.state.workMode = "exploration";
    this.state.objective = undefined;
    this.state.experiment = undefined;
    this.resetRound();
    return { block: false };
  }

  reachCheckpoint(resultCount: number): void {
    this.state.workMode = "exploration";
    this.state.objective = undefined;
    this.state.experiment = undefined;
    this.checkpointReached = true;
    this.checkpointResultCount = resultCount;
    this.softReviewPending = false;
  }

  setArtifacts(artifacts: ArtifactMetadata[]): void {
    this.state.artifacts = artifacts.map((artifact) => ({ ...artifact }));
  }

  upsertArtifact(artifact: ArtifactMetadata): void {
    const index = this.state.artifacts.findIndex(
      (candidate) => candidate.kind === artifact.kind && candidate.path === artifact.path,
    );
    if (index >= 0) this.state.artifacts[index] = { ...artifact };
    else this.state.artifacts.push({ ...artifact });
  }

  resetRequest(prompt: string): void {
    this.currentUserPrompt = prompt;
    this.resetRound();
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

  completeLifecycleTransition(): void {
    this.terminalToolAccepted = false;
  }

  evaluateToolCall(toolName: string, input: unknown): ToolGateDecision | undefined {
    if (!this.state.enabled) return undefined;

    const researchTool = identifyResearchTool(toolName);
    if (researchTool === "research_state") return undefined;
    if (researchTool === "research_checkpoint") {
      if (this.state.workMode !== "experiment") {
        return { block: true, reason: "research_checkpoint is available only in Experiment Mode." };
      }
      return this.acceptTerminalTool("research_checkpoint");
    }
    if (researchTool === "research_abort_experiment") {
      if (this.state.workMode !== "experiment") {
        return { block: true, reason: "No Experiment Mode is active." };
      }
      return this.acceptTerminalTool("research_abort_experiment");
    }
    if (researchTool === "research_mode") {
      if (this.state.workMode === "experiment") {
        return {
          block: true,
          reason: "Experiment Mode is already active and must end with research_checkpoint or research_abort_experiment.",
        };
      }
      return this.acceptTerminalTool("research_mode");
    }
    if (researchTool === "research_set_enabled") {
      return this.acceptTerminalTool("research_set_enabled");
    }
    if (this.terminalToolAccepted) {
      return {
        block: true,
        reason: "Wait for the research lifecycle transition to complete before running work or dispatching a subagent.",
      };
    }

    this.toolCallsThisTurn += 1;
    const normalizedTool = toolName.toLowerCase();
    if (
      (this.state.workMode === "brainstorming" || this.state.workMode === "exploration")
      && MUTATING_TOOLS.has(normalizedTool)
    ) {
      return {
        block: true,
        reason: `${displayMode(this.state.workMode)} is read-oriented. Disable Research Loop before editing code, or enter Experiment Mode for empirical work.`,
      };
    }

    const command = isShellTool(normalizedTool) ? extractCommand(input) : "";
    if (
      command
      && (this.state.workMode === "brainstorming" || this.state.workMode === "exploration")
      && EMPIRICAL_COMMAND.test(command)
    ) {
      return {
        block: true,
        reason: `${displayMode(this.state.workMode)} cannot run empirical work. Declare an experiment and switch to Experiment Mode first.`,
      };
    }

    const fidelity = evaluateResearchFidelity(normalizedTool, input, this.currentUserPrompt);
    if (fidelity.block) return fidelity;
    if (command) {
      const decision = evaluateResearchCommand(command, this.currentUserPrompt);
      if (decision.block) return decision;
    }

    this.recordAction();
    return undefined;
  }

  projectStatus(): StatusProjection {
    if (!this.state.enabled) return { text: "RESEARCH OFF", tone: "dim" };
    if (this.checkpointReached) {
      return {
        text: `RESEARCH ON | CHECKPOINT REACHED | RESULTS ${this.checkpointResultCount}`,
        tone: "success",
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
      tone: this.softReviewPending
        ? "warning"
        : this.state.workMode === "experiment"
          ? "success"
          : "accent",
    };
  }

  snapshot(): ResearchCoreSnapshot {
    return {
      schemaVersion: 1,
      state: cloneState(this.state),
      roundActions: this.roundActions,
      nextSoftReviewAt: this.nextSoftReviewAt,
      softReviewPending: this.softReviewPending,
      checkpointReached: this.checkpointReached,
      checkpointResultCount: this.checkpointResultCount,
      toolCallsThisTurn: this.toolCallsThisTurn,
      terminalToolAccepted: this.terminalToolAccepted,
      currentUserPrompt: this.currentUserPrompt,
    };
  }

  restoreState(state: Partial<ResearchState>): void {
    const restoredMode = isWorkMode(state.workMode) ? state.workMode : "exploration";
    const mode = restoredMode === "experiment" && !state.experiment ? "exploration" : restoredMode;
    this.state = {
      enabled: state.enabled ?? false,
      workMode: mode,
      objective: state.objective,
      experiment: mode === "experiment" ? state.experiment : undefined,
      artifacts: Array.isArray(state.artifacts)
        ? state.artifacts.map((artifact) => ({ ...artifact }))
        : [],
    };
    this.resetRound();
  }

  private restoreSnapshot(snapshot: ResearchCoreSnapshot): void {
    this.restoreState(snapshot.state);
    this.roundActions = nonNegativeInteger(snapshot.roundActions, 0);
    this.nextSoftReviewAt = Math.max(
      SOFT_REVIEW_INTERVAL,
      nonNegativeInteger(snapshot.nextSoftReviewAt, SOFT_REVIEW_INTERVAL),
    );
    this.softReviewPending = snapshot.softReviewPending === true;
    this.checkpointReached = snapshot.checkpointReached === true;
    this.checkpointResultCount = nonNegativeInteger(snapshot.checkpointResultCount, 0);
    this.toolCallsThisTurn = nonNegativeInteger(snapshot.toolCallsThisTurn, 0);
    this.terminalToolAccepted = snapshot.terminalToolAccepted === true;
    this.currentUserPrompt = typeof snapshot.currentUserPrompt === "string" ? snapshot.currentUserPrompt : "";
  }

  private acceptTerminalTool(toolName: string): ToolGateDecision | undefined {
    if (this.terminalToolAccepted) {
      return {
        block: true,
        reason: `${toolName} cannot start while another research lifecycle transition is pending.`,
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
}

export function isWorkMode(value: unknown): value is WorkMode {
  return value === "brainstorming" || value === "exploration" || value === "experiment";
}

export function displayMode(mode: WorkMode): string {
  return mode.toUpperCase();
}

function identifyResearchTool(toolName: string): string | undefined {
  return [
    "research_set_enabled",
    "research_mode",
    "research_checkpoint",
    "research_abort_experiment",
    "research_state",
  ].find((name) => toolName === name || toolName.endsWith(`__${name}`));
}

function isShellTool(toolName: string): boolean {
  return toolName === "bash" || toolName === "shell" || toolName === "exec";
}

function extractCommand(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const command = (input as { command?: unknown }).command;
  return typeof command === "string" ? command : "";
}

function defaultState(): ResearchState {
  return { enabled: false, workMode: "exploration", artifacts: [] };
}

function cloneState(state: ResearchState): ResearchState {
  return {
    ...state,
    experiment: state.experiment ? { ...state.experiment } : undefined,
    artifacts: state.artifacts.map((artifact) => ({ ...artifact })),
  };
}

function nonNegativeInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}

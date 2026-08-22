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
import { renderPiResearchStatus } from "./pi-status.js";

export const STATE_ENTRY = "research-loop-state";
export const POLICY_MESSAGE = "research-loop-policy";

const RESEARCH_TOOLS = ["research_mode", "research_checkpoint", "research_abort_experiment"];
const ASK_USER_QUESTION_TOOL = "ask_user_question";
const STRUCTURED_DECISION_GUIDANCE = [
  "[RESEARCH DECISIONS]",
  "ask_user_question is available. Use it once, grouping related questions, when research cannot proceed without a concrete user decision.",
  "Use it for scientifically material protocol or scope choices, cost/scope trade-offs between alternatives, and branches between genuinely different next experiments.",
  "Before a checkpoint, ask only when the user must choose the next branch; incorporate the answer into the checkpoint. Do not ask about routine, reversible choices or repeat an answered question.",
  "Governor approval dialogs authorize one exact action. If the user declines, stop and do not retry that action.",
].join("\n");

const PI_EXPERIMENT_CODE_GUIDANCE = [
  "[EXPERIMENT CODE]",
  "When creating or revising experiment code, optimize for a researcher's reading, running, debugging, modification, and inspection loop. Prefer readable, runnable, observable, modifiable code over production-style architecture.",
  "Make the top-level main() mirror the natural experiment phases so the full workflow is understandable without opening every helper. Functions should represent natural experimental actions or clear responsibilities; keep simple contiguous logic together.",
  "Python experiment scripts must use Rich with a restrained hierarchy for the startup configuration summary, major phase boundaries, scientifically useful intermediate checks, condition/metric tables, the final result summary, and explicit artifact paths. Declare Rich and tqdm in the project's existing dependency surface and do not build fallback logging UI. Do not log every function, batch, sample, tensor shape, or internal state.",
  "Use tqdm for repeated work that makes the researcher wait: dataset processing, batched inference, activation extraction, layer scans, seed sweeps, or large evaluation. Avoid progress bars for millisecond loops and avoid deeply nested bars.",
  "Centralize every research-significant parameter in one obvious config/CLI surface: model, dataset, layers, seeds, batch size, split, thresholds, run count, and output directory. Use descriptive names and remove unexplained magic numbers.",
  "Keep the normal entry point direct, preferably `python experiment.py`; provide clear --help. For costly runs, add a small --quick or --smoke path that exercises the whole pipeline. Show every reduced setting and treat a reduced reproduction run as diagnostic unless the user approved the deviation.",
  "After each major phase, print only checks that help detect a scientifically meaningful problem, such as sample counts, activation shape, label balance/correlation, or condition summaries. Fail early with a concrete actionable error when a missing input or incompatible setting would otherwise waste a long run.",
  "Make randomness explicit: identify which seed controls splits, pseudo-labels, initialization, and sampling. Never silently change seeds, devices, models, environment variables, output locations, or experimental conditions, and never silently fall back.",
  "Use names that express research meaning. Comments should explain why a split, metric, layer, control, fixed variable, or protocol deviation exists; do not translate obvious code into comments.",
  "Separate model loading, data preparation, conditions, analysis, and plotting only when they are naturally distinct. Avoid factories, registries, strategy/context hierarchies, tiny wrapper chains, and reusable frameworks until multiple real experiments need them.",
  "Avoid broad defensive layers, retries, compatibility shims, silent recovery, repeated existence checks, and large try/except shells. Add only checks that prevent expensive wasted work or misleading results.",
  "Save scientific artifacts once under a stable predictable run directory, with names such as summary.json, per_seed.csv, per_layer.csv, figures/, predictions, activations, or checkpoints. Do not copy artifacts for checkpoint presentation and do not create display-only files.",
  "End the run with a compact Rich result table and a labeled list of exact saved paths so the researcher can judge the result and start the next iteration immediately.",
].join("\n");

export type { ResearchState, ToolGateDecision } from "./core/types.js";

export function shouldAbortForCancelledQuestionnaire(toolName: string, details: unknown): boolean {
  if (toolName !== ASK_USER_QUESTION_TOOL || !details || typeof details !== "object") return false;
  const result = details as { cancelled?: unknown; error?: unknown };
  return result.cancelled === true && result.error === undefined;
}

/** Pi-specific persistence, tool registration, notification, and status adapter. */
export class ResearchRuntime {
  private readonly core = new ResearchCore();
  private readonly blockedToolAttempts = new Map<string, number>();
  private userDecisionPending = false;

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
    this.blockedToolAttempts.clear();
    this.userDecisionPending = false;
    const latest = ctx.sessionManager
      .getBranch()
      .filter((entry) => entry.type === "custom" && entry.customType === STATE_ENTRY)
      .at(-1) as { data?: Partial<ResearchState> } | undefined;
    this.core.restoreState(latest?.data ?? {});
    this.setToolAvailability();
    this.renderStatus(ctx);
  }

  setEnabled(enabled: boolean, ctx: ExtensionContext): void {
    this.blockedToolAttempts.clear();
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
    this.blockedToolAttempts.clear();
    this.setToolAvailability();
    this.persist();
    this.renderStatus(ctx);
    return decision;
  }

  abortExperiment(reason: string, ctx: ExtensionContext): GateDecision {
    const decision = this.core.abortExperiment();
    if (decision.block) return decision;
    this.blockedToolAttempts.clear();
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
    this.blockedToolAttempts.clear();
    this.core.resetRequest(prompt);
    this.renderStatus(ctx);
  }

  policy(): string | undefined {
    const policy = this.core.policy();
    if (!policy) return undefined;
    const guidance = [policy];
    if (this.core.workMode === "experiment") guidance.push(PI_EXPERIMENT_CODE_GUIDANCE);
    if (this.pi.getActiveTools().includes(ASK_USER_QUESTION_TOOL)) guidance.push(STRUCTURED_DECISION_GUIDANCE);
    return guidance.join("\n");
  }

  startTurn(): void {
    this.core.startTurn();
  }

  setUserDecisionPending(pending: boolean, ctx: ExtensionContext): void {
    this.userDecisionPending = pending;
    this.renderStatus(ctx);
  }

  async evaluateToolCall(
    toolName: string,
    input: unknown,
    ctx: ExtensionContext,
  ): Promise<ToolGateDecision | undefined> {
    const decision = this.core.evaluateToolCall(toolName, input);
    if (!decision?.approval) {
      if (decision?.block) {
        const fingerprint = toolFingerprint(toolName, input);
        const attempts = (this.blockedToolAttempts.get(fingerprint) ?? 0) + 1;
        this.blockedToolAttempts.set(fingerprint, attempts);
        if (attempts > 1) {
          ctx.abort();
          this.renderStatus(ctx);
          return {
            block: true,
            reason: `${decision.reason ?? "Research Loop blocked this action."} The unchanged blocked action was repeated, so the current turn was stopped and control returned to the user.`,
          };
        }
        this.renderStatus(ctx);
        return {
          ...decision,
          reason: `${decision.reason ?? "Research Loop blocked this action."} Do not retry the unchanged tool call.`,
        };
      }
      this.renderStatus(ctx);
      return decision;
    }

    if (!ctx.hasUI) {
      ctx.abort();
      this.renderStatus(ctx);
      return {
        block: true,
        reason: `${decision.reason ?? decision.approval.message} No interactive approval UI is available; the current turn was stopped. Do not retry this action.`,
      };
    }

    let approved = false;
    this.setUserDecisionPending(true, ctx);
    try {
      approved = await ctx.ui.confirm(decision.approval.title, decision.approval.message);
    } catch {
      // Treat an unavailable or failed confirmation UI as a denial.
    } finally {
      this.userDecisionPending = false;
    }

    if (approved) {
      this.core.acceptApprovedToolCall();
      this.renderStatus(ctx);
      return undefined;
    }

    ctx.abort();
    this.renderStatus(ctx);
    return {
      block: true,
      reason: `${decision.approval.declineReason} The current turn was stopped. Do not retry this action unless the user requests it again.`,
    };
  }

  reachCheckpoint(resultCount: number, ctx: ExtensionContext): void {
    this.blockedToolAttempts.clear();
    this.core.reachCheckpoint(resultCount);
    this.setToolAvailability();
    this.persist();
    this.renderStatus(ctx);
  }

  renderStatus(ctx: ExtensionContext): void {
    // Clear the pre-0.2 widget when hot-reloading an existing Pi session.
    ctx.ui.setWidget("research-loop-status", undefined);
    ctx.ui.setStatus(
      "research-loop",
      renderPiResearchStatus(this.core.snapshot(), ctx.ui.theme, this.userDecisionPending),
    );
  }

  clearStatus(ctx: ExtensionContext): void {
    this.userDecisionPending = false;
    ctx.ui.setWidget("research-loop-status", undefined);
    ctx.ui.setStatus("research-loop", undefined);
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

function toolFingerprint(toolName: string, input: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(input) ?? String(input);
  } catch {
    serialized = String(input);
  }
  return `${toolName.toLowerCase()}\n${serialized}`;
}

import type { ExperimentContext, GateDecision, WorkMode } from "./types.js";

export type { ExperimentContext, GateDecision, WorkMode } from "./types.js";

const EXPLICIT_BROAD_WORK =
  /\b(?:all tests|full test suite|run (?:the )?entire test|repository[- ]wide|repo[- ]wide|checksum|sha256|exhaustive benchmark|long[- ]running job)\b|全部测试|完整测试|全量测试|运行.*测试|整个仓库.*(?:测试|格式化)|校验和|长时间任务|完整基准测试/i;
const FULL_TEST_PATTERNS: RegExp[] = [
  /^\s*(?:python(?:3)?\s+-m\s+)?pytest(?:\s+-[\w=-]+)*\s*$/i,
  /^\s*(?:npm|pnpm|yarn)\s+(?:test|run\s+test)(?:\s+--?(?:silent|runInBand))?\s*$/i,
  /^\s*cargo\s+test(?:\s+--(?:workspace|all|all-targets))*\s*$/i,
  /^\s*go\s+test\s+\.\/\.\.\.\s*$/i,
  /^\s*(?:tox|nox|make\s+test)\s*$/i,
];
const CHECKSUM_PATTERN = /\b(?:sha(?:1|224|256|384|512)sum|md5sum|shasum|certutil\s+-hashfile)\b/i;
const REPO_FORMAT_PATTERN =
  /\b(?:prettier|eslint|biome)\b[^\n]*(?:--write\s+\.\b|--fix\s+\.\b|\s\.\s*$)|\bcargo\s+fmt\b[^\n]*--all\b/i;
const BROAD_LINT_PATTERN = /^\s*(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:lint|format)\s*$/i;
const LONG_JOB_PATTERN = /\b(?:torchrun|deepspeed|accelerate\s+launch|sbatch|qsub)\b/i;
const REPRO_MANIFEST_PATTERN = /\b(?:pip\s+freeze|conda\s+env\s+export|npm\s+shrinkwrap)\b/i;
const REPRODUCTION_INTENT =
  /\b(?:please\s+)?(?:reproduce|replicate)\b|\b(?:run|execute)\b.{0,30}\b(?:official experiment|reference protocol|paper result|baseline)\b|(?:请|帮我|开始|继续|重新|运行|执行).{0,20}(?:复现|官方实验|论文实验|基准实验)/i;
const REPRODUCTION_META_DISCUSSION =
  /\b(?:analy[sz]e|explain|discuss|review|policy|guard)\b.{0,50}\b(?:reproduc|replicat)|(?:分析|解释|讨论|修正|规则|策略|插件).{0,40}(?:复现|官方实验)|(?:复现|官方实验).{0,40}(?:问题|事故|坑|规则|策略)/i;
const EXPLICIT_DIAGNOSTIC_REJECTION =
  /\b(?:do not|don't|never|without)\b.{0,30}\b(?:diagnostic|smoke test|small[- ]sample|subset)\b|(?:不要|禁止|不能|不允许).{0,20}(?:小样本|子集|抽样|缩小)/i;
const EXPLICIT_DIAGNOSTIC_AUTHORIZATION =
  /\b(?:use|run|allow|approve|perform|start with)\b.{0,30}\b(?:diagnostic|smoke test|small[- ]sample|reduced subset|quick subset)\b|(?:允许|可以|先|只用|使用).{0,20}(?:小样本|子集|抽样|\d+\s*(?:条|个)?样本)/i;
const SAMPLE_SCOPE_REDUCTION =
  /--(?:max[_-]?(?:train[_-]?|eval[_-]?)?samples?|num[_-]?samples?|data[_-]?limit|subset[_-]?size|max[_-]?steps|num[_-]?seeds?|repeats?)\s*(?:=|\s)\s*\d+|\b(?:max[_-]?(?:train[_-]?|eval[_-]?)?samples?|num[_-]?samples?|data[_-]?limit|subset[_-]?size|sample[_-]?count|dataset[_-]?size|max[_-]?steps|num[_-]?seeds?|repeats?)\s*[:=]\s*\d+|\bhead\s+-n\s+\d+|\.select\s*\(\s*range\s*\(\s*\d+|\.take\s*\(\s*\d+|\[\s*:\s*\d+\s*\]/i;

export function evaluateResearchFidelity(toolName: string, input: unknown, userPrompt: string): GateDecision {
  if (
    !REPRODUCTION_INTENT.test(userPrompt)
    || REPRODUCTION_META_DISCUSSION.test(userPrompt)
    || (!EXPLICIT_DIAGNOSTIC_REJECTION.test(userPrompt) && EXPLICIT_DIAGNOSTIC_AUTHORIZATION.test(userPrompt))
  ) {
    return { block: false };
  }
  if (!/^(?:bash|edit|write)$/.test(toolName)) return { block: false };

  const serialized = typeof input === "string" ? input : JSON.stringify(input);
  if (!SAMPLE_SCOPE_REDUCTION.test(serialized)) return { block: false };
  return {
    block: true,
    reason:
      "Research fidelity guard blocked an unapproved protocol reduction. State the reference scope, proposed scope, reason, and inferential limits, then obtain explicit user approval before changing it.",
  };
}

export function evaluateResearchCommand(command: string, userPrompt: string): GateDecision {
  if (EXPLICIT_BROAD_WORK.test(userPrompt)) return { block: false };

  const segments = command.split(/(?:&&|\|\||;|\r?\n)/).map((segment) => segment.trim()).filter(Boolean);
  if (segments.some((segment) => FULL_TEST_PATTERNS.some((pattern) => pattern.test(segment)))) {
    return {
      block: true,
      reason: "Research Loop blocked a repository-wide test run. Use targeted validation tied to the current task.",
    };
  }
  if (CHECKSUM_PATTERN.test(command) || REPRO_MANIFEST_PATTERN.test(command)) {
    if (REPRODUCTION_INTENT.test(userPrompt)) return { block: false };
    return {
      block: true,
      reason: "Research Loop blocked bookkeeping that is not needed for the next insight.",
    };
  }
  if (REPO_FORMAT_PATTERN.test(command) || BROAD_LINT_PATTERN.test(command)) {
    return {
      block: true,
      reason: "Research Loop blocked repository-wide formatting or linting. Restrict it to the changed surface.",
    };
  }
  if (LONG_JOB_PATTERN.test(command)) {
    if (REPRODUCTION_INTENT.test(userPrompt)) return { block: false };
    return {
      block: true,
      reason: "Research Loop blocked a likely long-running job. Ask before escalating cost.",
    };
  }
  return { block: false };
}

const BASE_POLICY = `Core constraints:
- Optimize for time-to-insight without weakening the claim being tested.
- Avoid unrelated refactors, broad validation, bookkeeping, and speculative infrastructure.
- Ordinary conversation, code maintenance, documentation, and software validation are not experiments.

Research fidelity:
- For reproduction or reference comparisons, preserve data scope, split, sampling, preprocessing, model/checkpoint, objective, evaluation, seeds/repeats, and material hyperparameters.
- Before execution, triangulate the official paper (including appendix/supplement), the repository README at the relevant commit/tag, and relevant open and closed GitHub issues.
- Record exact citations, revisions, issue links, and source-specific protocol guidance. Disclose conflicts and ask the user when they materially change the target protocol.
- A reduced wiring run is a separate diagnostic, never reproduction evidence. Disclose and obtain approval for every protocol deviation.`;

const MODE_POLICY: Record<Exclude<WorkMode, "experiment">, string> = {
  normal: `Normal Mode:
- Use ordinary collaboration: answer, implement, review, or maintain the project directly.
- Do not add a special report structure or create a research checkpoint.
- Switch mode only when the dominant work changes.`,
  brainstorming: `Brainstorming Mode:
- Expand the decision space before implementation: frame the problem, generate distinct options, compare tradeoffs, expose assumptions and unknowns, then recommend a direction.
- Do not edit code or run empirical experiments by default.
- Produce a compact Decision Map when the exploration converges.
- Switch to Exploration for systematic code understanding, Normal for implementation, or Experiment when empirical evidence is required.`,
  exploration: `Exploration Mode:
- Build a researcher's minimum sufficient understanding of the project or experiment code; do not produce a file-by-file summary.
- Include only information needed to write faithful pseudocode, reproduce the result, or interpret how a change could alter the scientific conclusion.
- Produce an Experiment Blueprint covering objective, execution path, data pipeline, model/algorithm, pseudocode, loss, optimization, key hyperparameters, variables/controls, evaluation, randomness, artifacts, caveats, and unresolved source conflicts.
- Prefer read-only inspection and static introspection. Before running anything that can produce scientific evidence, switch to Experiment Mode.`,
};

function experimentPolicy(experiment?: ExperimentContext): string {
  const plan = experiment
    ? `\nActive experiment:\n- Title: ${experiment.title}\n- Question: ${experiment.question}\n- Intent: ${experiment.intent}\n- Planned data scope: ${experiment.plannedDataScope}${experiment.reference ? `\n- Reference: ${experiment.reference}` : ""}`
    : "";
  return `Experiment Mode:
- Run empirical work needed to answer the declared Research Question. Multiple related experiments may share this mode.
- Keep diagnostic and reproduction claims separate and curate only understood evidence.
- Do not leave Experiment Mode silently. Finish with research_checkpoint, or use research_abort_experiment only when no interpretable evidence was produced.
- Call research_checkpoint alone in its final tool batch when evidence changes the hypothesis, next experiments branch or materially increase cost, or uncertainty stops decreasing.
- The checkpoint must report every completed experiment, actual scope, source coverage, protocol deviations, structured results, analysis, uncertainty, and next work.${plan}`;
}

export function researchPolicy(
  mode: WorkMode,
  actions: number,
  softReview: boolean,
  objective?: string,
  experiment?: ExperimentContext,
): string {
  const modePolicy = mode === "experiment" ? experimentPolicy(experiment) : MODE_POLICY[mode];
  const objectiveLine = objective ? `\nCurrent objective: ${objective}\n` : "";
  const review = softReview
    ? "\n\nSOFT REVIEW:\nThis is a non-blocking semantic check, not a checkpoint trigger or action limit. Tool count cannot create checkpoint eligibility. Reassess evidence, uncertainty, branching, and next-experiment cost; continue the experiment uninterrupted when it is incomplete and no semantic checkpoint condition applies."
    : "";
  return `[RESEARCH LOOP | ${mode.toUpperCase()} MODE]\n\nRound activity: ${actions} tool actions. There is no hard action limit.${objectiveLine}\n${BASE_POLICY}\n\n${modePolicy}${review}`;
}

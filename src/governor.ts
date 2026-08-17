export type ResearchMode = "fast" | "normal" | "off";

export interface GateDecision {
  block: boolean;
  reason?: string;
}

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

export function evaluateFastCommand(command: string, userPrompt: string): GateDecision {
  if (EXPLICIT_BROAD_WORK.test(userPrompt)) return { block: false };

  const commandSegments = command
    .split(/(?:&&|\|\||;|\r?\n)/)
    .map((segment) => segment.trim())
    .filter(Boolean);

  if (commandSegments.some((segment) => FULL_TEST_PATTERNS.some((pattern) => pattern.test(segment)))) {
    return {
      block: true,
      reason:
        "Research Fast Mode blocked a repository-wide test run. Run one targeted test or a small probe tied to the current hypothesis, then checkpoint.",
    };
  }

  if (CHECKSUM_PATTERN.test(command) || REPRO_MANIFEST_PATTERN.test(command)) {
    return {
      block: true,
      reason:
        "Research Fast Mode blocked reproducibility bookkeeping that is not needed for the next insight. Continue with the minimal experiment unless the user explicitly requested this metadata.",
    };
  }

  if (REPO_FORMAT_PATTERN.test(command) || BROAD_LINT_PATTERN.test(command)) {
    return {
      block: true,
      reason:
        "Research Fast Mode blocked repository-wide formatting or linting. Restrict validation to the file or experiment changed in this research round.",
    };
  }

  if (LONG_JOB_PATTERN.test(command)) {
    return {
      block: true,
      reason:
        "Research Fast Mode blocked a likely long-running job. First run a small local sample, short step count, or dry probe; ask the user before escalating cost.",
    };
  }

  return { block: false };
}

export function researchPolicy(
  mode: Exclude<ResearchMode, "off">,
  actions: number,
  checkpointReview: boolean,
): string {
  const fastRules = mode === "fast"
    ? `\nFAST constraints:\n- Prefer the smallest executable probe, targeted read, small sample, or one-variable change.\n- Avoid unrelated refactors, broad tests, repository-wide formatting, checksums, environment manifests, exhaustive benchmarks, and speculative infrastructure.\n- Validation cost must match the importance of the current claim.`
    : `\nNORMAL constraints:\n- Keep the research loop and semantic checkpoints, but use fuller validation when it materially strengthens the current conclusion.`;
  const review = checkpointReview
    ? `\n\nCHECKPOINT REVIEW:\nThis review applies only if the current user request has already caused you to run an empirical research experiment. If no such experiment has started, ignore checkpoint semantics and continue the ordinary task. If eligible, reassess whether meaningful evidence exists, the hypothesis changed, a decision branch appeared, uncertainty stopped decreasing, or the next experiment materially increases cost.`
    : "";

  return `[RESEARCH ${mode.toUpperCase()} MODE]\nOptimize for time-to-insight.\nAvoid unnecessary defensive engineering.\nReturn control after meaningful experimental evidence.\n\nRound activity: ${actions} tool actions. There is no hard action limit; choose checkpoint timing from research semantics, not the counter.${fastRules}${review}\n\nCheckpoint eligibility:\n- First judge from the user's intent whether this conversation is asking you to conduct empirical research, and whether you have actually begun running an experiment to answer that research question.\n- A checkpoint is eligible only after at least one such experiment has been run. The Agent makes this judgment; tool count alone never creates eligibility.\n- Ordinary conversation, questions, planning, code maintenance, documentation, and tests that merely validate software changes are not research experiments. Do not checkpoint these tasks.\n- If a costly experiment is only being proposed and none has run yet, ask for approval in a normal response rather than creating a checkpoint.\n\nCheckpoint rules once eligible:\n- Autonomously call research_checkpoint when experimental evidence meaningfully changes or supports the hypothesis.\n- Also consider it when experimental next steps branch, uncertainty stops decreasing, experimental progress stalls, or the next experiment materially increases cost.\n- Continue without checkpoint while the current minimal experiment is incomplete and no semantic trigger applies.\n- research_checkpoint must be the only tool call in its final batch. Do not continue automatically after it.\n- Write a report-style checkpoint with Research Question, Condition & Result, Overall Analysis, Uncertainty, Next, and Relevant Artifacts.\n- Include every key experiment completed since the previous checkpoint or user calibration, in execution order. Do not include older experiments or proposed work as completed experiments.\n- For each experiment, explain why it was needed, the design and controls, the observed result, and the experiment-specific analysis. Include only setup, variables, and hyperparameters needed to understand the evidence.\n- Put quantitative comparisons in structured result tables with justified significant digits. Associate images, tables, and datasets with the experiment they support.\n- Exclude Slurm, queue, GPU allocation, logging, and orchestration settings unless systems behavior is the research subject.\n- Synthesize what the experiments establish together, then state remaining uncertainty and concrete next work separately.\n- Do not attach files merely because they were generated. Add only understood, relevant results with a clear title, role, description, and experiment association when applicable.\n- For a dataset, attach its root directory or data file and name the columns relevant to the research question.`;
}

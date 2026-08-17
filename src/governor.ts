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
    ? `\n\nCHECKPOINT REVIEW:\nYou have completed another interval of tool actions. Reassess now whether meaningful evidence exists, the hypothesis changed, a decision branch appeared, uncertainty stopped decreasing, or the next action materially increases cost. If none apply and the current minimal experiment is still incomplete, continue without checkpoint.`
    : "";

  return `[RESEARCH ${mode.toUpperCase()} MODE]\nOptimize for time-to-insight.\nAvoid unnecessary defensive engineering.\nReturn control after meaningful evidence.\n\nRound activity: ${actions} tool actions. There is no hard action limit; choose checkpoint timing from research semantics, not the counter.${fastRules}${review}\n\nCheckpoint rules:\n- Call research_checkpoint when meaningful evidence changes or supports the hypothesis.\n- Call it when next steps branch, uncertainty stops decreasing, progress stalls, or before a materially more expensive action.\n- Continue without checkpoint while the same minimal experiment is incomplete and no semantic checkpoint trigger applies.\n- research_checkpoint must be the only tool call in its final batch. Do not continue automatically after it.\n- State the hypothesis, main result, analysis, remaining uncertainty, and one concrete next action.\n- When an experiment was run, report the key experiment completed since the previous checkpoint or user calibration, not an older experiment or a proposed next experiment.\n- Record why it was needed, its design, essential setup needed to understand it (for example model, data, loss, optimizer, and evaluation protocol), key variables, and experiment-only hyperparameters. Exclude Slurm, queue, GPU allocation, logging, and orchestration settings unless systems behavior is the research subject.\n- Put numeric headline results in structured metrics with justified significant digits. Keep the main result separate from its analysis.\n- Do not attach files merely because they were generated. Add only understood, relevant entries to research_checkpoint.results, with a clear title, role, description, and takeaway when available.\n- For a dataset, attach its root directory or data file and name the columns relevant to the current hypothesis.`;
}

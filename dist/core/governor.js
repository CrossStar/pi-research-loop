const EXPLICIT_BROAD_WORK = /\b(?:all tests|full test suite|run (?:the )?entire test|repository[- ]wide|repo[- ]wide|checksum|sha256|exhaustive benchmark|long[- ]running job)\b|全部测试|完整测试|全量测试|运行.*测试|整个仓库.*(?:测试|格式化)|校验和|长时间任务|完整基准测试/i;
const FULL_TEST_PATTERNS = [
    /^\s*(?:python(?:3)?\s+-m\s+)?pytest(?:\s+-[\w=-]+)*\s*$/i,
    /^\s*(?:npm|pnpm|yarn)\s+(?:test|run\s+test)(?:\s+--?(?:silent|runInBand))?\s*$/i,
    /^\s*cargo\s+test(?:\s+--(?:workspace|all|all-targets))*\s*$/i,
    /^\s*go\s+test\s+\.\/\.\.\.\s*$/i,
    /^\s*(?:tox|nox|make\s+test)\s*$/i,
];
const CHECKSUM_PATTERN = /\b(?:sha(?:1|224|256|384|512)sum|md5sum|shasum|certutil\s+-hashfile)\b/i;
const REPO_FORMAT_PATTERN = /\b(?:prettier|eslint|biome)\b[^\n]*(?:--write\s+\.\b|--fix\s+\.\b|\s\.\s*$)|\bcargo\s+fmt\b[^\n]*--all\b/i;
const BROAD_LINT_PATTERN = /^\s*(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:lint|format)\s*$/i;
const LONG_JOB_PATTERN = /\b(?:torchrun|deepspeed|accelerate\s+launch|sbatch|qsub)\b/i;
const REPRO_MANIFEST_PATTERN = /\b(?:pip\s+freeze|conda\s+env\s+export|npm\s+shrinkwrap)\b/i;
const REPRODUCTION_INTENT = /\b(?:please\s+)?(?:reproduce|replicate)\b|\b(?:run|execute)\b.{0,30}\b(?:official experiment|reference protocol|paper result|baseline)\b|(?:请|帮我|开始|继续|重新|运行|执行).{0,20}(?:复现|官方实验|论文实验|基准实验)/i;
const REPRODUCTION_META_DISCUSSION = /\b(?:analy[sz]e|explain|discuss|review|policy|guard)\b.{0,50}\b(?:reproduc|replicat)|(?:分析|解释|讨论|修正|规则|策略|插件).{0,40}(?:复现|官方实验)|(?:复现|官方实验).{0,40}(?:问题|事故|坑|规则|策略)/i;
const EXPLICIT_DIAGNOSTIC_REJECTION = /\b(?:do not|don't|never|without)\b.{0,30}\b(?:diagnostic|smoke test|small[- ]sample|subset)\b|(?:不要|禁止|不能|不允许).{0,20}(?:小样本|子集|抽样|缩小)/i;
const EXPLICIT_DIAGNOSTIC_AUTHORIZATION = /\b(?:use|run|allow|approve|perform|start with)\b.{0,30}\b(?:diagnostic|smoke test|small[- ]sample|reduced subset|quick subset)\b|(?:允许|可以|先|只用|使用).{0,20}(?:小样本|子集|抽样|\d+\s*(?:条|个)?样本)/i;
const SAMPLE_SCOPE_REDUCTION = /--(?:max[_-]?(?:train[_-]?|eval[_-]?)?samples?|num[_-]?samples?|data[_-]?limit|subset[_-]?size|max[_-]?steps|num[_-]?seeds?|repeats?)\s*(?:=|\s)\s*\d+|\b(?:max[_-]?(?:train[_-]?|eval[_-]?)?samples?|num[_-]?samples?|data[_-]?limit|subset[_-]?size|sample[_-]?count|dataset[_-]?size|max[_-]?steps|num[_-]?seeds?|repeats?)\s*[:=]\s*\d+|\bhead\s+-n\s+\d+|\.select\s*\(\s*range\s*\(\s*\d+|\.take\s*\(\s*\d+|\[\s*:\s*\d+\s*\]/i;
export function evaluateResearchFidelity(toolName, input, userPrompt) {
    if (!REPRODUCTION_INTENT.test(userPrompt)
        || REPRODUCTION_META_DISCUSSION.test(userPrompt)
        || (!EXPLICIT_DIAGNOSTIC_REJECTION.test(userPrompt) && EXPLICIT_DIAGNOSTIC_AUTHORIZATION.test(userPrompt))) {
        return { block: false };
    }
    if (!/^(?:bash|edit|write)$/.test(toolName))
        return { block: false };
    const serialized = typeof input === "string" ? input : JSON.stringify(input);
    if (!SAMPLE_SCOPE_REDUCTION.test(serialized))
        return { block: false };
    const reason = "This reproduction reduces samples, steps, seeds, or repeats without approval. Tell the user the original and proposed settings, why they would change, and how that affects the result, then obtain explicit approval.";
    return {
        block: true,
        reason,
        approval: {
            kind: "protocol-deviation",
            title: "Approve protocol deviation?",
            message: [
                "Research Loop detected a reduced reproduction scope. Approving allows this exact action, but the run must be reported as diagnostic or as an explicit protocol deviation.",
                "",
                preview(serialized),
            ].join("\n"),
            declineReason: "User declined the reproduction protocol deviation.",
        },
    };
}
export function evaluateResearchCommand(command, userPrompt) {
    if (EXPLICIT_BROAD_WORK.test(userPrompt))
        return { block: false };
    const segments = command.split(/(?:&&|\|\||;|\r?\n)/).map((segment) => segment.trim()).filter(Boolean);
    if (segments.some((segment) => FULL_TEST_PATTERNS.some((pattern) => pattern.test(segment)))) {
        return {
            block: true,
            reason: "Research Loop blocked a repository-wide test run. Use targeted validation tied to the current task.",
        };
    }
    if (CHECKSUM_PATTERN.test(command) || REPRO_MANIFEST_PATTERN.test(command)) {
        if (REPRODUCTION_INTENT.test(userPrompt))
            return { block: false };
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
        if (REPRODUCTION_INTENT.test(userPrompt))
            return { block: false };
        const reason = "Research Loop requires user approval before starting a likely long-running job.";
        return {
            block: true,
            reason,
            approval: {
                kind: "cost-escalation",
                title: "Approve costly execution?",
                message: [
                    "This command may start a long-running or scheduled job. Approve this exact execution?",
                    "",
                    preview(command),
                ].join("\n"),
                declineReason: "User declined the long-running job.",
            },
        };
    }
    return { block: false };
}
function preview(value, maximum = 600) {
    const compact = value.trim();
    return compact.length <= maximum ? compact : `${compact.slice(0, maximum)}…`;
}
const MODE_GUIDANCE = {
    brainstorming: "Compare genuinely different options and recommend a direction. Do not edit files or run empirical work in this mode.",
    exploration: "Read only the code and materials relevant to the current objective. Trace the necessary behavior and return the findings directly with useful file references. Switch to Experiment before empirical work.",
};
function experimentGuidance(experiment) {
    const details = experiment
        ? [
            `Title: ${experiment.title}`,
            `Question: ${experiment.question}`,
            `Intent: ${experiment.intent}`,
            `Planned data: ${experiment.plannedDataScope}`,
            ...(experiment.reference ? [`Reference: ${experiment.reference}`] : []),
        ].join("\n")
        : "";
    const reproduction = experiment?.intent === "reproduction"
        ? "\nBefore running this reproduction, check the official paper, the matching repository README, and relevant issues. Keep the referenced data, split, preprocessing, model or checkpoint, objective, evaluation, seeds, repeats, and material settings. Ask before changing them; a reduced run is diagnostic rather than a reproduction result."
        : "";
    return `Run the work needed to answer the experiment question and record what actually happened. Finish with research_checkpoint, or use research_abort_experiment only if no interpretable result was produced.${details ? `\n${details}` : ""}${reproduction}`;
}
export function researchPolicy(mode, _actions, _softReview, objective, experiment) {
    const guidance = mode === "experiment" ? experimentGuidance(experiment) : MODE_GUIDANCE[mode];
    return [
        `[RESEARCH LOOP: ${mode.toUpperCase()}]`,
        ...(objective ? [`Objective: ${objective}`] : []),
        guidance,
        "Start with the work or findings. Do not narrate Research Loop or mode changes unless the user needs to make a decision.",
    ].join("\n");
}

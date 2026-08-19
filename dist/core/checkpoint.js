import { formatSignificant, formatTable } from "../table.js";
const INFRASTRUCTURE_FIELD = /(?:^|[._-])(?:slurm|partition|qos|account|job[_-]?name|node(?:s)?|ntasks|cpus?[_-]?per[_-]?task|gres|walltime|time[_-]?limit)(?:$|[._-])/i;
const SYSTEMS_RESEARCH = /\b(?:slurm|scheduler|scheduling|cluster throughput|cluster utilization|distributed scaling)\b|系统性能|集群吞吐|调度/i;
export function normalizeCheckpointExperiment(experiment, hypothesis) {
    const normalized = {
        ...experiment,
        setup: experiment.setup ?? [],
        variables: experiment.variables ?? [],
        parameters: experiment.parameters ?? [],
        tables: experiment.tables ?? [],
    };
    if (SYSTEMS_RESEARCH.test(`${hypothesis}\n${normalized.rationale}\n${normalized.design}`))
        return normalized;
    return {
        ...normalized,
        setup: normalized.setup.filter((detail) => !INFRASTRUCTURE_FIELD.test(detail.name)),
        parameters: normalized.parameters.filter((parameter) => !INFRASTRUCTURE_FIELD.test(parameter.name)),
    };
}
export function validateCheckpoint(details) {
    const errors = [];
    const warnings = [];
    if (details.experiments.length === 0)
        errors.push("A checkpoint requires at least one completed experiment.");
    details.experiments.forEach((experiment, index) => {
        const label = `Experiment ${index + 1} (${experiment.title})`;
        if (!experiment.observation.trim())
            errors.push(`${label} requires an empirical observation.`);
        if (!experiment.analysis.trim())
            errors.push(`${label} requires evidence analysis.`);
        if (experiment.protocol.intent === "reproduction") {
            const requiredKinds = ["paper", "readme", "issue"];
            for (const kind of requiredKinds) {
                if (!experiment.protocol.sources.some((source) => source.kind === kind)) {
                    errors.push(`${label} is a reproduction but has no ${kind} source coverage.`);
                }
            }
            if (!experiment.protocol.reference)
                warnings.push(`${label} does not identify its reference protocol.`);
        }
        for (const deviation of experiment.protocol.deviations) {
            if (!deviation.approvedByUser) {
                warnings.push(`${label} contains an unapproved protocol deviation: ${deviation.field}.`);
            }
        }
    });
    return { valid: errors.length === 0, errors, warnings };
}
export function formatCheckpointReport(details) {
    const sections = [
        `# Checkpoint: ${details.title}`,
        `## Research Question\n\n${details.researchQuestion}\n\nWorking hypothesis: ${details.hypothesis}`,
    ];
    const experimentReports = details.experiments.map((experiment, index) => {
        const parts = [
            `### Experiment ${index + 1} - ${experiment.title}`,
            experiment.rationale,
            experiment.design,
        ];
        const experimentDetails = formatExperimentDetails(experiment);
        if (experimentDetails)
            parts.push(`Experimental Details\n\n${experimentDetails}`);
        const protocolSources = formatProtocolSources(experiment);
        if (protocolSources)
            parts.push(`Reference Sources\n\n${protocolSources}`);
        const protocolDeviations = formatProtocolDeviations(experiment);
        if (protocolDeviations)
            parts.push(`Protocol Deviations\n\n${protocolDeviations}`);
        parts.push(experiment.observation);
        experiment.tables.forEach((table) => {
            parts.push(table.title ? `${table.title}\n\n${formatResultTable(table)}` : formatResultTable(table));
        });
        parts.push(experiment.analysis);
        details.results
            .filter((result) => result.experiment === experiment.title)
            .forEach((result) => {
            const path = result.artifact?.path ?? result.path;
            const extension = result.artifact?.extension ?? extensionOf(path);
            parts.push([".png", ".jpg", ".jpeg"].includes(extension)
                ? `![${result.title}](${path})`
                : `Related artifact: ${path}`);
        });
        return parts.join("\n\n");
    });
    sections.push(`## Condition & Result\n\n${experimentReports.join("\n\n")}`);
    const conclusion = details.conclusion
        ? `\n\n${details.conclusion.split("\n").map((line) => `> ${line}`).join("\n")}`
        : "";
    sections.push(`## Overall Analysis\n\n${details.overallAnalysis}${conclusion}`);
    sections.push(`## Uncertainty\n\n${details.uncertainty}`);
    sections.push(`## Next\n\n${details.next}`);
    if (details.results.length > 0) {
        sections.push(`## Relevant Artifacts\n\n${details.results.map((result) => `- ${result.artifact?.path ?? result.path}`).join("\n")}`);
    }
    return sections.join("\n\n");
}
export function formatExperimentDetails(experiment) {
    const protocolRows = [
        ["Protocol", "Intent", experiment.protocol.intent, "Scientific role of this run"],
        ["Protocol", "Data scope", experiment.protocol.dataScope, "Actual data used"],
        ...(experiment.protocol.reference
            ? [["Protocol", "Reference", experiment.protocol.reference, "Target protocol or result"]]
            : experiment.protocol.intent === "reproduction"
                ? [["Protocol", "Reference", "MISSING", "Reproduction reference was not supplied"]]
                : []),
    ];
    const rows = [
        ...protocolRows,
        ...experiment.setup.map((detail) => ["Setup", detail.name, detail.value, detail.description ?? ""]),
        ...experiment.variables.map((variable) => [variable.role, variable.name, variable.value ?? "", variable.description]),
        ...experiment.parameters.map((parameter) => ["Hyperparameter", parameter.name, parameter.value, parameter.rationale ?? ""]),
    ];
    return rows.length > 0
        ? formatTable(["Type", "Name", "Value / Levels", "Why it matters"], rows)
        : undefined;
}
export function formatProtocolSources(experiment) {
    const sources = experiment.protocol.sources;
    const requiredKinds = experiment.protocol.intent === "reproduction" ? ["paper", "readme", "issue"] : [];
    const missingKinds = requiredKinds.filter((kind) => !sources.some((source) => source.kind === kind));
    if (sources.length === 0 && missingKinds.length === 0)
        return undefined;
    const coverage = formatTable(["Source", "Status"], [
        ...sources.map((source) => [source.kind, source.status]),
        ...missingKinds.map((kind) => [kind, "MISSING"]),
    ]);
    const sourceDetails = [
        ...sources.map((source) => [
            `${source.kind} [${source.status}]`,
            `Reference: ${source.reference ?? (source.status === "consulted" ? "MISSING" : "(none)")}`,
            `Guidance: ${source.summary}`,
        ].join("\n")),
        ...missingKinds.map((kind) => `${kind} [MISSING]\nGuidance: Required reproduction source was not checked`),
    ];
    return `${coverage}\n\n${sourceDetails.join("\n\n")}`;
}
export function formatProtocolDeviations(experiment) {
    if (experiment.protocol.deviations.length === 0)
        return undefined;
    return formatTable(["Field", "Reference", "Actual", "Reason / Limit", "Approved"], experiment.protocol.deviations.map((deviation) => [
        deviation.field,
        deviation.reference,
        deviation.actual,
        deviation.reason,
        deviation.approvedByUser ? "yes" : "NO",
    ]));
}
export function formatResultTable(table) {
    return formatTable(table.columns, table.rows.map((row) => table.columns.map((_, index) => formatResultCell(row[index]))));
}
function formatResultCell(cell) {
    if (!cell)
        return "";
    if (cell.value !== undefined) {
        const value = formatSignificant(cell.value, cell.significantDigits ?? 4, cell.significantDigits !== undefined);
        return cell.unit ? `${value} ${cell.unit}` : value;
    }
    return cell.text ?? "";
}
function extensionOf(path) {
    const index = path.lastIndexOf(".");
    return index >= 0 ? path.slice(index).toLowerCase() : "";
}

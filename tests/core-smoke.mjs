import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveArtifactMetadata } from "../dist/core/artifacts.js";
import { ResearchCore } from "../dist/core/research-core.js";
import {
  normalizeCheckpointExperiment,
  validateCheckpoint,
} from "../dist/core/checkpoint.js";

const core = new ResearchCore();
assert.equal(core.enabled, false);
core.setEnabled(true);
assert.equal(core.workMode, "normal");

assert.equal(core.enterMode("brainstorming", "Choose a model").block, false);
assert.equal(core.evaluateToolCall("Write", { file_path: "model.py" })?.block, true);

core.startTurn();
assert.equal(core.enterMode("exploration", "Understand the experiment").block, false);
assert.match(core.policy(), /Read only the code and materials relevant to the current objective/);
assert.equal(core.evaluateToolCall("Read", { file_path: "train.py" }), undefined);
assert.equal(core.evaluateToolCall("Bash", { command: "python train.py" })?.block, true);
assert.equal(
  core.evaluateToolCall("mcp__plugin-research-loop__research_mode", {
    mode: "normal",
    objective: "Implement the understood path",
  }),
  undefined,
);
assert.equal(core.lifecycleTransitionPending, true);
assert.match(core.evaluateToolCall("Read", { file_path: "train.py" })?.reason, /transition to complete/);
core.completeLifecycleTransition();

core.startTurn();
const experiment = {
  title: "Compare optimizers",
  question: "Does optimizer A converge faster than B?",
  intent: "exploratory",
  plannedDataScope: "validation split, 100 samples, one seed",
};
assert.equal(core.enterMode("experiment", "Measure convergence", experiment).block, false);
assert.equal(core.enterMode("normal", "silently leave").block, true);

const reproductionCore = new ResearchCore();
reproductionCore.setEnabled(true);
reproductionCore.resetRequest("Please reproduce the official experiment");
assert.equal(reproductionCore.enterMode("experiment", "Reproduce the result", {
  title: "Official result",
  question: "Does the official result reproduce?",
  intent: "reproduction",
  plannedDataScope: "official dataset and split",
  reference: "paper and repository",
}).block, false);
assert.match(reproductionCore.policy(), /check the official paper/);
assert.equal(reproductionCore.evaluateToolCall("Bash", {
  command: "python train.py --max_samples 100",
})?.block, true);

const approvedDiagnostic = new ResearchCore();
approvedDiagnostic.setEnabled(true);
approvedDiagnostic.resetRequest("Please reproduce the result, but first use a small-sample diagnostic");
assert.equal(approvedDiagnostic.evaluateToolCall("Bash", {
  command: "python train.py --max_samples 100",
}), undefined);

const checkpoint = {
  title: "Optimizer A converges faster in the diagnostic scope",
  researchQuestion: experiment.question,
  hypothesis: "Optimizer A converges faster under this diagnostic scope.",
  experiments: [normalizeCheckpointExperiment({
    title: experiment.title,
    protocol: {
      intent: "exploratory",
      dataScope: experiment.plannedDataScope,
      sources: [],
      deviations: [],
    },
    rationale: "Resolve empirical convergence uncertainty.",
    design: "Compare both optimizers under identical controls.",
    observation: "Optimizer A reached the target loss in fewer steps.",
    analysis: "The observation supports the scoped hypothesis but does not establish generality.",
  }, "Optimizer A converges faster under this diagnostic scope.")],
  overallAnalysis: "Evidence favors optimizer A in the tested scope.",
  uncertainty: "One seed and a small validation scope.",
  next: "Ask whether to expand seeds and data scope.",
  results: [],
};
assert.equal(validateCheckpoint(checkpoint).valid, true);
const incompleteReproduction = structuredClone(checkpoint);
incompleteReproduction.experiments[0].protocol.intent = "reproduction";
assert.equal(validateCheckpoint(incompleteReproduction).valid, false);

const artifactDirectory = await mkdtemp(join(tmpdir(), "research-loop-artifact-"));
try {
  const artifactPath = join(artifactDirectory, "metrics.json");
  await writeFile(artifactPath, "{\"loss\": 0.1}\n", "utf8");
  const artifact = await resolveArtifactMetadata(artifactDirectory, artifactPath);
  assert.equal(artifact?.path, "metrics.json");
  assert.equal(artifact?.extension, ".json");
} finally {
  await rm(artifactDirectory, { recursive: true, force: true });
}

core.reachCheckpoint(0);
assert.equal(core.workMode, "normal");
assert.match(core.projectStatus().text, /CHECKPOINT REACHED/);

console.log("core smoke test passed");

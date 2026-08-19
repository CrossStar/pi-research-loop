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

const transitionCore = new ResearchCore();
transitionCore.setEnabled(true);
transitionCore.startTurn();
assert.equal(transitionCore.evaluateToolCall("research_mode", {}), undefined);
assert.match(
  transitionCore.evaluateToolCall("Agent", {})?.reason ?? "",
  /transition to finish/,
);
assert.equal(transitionCore.finishToolCall("research_mode"), true);
assert.equal(transitionCore.evaluateToolCall("Agent", {}), undefined);
assert.equal(transitionCore.finishToolCall("Agent"), true);
assert.equal(transitionCore.evaluateToolCall("Read", {}), undefined);
assert.equal(transitionCore.finishToolCall("Read"), true);
assert.equal(transitionCore.evaluateToolCall("research_mode", {}), undefined);

const core = new ResearchCore();
assert.equal(core.enabled, false);
core.setEnabled(true);
assert.equal(core.workMode, "normal");

assert.equal(core.enterMode("brainstorming", "Choose a model").block, false);
assert.equal(core.evaluateToolCall("Write", { file_path: "model.py" })?.block, true);

core.startTurn();
assert.equal(core.enterMode("exploration", "Understand the experiment").block, false);
assert.equal(core.evaluateToolCall("Read", { file_path: "train.py" }), undefined);
assert.equal(core.evaluateToolCall("Bash", { command: "python train.py" })?.block, true);

core.startTurn();
const experiment = {
  title: "Compare optimizers",
  question: "Does optimizer A converge faster than B?",
  intent: "exploratory",
  plannedDataScope: "validation split, 100 samples, one seed",
};
assert.equal(core.enterMode("experiment", "Measure convergence", experiment).block, false);
assert.equal(core.enterMode("normal", "silently leave").block, true);

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

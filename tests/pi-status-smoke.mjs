import assert from "node:assert/strict";
import { ResearchCore } from "../dist/core/research-core.js";
import { renderPiResearchStatus } from "../src/pi-status.ts";

const plainTheme = { fg: (_color, text) => text };

const off = new ResearchCore();
assert.equal(renderPiResearchStatus(off.snapshot(), plainTheme), "◇ research  off");

const normal = new ResearchCore();
normal.setEnabled(true);
normal.evaluateToolCall("read", { path: "README.md" });
assert.equal(
  renderPiResearchStatus(normal.snapshot(), plainTheme),
  "◇ research  normal · 1 action · 0 outputs",
);

const brainstorming = new ResearchCore();
brainstorming.setEnabled(true);
brainstorming.enterMode("brainstorming", "Compare directions");
assert.equal(
  renderPiResearchStatus(brainstorming.snapshot(), plainTheme),
  "◇ research  brainstorming · read only",
);

const exploration = new ResearchCore();
exploration.setEnabled(true);
exploration.enterMode("exploration", "Map the implementation");
assert.equal(
  renderPiResearchStatus(exploration.snapshot(), plainTheme),
  "◇ research  exploration · blueprint",
);

const experiment = new ResearchCore();
experiment.setEnabled(true);
experiment.enterMode("experiment", "Reproduce the baseline", {
  title: "Baseline reproduction",
  question: "Does the baseline match the reference?",
  intent: "reproduction",
  plannedDataScope: "official evaluation split",
});
experiment.upsertArtifact({
  path: "results/metrics.json",
  kind: "file",
  extension: ".json",
  size: 128,
  modifiedAt: Date.now(),
});
for (let index = 0; index < 6; index += 1) {
  experiment.evaluateToolCall("read", { path: `result-${index}.json` });
}
assert.equal(
  renderPiResearchStatus(experiment.snapshot(), plainTheme),
  "◆ research  experiment · reproduction · 6 actions · 1 output · review due",
);

experiment.reachCheckpoint(2);
assert.equal(
  renderPiResearchStatus(experiment.snapshot(), plainTheme),
  "◆ research  checkpoint · 2 results",
);

const styledTheme = { fg: (color, text) => `<${color}>${text}</${color}>` };
const styled = renderPiResearchStatus(experiment.snapshot(), styledTheme);
assert.match(styled, /<success>◆<\/success>/);
assert.match(styled, /<accent>research<\/accent>/);
assert.match(styled, /<text>2 results<\/text>/);

console.log("Pi status smoke test passed");

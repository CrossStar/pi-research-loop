import assert from "node:assert/strict";
import { build } from "esbuild";

const bundle = await build({
  entryPoints: ["src/runtime.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  write: false,
});
const source = bundle.outputFiles[0]?.text;
assert.ok(source, "runtime bundle was not generated");
const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const {
  ResearchRuntime,
  shouldAbortForCancelledQuestionnaire,
} = await import(moduleUrl);

assert.equal(
  shouldAbortForCancelledQuestionnaire("ask_user_question", { cancelled: true, answers: [] }),
  true,
);
assert.equal(
  shouldAbortForCancelledQuestionnaire("ask_user_question", { cancelled: true, error: "no_ui" }),
  false,
);
assert.equal(shouldAbortForCancelledQuestionnaire("read", { cancelled: true }), false);

const statusCalls = [];
const widgetCalls = [];
const notifications = [];
const confirmations = [];
let abortCount = 0;
let activeTools = ["read", "write", "ask_user_question"];
const entries = [];
const pi = {
  appendEntry(customType, data) { entries.push({ customType, data }); },
  getActiveTools() { return [...activeTools]; },
  setActiveTools(tools) { activeTools = [...tools]; },
};
const theme = { fg: (_color, text) => text };
const ctx = {
  hasUI: true,
  abort() { abortCount += 1; },
  sessionManager: { getBranch: () => [] },
  ui: {
    theme,
    async confirm(title, message) {
      confirmations.push({ title, message });
      return true;
    },
    setStatus(id, value) { statusCalls.push({ id, value }); },
    setWidget(id, value) { widgetCalls.push({ id, value }); },
    notify(message, level) { notifications.push({ message, level }); },
  },
};

const runtime = new ResearchRuntime(pi);
runtime.startSession(ctx);
assert.deepEqual(widgetCalls.at(-1), { id: "research-loop-status", value: undefined });
assert.deepEqual(statusCalls.at(-1), { id: "research-loop", value: "◇ research  off" });

runtime.setEnabled(true, ctx);
assert.deepEqual(statusCalls.at(-1), {
  id: "research-loop",
  value: "◇ research  exploration · read only",
});
assert.equal(activeTools.includes("research_mode"), true);
assert.equal(activeTools.includes("ask_user_question"), true);
assert.match(runtime.policy(), /ask_user_question is available/);
assert.doesNotMatch(runtime.policy(), /\[EXPERIMENT CODE\]/);
activeTools = activeTools.filter((name) => name !== "ask_user_question");
assert.doesNotMatch(runtime.policy(), /ask_user_question is available/);
activeTools.push("ask_user_question");
assert.match(notifications.at(-1).message, /Research Loop: ON/);
assert.equal(entries.at(-1).customType, "research-loop-state");
runtime.setUserDecisionPending(true, ctx);
assert.match(statusCalls.at(-1).value, /waiting for decision/);
runtime.setUserDecisionPending(false, ctx);

await runtime.evaluateToolCall("read", { path: "README.md" }, ctx);
assert.deepEqual(statusCalls.at(-1), {
  id: "research-loop",
  value: "◇ research  exploration · read only",
});

runtime.enterMode("brainstorming", "Compare implementation paths", undefined, ctx);
assert.deepEqual(statusCalls.at(-1), {
  id: "research-loop",
  value: "◇ research  brainstorming · read only",
});

const firstBlockedWrite = await runtime.evaluateToolCall("write", { path: "notes.md" }, ctx);
assert.equal(firstBlockedWrite?.block, true);
assert.match(firstBlockedWrite?.reason, /Do not retry/);
assert.equal(abortCount, 0);
const repeatedBlockedWrite = await runtime.evaluateToolCall("write", { path: "notes.md" }, ctx);
assert.equal(repeatedBlockedWrite?.block, true);
assert.match(repeatedBlockedWrite?.reason, /control returned to the user/);
assert.equal(abortCount, 1);
runtime.resetRequest("Try the action again with a new instruction", ctx);
const retriedAfterUserRequest = await runtime.evaluateToolCall("write", { path: "notes.md" }, ctx);
assert.equal(retriedAfterUserRequest?.block, true);
assert.equal(abortCount, 1);

runtime.enterMode("experiment", "Run a scheduled evaluation", {
  title: "Scheduled evaluation",
  question: "Does the official model reproduce the expected result?",
  intent: "diagnostic",
  plannedDataScope: "official evaluation split",
}, ctx);
const experimentPolicy = runtime.policy();
assert.match(experimentPolicy, /\[EXPERIMENT CODE\]/);
assert.match(experimentPolicy, /top-level main\(\) mirror the natural experiment phases/);
assert.match(experimentPolicy, /must use Rich/);
assert.match(experimentPolicy, /Use tqdm/);
assert.match(experimentPolicy, /--quick or --smoke/);
assert.match(experimentPolicy, /summary\.json, per_seed\.csv/);
assert.match(experimentPolicy, /Avoid factories, registries, strategy\/context hierarchies/);
activeTools = activeTools.filter((name) => name !== "ask_user_question");
assert.match(runtime.policy(), /\[EXPERIMENT CODE\]/);
assert.doesNotMatch(runtime.policy(), /\[RESEARCH DECISIONS\]/);
activeTools.push("ask_user_question");
const confirmationCount = confirmations.length;
const scheduled = await runtime.evaluateToolCall("bash", {
  command: "sbatch repro/official_models/eval_obfuscated_activations.sbatch",
}, ctx);
assert.equal(scheduled, undefined);
const distributed = await runtime.evaluateToolCall("bash", {
  command: "torchrun --nproc-per-node=4 experiment.py",
}, ctx);
assert.equal(distributed, undefined);
assert.equal(confirmations.length, confirmationCount);
assert.equal(abortCount, 1);

runtime.clearStatus(ctx);
assert.deepEqual(widgetCalls.at(-1), { id: "research-loop-status", value: undefined });
assert.deepEqual(statusCalls.at(-1), { id: "research-loop", value: undefined });

console.log("Pi runtime smoke test passed");

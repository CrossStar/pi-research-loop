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
const { ResearchRuntime } = await import(moduleUrl);

const statusCalls = [];
const widgetCalls = [];
const notifications = [];
let activeTools = ["read", "write"];
const entries = [];
const pi = {
  appendEntry(customType, data) { entries.push({ customType, data }); },
  getActiveTools() { return [...activeTools]; },
  setActiveTools(tools) { activeTools = [...tools]; },
};
const theme = { fg: (_color, text) => text };
const ctx = {
  sessionManager: { getBranch: () => [] },
  ui: {
    theme,
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
  value: "◇ research  normal · 0 actions · 0 outputs",
});
assert.equal(activeTools.includes("research_mode"), true);
assert.match(notifications.at(-1).message, /Research Loop: ON/);
assert.equal(entries.at(-1).customType, "research-loop-state");

runtime.evaluateToolCall("read", { path: "README.md" }, ctx);
assert.deepEqual(statusCalls.at(-1), {
  id: "research-loop",
  value: "◇ research  normal · 1 action · 0 outputs",
});

runtime.enterMode("exploration", "Map the implementation", undefined, ctx);
assert.deepEqual(statusCalls.at(-1), {
  id: "research-loop",
  value: "◇ research  exploration · read only",
});

runtime.clearStatus(ctx);
assert.deepEqual(widgetCalls.at(-1), { id: "research-loop-status", value: undefined });
assert.deepEqual(statusCalls.at(-1), { id: "research-loop", value: undefined });

console.log("Pi runtime smoke test passed");

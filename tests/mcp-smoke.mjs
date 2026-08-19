import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const project = await mkdtemp(join(tmpdir(), "pi-research-loop-mcp-"));
const environment = Object.fromEntries(
  Object.entries(process.env).filter((entry) => typeof entry[1] === "string"),
);
environment.CLAUDE_PROJECT_DIR = project;

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve("dist/claude/mcp-server.js")],
  env: environment,
});
const client = new Client({ name: "pi-research-loop-smoke", version: "0.1.0" });

try {
  await client.connect(transport);
  const tools = await client.listTools();
  const names = new Set(tools.tools.map((tool) => tool.name));
  for (const name of [
    "research_set_enabled",
    "research_mode",
    "research_state",
    "research_abort_experiment",
    "research_checkpoint",
  ]) assert.equal(names.has(name), true, `missing MCP tool: ${name}`);

  const enabled = await client.callTool({
    name: "research_set_enabled",
    arguments: { enabled: true },
  });
  assert.equal(enabled.isError, undefined);

  const entered = await client.callTool({
    name: "research_mode",
    arguments: {
      mode: "experiment",
      objective: "Test MCP lifecycle",
      title: "MCP smoke experiment",
      question: "Can the plugin complete an experiment lifecycle?",
      intent: "diagnostic",
      plannedDataScope: "synthetic smoke input only",
    },
  });
  assert.equal(entered.isError, undefined);

  const checkpoint = await client.callTool({
    name: "research_checkpoint",
    arguments: {
      title: "MCP lifecycle closes correctly",
      researchQuestion: "Can the plugin complete an experiment lifecycle?",
      hypothesis: "The MCP lifecycle returns to Normal after checkpoint.",
      experiments: [{
        title: "MCP smoke experiment",
        protocol: {
          intent: "diagnostic",
          dataScope: "synthetic smoke input only",
          sources: [],
          deviations: [],
        },
        rationale: "Verify the first-version lifecycle.",
        design: "Enter Experiment Mode and submit a structured checkpoint.",
        observation: "The checkpoint tool accepted the report.",
        analysis: "Acceptance demonstrates state transition wiring, not scientific validity.",
      }],
      overallAnalysis: "The MCP server completed the expected lifecycle.",
      uncertainty: "This smoke test does not exercise a live Claude session.",
      next: "Validate plugin loading and hooks.",
      results: [],
    },
  });
  assert.equal(checkpoint.isError, undefined);

  const state = await client.callTool({ name: "research_state", arguments: {} });
  const text = state.content.find((item) => item.type === "text")?.text ?? "";
  assert.match(text, /CHECKPOINT REACHED/);
  assert.match(text, /"workMode": "normal"/);

  console.log("MCP smoke test passed");
} finally {
  await client.close();
  await rm(project, { recursive: true, force: true });
}

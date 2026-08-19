import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const project = await mkdtemp(join(tmpdir(), "research-loop-mcp-"));
const claudeHome = join(project, "claude-home");
const legacyStatusLineDirectory = join(claudeHome, "pi-research-loop");
await mkdir(legacyStatusLineDirectory, { recursive: true });
await writeFile(
  join(legacyStatusLineDirectory, "statusline-config.json"),
  `${JSON.stringify({
    schemaVersion: 1,
    hadPreviousStatusLine: true,
    previousStatusLine: { type: "command", command: "echo BASE", padding: 1 },
    baseCommand: "echo BASE",
    installedAt: "2026-01-01T00:00:00.000Z",
  }, null, 2)}\n`,
  "utf8",
);
await writeFile(
  join(claudeHome, "settings.json"),
  `${JSON.stringify({
    statusLine: {
      type: "command",
      command: `node "${join(legacyStatusLineDirectory, "statusline.mjs").replace(/\\/g, "/")}"`,
      padding: 0,
    },
  }, null, 2)}\n`,
  "utf8",
);
const environment = Object.fromEntries(
  Object.entries(process.env).filter((entry) => typeof entry[1] === "string"),
);
environment.CLAUDE_PROJECT_DIR = project;
environment.RESEARCH_LOOP_CLAUDE_HOME = claudeHome;

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve("dist/claude/mcp-server.js")],
  env: environment,
});
const client = new Client({ name: "research-loop-smoke", version: "0.1.2" });

try {
  await client.connect(transport);
  const tools = await client.listTools();
  const names = new Set(tools.tools.map((tool) => tool.name));
  for (const name of [
    "research_set_enabled",
    "research_mode",
    "research_state",
    "research_configure_statusline",
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

  const statusLineInstall = await client.callTool({
    name: "research_configure_statusline",
    arguments: { action: "install" },
  });
  assert.equal(statusLineInstall.isError, undefined);
  const settingsPath = join(environment.RESEARCH_LOOP_CLAUDE_HOME, "settings.json");
  const settings = JSON.parse(await readFile(settingsPath, "utf8"));
  assert.match(settings.statusLine.command, /research-loop\/statusline\.mjs/);
  await assert.rejects(readFile(join(legacyStatusLineDirectory, "statusline-config.json"), "utf8"));
  const statusLineText = await runStatusLine(
    join(environment.RESEARCH_LOOP_CLAUDE_HOME, "research-loop", "statusline.mjs"),
    project,
  );
  assert.match(statusLineText, /BASE/);
  assert.match(statusLineText, /Research/);
  assert.match(statusLineText, /Experiment/);
  assert.match(statusLineText, /Diagnostic/);
  const styledStatusLineText = await runStatusLine(
    join(environment.RESEARCH_LOOP_CLAUDE_HOME, "research-loop", "statusline.mjs"),
    project,
    false,
  );
  assert.match(styledStatusLineText, /\u001b\[48;2;30;32;48m/);
  assert.match(styledStatusLineText, /◈ Research/);

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

  await client.callTool({
    name: "research_set_enabled",
    arguments: { enabled: false },
  });
  const statusLineOffText = await runStatusLine(
    join(environment.RESEARCH_LOOP_CLAUDE_HOME, "research-loop", "statusline.mjs"),
    project,
  );
  assert.equal(statusLineOffText, "BASE");

  const statusLineUninstall = await client.callTool({
    name: "research_configure_statusline",
    arguments: { action: "uninstall" },
  });
  assert.equal(statusLineUninstall.isError, undefined);
  const restoredSettings = JSON.parse(await readFile(settingsPath, "utf8"));
  assert.equal(restoredSettings.statusLine.command, "echo BASE");
  assert.equal(restoredSettings.statusLine.padding, 1);
  assert.match(
    await readFile(join(claudeHome, "research-loop-statusline.disabled"), "utf8"),
    /Disabled by user/,
  );

  console.log("MCP smoke test passed");
} finally {
  await client.close();
  await rm(project, { recursive: true, force: true });
}

async function runStatusLine(scriptPath, projectDirectory, noColor = true) {
  const env = { ...process.env };
  if (noColor) env.NO_COLOR = "1";
  else delete env.NO_COLOR;
  const child = spawn(process.execPath, [scriptPath], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end(JSON.stringify({
    cwd: projectDirectory,
    workspace: { project_dir: projectDirectory },
  }));
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise((resolveCode) => child.on("close", resolveCode));
  assert.equal(code, 0, stderr);
  assert.equal(stderr, "");
  return stdout;
}

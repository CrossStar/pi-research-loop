import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ClaudeStateStore } from "../dist/claude/state-store.js";

const project = await mkdtemp(join(tmpdir(), "research-loop-subagent-"));
const sessionId = `subagent-smoke-${Date.now()}`;
const claudeHome = join(project, "claude-home");

try {
  await runHook({
    session_id: sessionId,
    cwd: project,
    hook_event_name: "SessionStart",
  });

  const store = new ClaudeStateStore(project);
  const core = await store.loadCore();
  core.setEnabled(true);
  core.enterMode("exploration", "Map the reproduction protocol");
  await store.saveCore(core, sessionId);

  await runHook({
    session_id: sessionId,
    cwd: project,
    hook_event_name: "UserPromptSubmit",
    prompt: "Use parallel read-only agents to inspect protocol and implementation",
  });

  await runHook({
    session_id: sessionId,
    cwd: project,
    hook_event_name: "PreToolUse",
    tool_name: "Agent",
    tool_use_id: "dispatch-explorer",
    tool_input: {
      subagent_type: "Explore",
      description: "Map protocol",
      prompt: "Read the repository and map the protocol with citations.",
    },
  }, false);
  assert.equal(await store.activeSubagentCount(sessionId), 1);
  assert.match(
    await runStatusLine(join(claudeHome, "research-loop", "statusline.mjs")),
    /exploration  ·  read only  ·  1 agent/,
  );

  await runHook({
    session_id: sessionId,
    cwd: project,
    hook_event_name: "PostToolUse",
    tool_name: "Agent",
    tool_use_id: "dispatch-explorer",
    tool_input: {},
  }, false);
  assert.equal(await store.activeSubagentCount(sessionId), 1);

  const blockedTransition = await runHook({
    session_id: sessionId,
    cwd: project,
    hook_event_name: "PreToolUse",
    tool_name: "mcp__plugin_research-loop_research-loop__research_mode",
    tool_use_id: "transition-while-agent-active",
    tool_input: { mode: "brainstorming", objective: "Compare next steps" },
  });
  assert.equal(blockedTransition.hookSpecificOutput.permissionDecision, "deny");
  assert.ok(blockedTransition.hookSpecificOutput.permissionDecisionReason);

  const started = await runHook({
    session_id: sessionId,
    cwd: project,
    hook_event_name: "SubagentStart",
    agent_id: "agent-explorer-1",
    agent_type: "Explore",
  });
  assert.match(started.hookSpecificOutput.additionalContext, /RESEARCH SUBAGENT: EXPLORATION/);
  assert.match(started.hookSpecificOutput.additionalContext, /Objective: Read the repository and map the protocol with citations/);

  await runHook({
    session_id: sessionId,
    transcript_path: join(project, "subagents", "agent-agent-explorer-1.jsonl"),
    cwd: project,
    hook_event_name: "PreToolUse",
    tool_name: "Read",
    tool_input: { file_path: "README.md" },
  }, false);

  for (const toolName of [
    "Write",
    "Agent",
    "mcp__plugin_research-loop_research-loop__research_mode",
  ]) {
    const denied = await runHook({
      session_id: sessionId,
      agent_id: "agent-explorer-1",
      agent_type: "Explore",
      cwd: project,
      hook_event_name: "PreToolUse",
      tool_name: toolName,
      tool_input: {},
    });
    assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");
    assert.ok(denied.hookSpecificOutput.permissionDecisionReason);
    assert.equal(denied.hookSpecificOutput.additionalContext, undefined);
  }

  await Promise.all(Array.from({ length: 12 }, (_, index) =>
    store.recordSubagentArtifact("agent-explorer-1", {
      path: `notes/subagent-${index}.json`,
      kind: "file",
      extension: ".json",
      size: index + 1,
      modifiedAt: Date.now(),
    })));
  assert.equal((await store.loadCore()).artifacts.length, 12);

  await runHook({
    session_id: sessionId,
    cwd: project,
    hook_event_name: "SubagentStop",
    agent_id: "agent-explorer-1",
    agent_type: "Explore",
  }, false);
  assert.equal(await store.activeSubagentCount(sessionId), 0);

  await runHook({
    session_id: sessionId,
    cwd: project,
    hook_event_name: "PreToolUse",
    tool_name: "mcp__plugin_research-loop_research-loop__research_mode",
    tool_use_id: "transition-after-agent",
    tool_input: { mode: "brainstorming", objective: "Compare next steps" },
  }, false);
  const transitioningCore = await store.loadCore();
  assert.equal(transitioningCore.lifecycleTransitionPending, true);
  transitioningCore.completeLifecycleTransition();
  await store.saveCore(transitioningCore, sessionId);

  await runHook({
    session_id: sessionId,
    cwd: project,
    hook_event_name: "PreToolUse",
    tool_name: "Agent",
    tool_use_id: "dispatch-reviewer",
    tool_input: {
      subagent_type: "research-reviewer",
      description: "Review settings",
      prompt: "Compare the experiment settings with the local reference files.",
    },
  }, false);
  assert.equal(await store.activeSubagentCount(sessionId), 1);
  await runHook({
    session_id: sessionId,
    cwd: project,
    hook_event_name: "PostToolUseFailure",
    tool_name: "Agent",
    tool_use_id: "dispatch-reviewer",
    tool_input: {},
  }, false);
  assert.equal(await store.activeSubagentCount(sessionId), 0);

  await runHook({
    session_id: sessionId,
    cwd: project,
    hook_event_name: "SessionEnd",
  }, false);
  assert.equal(await store.hasActiveState(), false);

  console.log("subagent smoke test passed");
} finally {
  await rm(project, { recursive: true, force: true });
}

async function runStatusLine(scriptPath) {
  const child = spawn(process.execPath, [scriptPath], {
    env: { ...process.env, NO_COLOR: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end(JSON.stringify({
    cwd: project,
    workspace: { project_dir: project },
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

async function runHook(input, expectsOutput = true) {
  const child = spawn(process.execPath, [resolve("dist/claude/hook.js")], {
    env: { ...process.env, RESEARCH_LOOP_CLAUDE_HOME: claudeHome },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end(JSON.stringify(input));
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise((resolveCode) => child.on("close", resolveCode));
  assert.equal(code, 0, stderr);
  if (!expectsOutput) {
    assert.equal(stdout, "");
    return undefined;
  }
  return JSON.parse(stdout);
}

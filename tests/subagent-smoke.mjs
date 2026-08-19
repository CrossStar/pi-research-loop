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

  const dispatch = await runHook({
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
  });
  assert.equal(dispatch.hookSpecificOutput.permissionDecision, undefined);
  assert.equal(await store.activeSubagentCount(sessionId), 1);
  assert.match(
    await runStatusLine(join(claudeHome, "research-loop", "statusline.mjs")),
    /exploration  ·  blueprint  ·  1 agent/,
  );

  const blockedTransition = await runHook({
    session_id: sessionId,
    cwd: project,
    hook_event_name: "PreToolUse",
    tool_name: "mcp__plugin_research-loop_research-loop__research_mode",
    tool_use_id: "transition-while-agent-active",
    tool_input: { mode: "normal", objective: "Implement next step" },
  });
  assert.equal(blockedTransition.hookSpecificOutput.permissionDecision, "deny");
  assert.match(blockedTransition.hookSpecificOutput.permissionDecisionReason, /active Research Subagents/);

  const started = await runHook({
    session_id: sessionId,
    cwd: project,
    hook_event_name: "SubagentStart",
    agent_id: "agent-explorer-1",
    agent_type: "Explore",
  });
  assert.match(started.hookSpecificOutput.additionalContext, /RESEARCH SUBAGENT \| EXPLORATION LEASE/);

  const allowedRead = await runHook({
    session_id: sessionId,
    transcript_path: join(project, "subagents", "agent-agent-explorer-1.jsonl"),
    cwd: project,
    hook_event_name: "PreToolUse",
    tool_name: "Read",
    tool_input: { file_path: "README.md" },
  });
  assert.equal(allowedRead.hookSpecificOutput.permissionDecision, undefined);
  assert.match(allowedRead.hookSpecificOutput.additionalContext, /read-only/);

  for (const [toolName, reason] of [
    ["Write", /read-only/],
    ["Agent", /Nested Agent/],
    ["mcp__plugin_research-loop_research-loop__research_mode", /parent-owned/],
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
    assert.match(denied.hookSpecificOutput.permissionDecisionReason, reason);
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

  const transition = await runHook({
    session_id: sessionId,
    cwd: project,
    hook_event_name: "PreToolUse",
    tool_name: "mcp__plugin_research-loop_research-loop__research_mode",
    tool_use_id: "transition-after-agent",
    tool_input: { mode: "normal", objective: "Implement next step" },
  });
  assert.equal(transition.hookSpecificOutput.permissionDecision, undefined);
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
      description: "Review fidelity",
      prompt: "Review protocol fidelity without modifying files.",
    },
  });
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

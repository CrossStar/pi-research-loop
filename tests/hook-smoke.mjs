import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ClaudeStateStore } from "../dist/claude/state-store.js";

const project = await mkdtemp(join(tmpdir(), "research-loop-hook-"));
const sessionId = `hook-smoke-${Date.now()}`;

try {
  const started = await runHook({
    session_id: sessionId,
    cwd: project,
    hook_event_name: "SessionStart",
  });
  assert.match(started.hookSpecificOutput.additionalContext, /RESEARCH LOOP \| OFF/);

  const store = new ClaudeStateStore(project);
  const core = await store.loadCore();
  core.setEnabled(true);
  core.enterMode("brainstorming", "Choose a direction");
  await store.saveCore(core, sessionId);

  const prompt = await runHook({
    session_id: sessionId,
    cwd: project,
    hook_event_name: "UserPromptSubmit",
    prompt: "Compare candidate approaches",
  });
  assert.match(prompt.hookSpecificOutput.additionalContext, /BRAINSTORMING MODE/);

  const denied = await runHook({
    session_id: sessionId,
    cwd: project,
    hook_event_name: "PreToolUse",
    tool_name: "Write",
    tool_input: { file_path: "experiment.py", content: "print('run')" },
  });
  assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /read-oriented/);

  await runHook({
    session_id: sessionId,
    cwd: project,
    hook_event_name: "SessionEnd",
  }, false);
  assert.equal(await store.hasActiveState(), false);

  console.log("hook smoke test passed");
} finally {
  await rm(project, { recursive: true, force: true });
}

async function runHook(input, expectsOutput = true) {
  const child = spawn(process.execPath, [resolve("dist/claude/hook.js")], {
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

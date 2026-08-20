import { randomUUID } from "node:crypto";
import { resolveArtifactMetadata } from "../core/artifacts.js";
import type { ToolGateDecision } from "../core/types.js";
import { ClaudeStateStore } from "./state-store.js";
import { claudePluginRoot, ensureClaudeStatusLine } from "./statusline-config.js";
import {
  createDispatch,
  evaluateSubagentTool,
  inferAgentId,
  isAgentTool,
  isLifecycleTool,
  normalizeAgentType,
  subagentPolicy,
  type SubagentLease,
} from "./subagents.js";

interface HookInput {
  session_id?: string;
  transcript_path?: string;
  agent_transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_use_id?: string;
  agent_id?: string;
  agent_type?: string;
  prompt?: string;
  user_prompt?: string;
}

async function main(): Promise<void> {
  const input = await readInput();
  if (!input) return;
  const event = input.hook_event_name ?? "";
  const sessionId = input.session_id ?? "unbound";
  const store = new ClaudeStateStore(input.cwd);
  const agentId = inferAgentId(input);

  if (event === "SubagentStart" || (event === "SessionStart" && agentId)) {
    const lease = await claimLease(store, input, agentId);
    if (lease) emitContext(event, subagentPolicy(lease));
    return;
  }

  if (event === "SubagentStop" || (event === "SessionEnd" && agentId)) {
    if (agentId) await store.finishSubagent(agentId);
    return;
  }

  if (event === "SessionStart") {
    const core = await store.beginSession(sessionId);
    const statusLineNotice = await ensureStatusLine();
    const context = [core.policy(), statusLineNotice].filter(Boolean).join("\n\n");
    if (context) emitContext(event, context, statusLineNotice);
    return;
  }

  if (event === "SessionEnd") {
    await store.endSession(sessionId);
    return;
  }

  if (event === "PreToolUse" && agentId) {
    const lease = await claimLease(store, input, agentId);
    const decision = lease
      ? evaluateSubagentTool(lease, input.tool_name ?? "")
      : { block: true, reason: "This research subagent is not linked to an active read-only task." };
    emitToolDecision(decision);
    return;
  }

  if ((event === "PostToolUse" || event === "PostToolUseFailure") && agentId) {
    if (event === "PostToolUse") await indexSubagentArtifact(store, input, agentId);
    return;
  }

  const core = await store.loadCore();
  if (event === "UserPromptSubmit") {
    core.resetRequest(input.prompt ?? input.user_prompt ?? "");
    core.startTurn();
    await store.saveCore(core, sessionId);
    const policy = core.policy();
    if (policy) emitContext(event, policy);
    return;
  }

  if (event === "PreToolUse") {
    const toolName = input.tool_name ?? "";
    let decision: ToolGateDecision | undefined;
    if (isLifecycleTool(toolName) && await store.activeSubagentCount(sessionId) > 0) {
      decision = {
        block: true,
        reason: "Wait for the active research subagents to finish before changing Research Loop state.",
      };
    } else {
      decision = core.evaluateToolCall(toolName, input.tool_input ?? {});
    }

    if (!decision?.block && core.enabled && isAgentTool(toolName)) {
      const dispatch = createDispatch({
        dispatchId: input.tool_use_id ?? randomUUID(),
        parentSessionId: sessionId,
        mode: core.workMode,
        toolInput: input.tool_input,
      });
      if ("block" in dispatch) decision = dispatch;
      else await store.createSubagentDispatch(dispatch);
    }

    await store.saveCore(core, sessionId);
    emitToolDecision(decision);
    return;
  }

  if (event === "PostToolUseFailure") {
    if (isAgentTool(input.tool_name) && input.tool_use_id) {
      await store.removeSubagentDispatch(input.tool_use_id);
    }
    return;
  }

  if (event === "PostToolUse") {
    await indexParentArtifact(store, core, input, sessionId);
  }
}

async function claimLease(
  store: ClaudeStateStore,
  input: HookInput,
  agentId: string | undefined,
): Promise<SubagentLease | undefined> {
  if (!agentId) return undefined;
  return store.claimSubagentLease({
    agentId,
    parentSessionId: input.session_id ?? "unbound",
    agentType: normalizeAgentType(input.agent_type),
  });
}

async function indexSubagentArtifact(
  store: ClaudeStateStore,
  input: HookInput,
  agentId: string,
): Promise<void> {
  const artifactPath = extractWrittenPath(input.tool_name, input.tool_input);
  if (!artifactPath) return;
  const artifact = await resolveArtifactMetadata(store.cwd, artifactPath);
  if (artifact) await store.recordSubagentArtifact(agentId, artifact);
}

async function indexParentArtifact(
  store: ClaudeStateStore,
  core: Awaited<ReturnType<ClaudeStateStore["loadCore"]>>,
  input: HookInput,
  sessionId: string,
): Promise<void> {
  const artifactPath = extractWrittenPath(input.tool_name, input.tool_input);
  if (!artifactPath || !core.enabled) return;
  const artifact = await resolveArtifactMetadata(store.cwd, artifactPath);
  if (!artifact) return;
  core.upsertArtifact(artifact);
  await store.saveCore(core, sessionId);
}

function emitToolDecision(decision: ToolGateDecision | undefined): void {
  if (!decision?.block) return;
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: decision.reason ?? "Research Loop blocked this tool call.",
    },
  })}\n`);
}

function emitContext(event: string, additionalContext: string, systemMessage?: string): void {
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: event,
      additionalContext,
    },
    ...(systemMessage ? { systemMessage } : {}),
  })}\n`);
}

async function ensureStatusLine(): Promise<string | undefined> {
  try {
    const result = await ensureClaudeStatusLine(claudePluginRoot(import.meta.url));
    return result.changed
      ? "Research Loop Status Line was installed or migrated. Restart Claude Code once to display it."
      : undefined;
  } catch {
    return undefined;
  }
}

function extractWrittenPath(toolName: string | undefined, input: Record<string, unknown> | undefined): string | undefined {
  if (!toolName || !input || !/^(?:Write|Edit|MultiEdit|NotebookEdit)$/i.test(toolName)) return undefined;
  const path = input.file_path ?? input.notebook_path ?? input.path;
  return typeof path === "string" ? path : undefined;
}

async function readInput(): Promise<HookInput | undefined> {
  let text = "";
  for await (const chunk of process.stdin) text += chunk.toString();
  try {
    return JSON.parse(text) as HookInput;
  } catch {
    return undefined;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`research-loop hook failed open: ${String(error)}\n`);
  process.exitCode = 0;
});

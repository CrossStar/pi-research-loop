import { resolveArtifactMetadata } from "../core/artifacts.js";
import { ClaudeStateStore } from "./state-store.js";
import { claudePluginRoot, ensureClaudeStatusLine } from "./statusline-config.js";

interface HookInput {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  prompt?: string;
  user_prompt?: string;
}

async function main(): Promise<void> {
  const input = await readInput();
  if (!input) return;
  const event = input.hook_event_name ?? "";
  const store = new ClaudeStateStore(input.cwd);

  if (event === "SessionStart") {
    const core = await store.beginSession(input.session_id ?? "unbound");
    const statusLineNotice = await ensureStatusLine();
    const context = [core.policy() ?? offContext(), statusLineNotice].filter(Boolean).join("\n\n");
    emitContext(event, context, statusLineNotice);
    return;
  }

  if (event === "SessionEnd") {
    await store.endSession(input.session_id ?? "unbound");
    return;
  }

  const core = await store.loadCore();
  if (event === "UserPromptSubmit") {
    core.resetRequest(input.prompt ?? input.user_prompt ?? "");
    core.startTurn();
    await store.saveCore(core, input.session_id);
    const policy = core.policy();
    if (policy) emitContext(event, policy);
    return;
  }

  if (event === "PreToolUse") {
    const decision = core.evaluateToolCall(input.tool_name ?? "", input.tool_input ?? {});
    await store.saveCore(core, input.session_id);
    const policy = core.policy();
    if (decision?.block) {
      process.stdout.write(`${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: decision.reason ?? "Research governor blocked this tool call.",
          ...(policy ? { additionalContext: policy } : {}),
        },
        systemMessage: decision.reason ?? "Research governor blocked this tool call.",
      })}\n`);
    } else if (policy) emitContext(event, policy);
    return;
  }

  if (event === "PostToolUse" || event === "PostToolUseFailure") {
    const toolFinished = core.finishToolCall(input.tool_name ?? "");
    if (event === "PostToolUseFailure") {
      if (toolFinished) await store.saveCore(core, input.session_id);
      return;
    }

    const artifactPath = extractWrittenPath(input.tool_name, input.tool_input);
    const artifact = artifactPath && core.enabled
      ? await resolveArtifactMetadata(store.cwd, artifactPath)
      : undefined;
    if (artifact) core.upsertArtifact(artifact);
    if (toolFinished || artifact) await store.saveCore(core, input.session_id);
    if (artifact) emitContext(event, `Artifact Radar indexed ${artifact.kind}: ${artifact.path}`);
  }
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
    // Status Line setup must not interfere with session initialization.
    return undefined;
  }
}

function offContext(): string {
  return [
    "[RESEARCH LOOP | OFF]",
    "The research-loop Claude Code Plugin is loaded, but its research governor is disabled.",
    "Use the research-loop skill or research_set_enabled MCP tool to enable it for this session.",
  ].join("\n");
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

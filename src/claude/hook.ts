import { resolveArtifactMetadata } from "../core/artifacts.js";
import { ClaudeStateStore } from "./state-store.js";

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
    emitContext(event, core.policy() ?? offContext());
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

  if (event === "PostToolUse") {
    const artifactPath = extractWrittenPath(input.tool_name, input.tool_input);
    if (!artifactPath || !core.enabled) return;
    const artifact = await resolveArtifactMetadata(store.cwd, artifactPath);
    if (!artifact) return;
    core.upsertArtifact(artifact);
    await store.saveCore(core, input.session_id);
    emitContext(event, `Artifact Radar indexed ${artifact.kind}: ${artifact.path}`);
  }
}

function emitContext(event: string, additionalContext: string): void {
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: event,
      additionalContext,
    },
  })}\n`);
}

function offContext(): string {
  return [
    "[RESEARCH LOOP | OFF]",
    "The pi-research-loop Claude Code Plugin is loaded, but its research governor is disabled.",
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
  process.stderr.write(`pi-research-loop hook failed open: ${String(error)}\n`);
  process.exitCode = 0;
});

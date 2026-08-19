#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeStateStore } from "./state-store.js";

interface StatusLineInput {
  cwd?: string;
  workspace?: {
    current_dir?: string;
    project_dir?: string;
  };
}

interface StatusLineConfig {
  schemaVersion: 1;
  baseCommand?: string;
}

async function main(): Promise<void> {
  const rawInput = await readStdin();
  const input = parseInput(rawInput);
  const config = await readConfig();
  const baseOutput = config?.baseCommand ? runBaseStatusLine(config.baseCommand, rawInput) : "";
  const projectDirectory = input.workspace?.project_dir
    ?? input.workspace?.current_dir
    ?? input.cwd
    ?? process.cwd();
  const store = new ClaudeStateStore(projectDirectory);
  const researchOutput = await formatResearchStatus(store);
  const output = [baseOutput.trimEnd(), researchOutput].filter(Boolean).join("\n");
  if (output) process.stdout.write(output);
}

async function formatResearchStatus(store: ClaudeStateStore): Promise<string> {
  if (!await store.hasActiveState()) return "";
  const core = await store.loadCore();
  const status = core.projectStatus();
  const experiment = core.experiment;
  const phase = experiment
    ? ` | PHASE ${experiment.intent.toUpperCase()} · ${truncate(experiment.title, 32)}`
    : "";
  return colorize(`${status.text}${phase}`, status.tone);
}

function colorize(text: string, tone: "dim" | "success" | "warning" | "accent"): string {
  if (process.env.NO_COLOR) return text;
  const color = {
    dim: "\u001b[2m",
    success: "\u001b[32m",
    warning: "\u001b[33m",
    accent: "\u001b[36m",
  }[tone];
  return `${color}${text}\u001b[0m`;
}

function runBaseStatusLine(command: string, input: string): string {
  if (!command.trim()) return "";
  try {
    const shell = process.env.SHELL && process.env.SHELL.trim() ? process.env.SHELL : true;
    const result = spawnSync(command, {
      shell,
      input,
      encoding: "utf8",
      timeout: 2_000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, PI_RESEARCH_LOOP_STATUSLINE_NESTED: "1" },
    });
    return result.stdout ?? "";
  } catch {
    return "";
  }
}

async function readConfig(): Promise<StatusLineConfig | undefined> {
  try {
    const path = `${dirname(fileURLToPath(import.meta.url))}/statusline-config.json`;
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<StatusLineConfig>;
    return value.schemaVersion === 1 ? value as StatusLineConfig : undefined;
  } catch {
    return undefined;
  }
}

function parseInput(input: string): StatusLineInput {
  try {
    return JSON.parse(input) as StatusLineInput;
  } catch {
    return {};
  }
}

async function readStdin(): Promise<string> {
  let input = "";
  for await (const chunk of process.stdin) input += chunk.toString();
  return input;
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, Math.max(1, limit - 1))}…`;
}

main().catch(() => {
  // A status line must never interfere with the Claude session.
  process.exitCode = 0;
});

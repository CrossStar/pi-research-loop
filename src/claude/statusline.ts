#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ResearchCoreSnapshot } from "../core/research-core.js";
import type { WorkMode } from "../core/types.js";
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

interface Rgb {
  r: number;
  g: number;
  b: number;
}

const COLORS = {
  background: { r: 30, g: 32, b: 48 },
  text: { r: 192, g: 202, b: 245 },
  muted: { r: 125, g: 135, b: 170 },
  normal: { r: 130, g: 170, b: 255 },
  brainstorming: { r: 252, g: 167, b: 234 },
  exploration: { r: 125, g: 207, b: 255 },
  success: { r: 195, g: 232, b: 141 },
  warning: { r: 224, g: 175, b: 104 },
} satisfies Record<string, Rgb>;

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
  if (!core.enabled) return "";

  const snapshot = core.snapshot();
  const items = statusItems(snapshot);
  if (process.env.NO_COLOR || process.env.TERM === "dumb") {
    return `Research · ${items.join(" · ")}`;
  }
  return powerlinePill(items, statusAccent(snapshot));
}

function statusItems(snapshot: ResearchCoreSnapshot): string[] {
  if (snapshot.checkpointReached) {
    return ["Checkpoint", `${snapshot.checkpointResultCount} results`];
  }

  const items = [displayMode(snapshot.state.workMode)];
  if (snapshot.state.experiment) items.push(displayIntent(snapshot.state.experiment.intent));
  items.push(`${snapshot.roundActions}A`, `${snapshot.state.artifacts.length}O`);
  if (snapshot.softReviewPending) items.push("Review");
  return items;
}

function statusAccent(snapshot: ResearchCoreSnapshot): Rgb {
  if (snapshot.softReviewPending) return COLORS.warning;
  if (snapshot.checkpointReached || snapshot.state.workMode === "experiment") return COLORS.success;
  return COLORS[snapshot.state.workMode];
}

function powerlinePill(items: string[], accent: Rgb): string {
  const separator = `${foreground(COLORS.muted)} · `;
  const details = items.map((item) => `${foreground(COLORS.text)}${item}`).join(separator);
  return [
    foreground(COLORS.background),
    "",
    background(COLORS.background),
    foreground(accent),
    " ◈ Research ",
    separator,
    details,
    " ",
    "\u001b[0m",
    foreground(COLORS.background),
    "",
    "\u001b[0m",
  ].join("");
}

function foreground(color: Rgb): string {
  return `\u001b[38;2;${color.r};${color.g};${color.b}m`;
}

function background(color: Rgb): string {
  return `\u001b[48;2;${color.r};${color.g};${color.b}m`;
}

function displayMode(mode: WorkMode): string {
  return mode.charAt(0).toUpperCase() + mode.slice(1);
}

function displayIntent(intent: string): string {
  return intent.charAt(0).toUpperCase() + intent.slice(1).replace(/-/g, " ");
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
      env: { ...process.env, RESEARCH_LOOP_STATUSLINE_NESTED: "1" },
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

main().catch(() => {
  // A status line must never interfere with the Claude session.
  process.exitCode = 0;
});

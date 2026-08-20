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

interface RailProjection {
  mode: string;
  details: string[];
  accent: Rgb;
  marker: "◇" | "◆";
}

const COLORS = {
  rose: { r: 252, g: 167, b: 234 },
  blue: { r: 130, g: 170, b: 255 },
  green: { r: 195, g: 232, b: 141 },
  cyan: { r: 125, g: 207, b: 255 },
  amber: { r: 224, g: 175, b: 104 },
  text: { r: 192, g: 202, b: 245 },
  muted: { r: 86, g: 95, b: 137 },
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
  return renderRail(projectRail(core.snapshot(), await store.activeSubagentCount()));
}

function projectRail(snapshot: ResearchCoreSnapshot, activeSubagents: number): RailProjection {
  if (!snapshot.state.enabled) {
    return { mode: "off", details: [], accent: COLORS.muted, marker: "◇" };
  }
  if (snapshot.checkpointReached) {
    return {
      mode: "checkpoint",
      details: [count(snapshot.checkpointResultCount, "result")],
      accent: COLORS.green,
      marker: "◆",
    };
  }

  const mode = snapshot.state.workMode;
  const projection: RailProjection = {
    mode,
    details: modeDetails(snapshot),
    accent: modeColor(mode),
    marker: mode === "experiment" ? "◆" : "◇",
  };
  if (snapshot.softReviewPending) {
    projection.accent = COLORS.amber;
    projection.details.push("review due");
  }
  if (activeSubagents > 0) projection.details.push(count(activeSubagents, "agent"));
  return projection;
}

function modeDetails(snapshot: ResearchCoreSnapshot): string[] {
  switch (snapshot.state.workMode) {
    case "brainstorming":
      return ["read only"];
    case "exploration":
      return ["read only"];
    case "experiment":
      return [
        snapshot.state.experiment?.intent.replace(/-/g, " ") ?? "experiment",
        count(snapshot.roundActions, "action"),
        count(snapshot.state.artifacts.length, "output"),
      ];
    case "normal":
      return [
        count(snapshot.roundActions, "action"),
        count(snapshot.state.artifacts.length, "output"),
      ];
  }
}

function modeColor(mode: WorkMode): Rgb {
  return {
    normal: COLORS.blue,
    brainstorming: COLORS.rose,
    exploration: COLORS.cyan,
    experiment: COLORS.green,
  }[mode];
}

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? "" : "s"}`;
}

function renderRail(projection: RailProjection): string {
  const plain = [
    `  ╰─ ${projection.marker} research  ${projection.mode}`,
    ...projection.details.map((detail) => `  ·  ${detail}`),
  ].join("");
  if (process.env.NO_COLOR || process.env.TERM === "dumb") return plain;

  const details = projection.details
    .map((detail) => `${foreground(COLORS.muted)}  ·  ${foreground(COLORS.text)}${detail}`)
    .join("");
  return [
    foreground(COLORS.muted),
    "  ╰─ ",
    foreground(projection.accent),
    projection.marker,
    " ",
    foreground(COLORS.cyan),
    "research",
    "  ",
    foreground(projection.accent),
    projection.mode,
    details,
    "\u001b[0m",
  ].join("");
}

function foreground(color: Rgb): string {
  return `\u001b[38;2;${color.r};${color.g};${color.b}m`;
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

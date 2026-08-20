import type { ResearchCoreSnapshot } from "./core/research-core.js";
import type { WorkMode } from "./core/types.js";

export type PiStatusColor = "accent" | "dim" | "muted" | "success" | "text" | "warning";

export interface PiStatusTheme {
  fg(color: PiStatusColor, text: string): string;
}

interface PiStatusProjection {
  marker: "◇" | "◆";
  mode: string;
  details: string[];
  tone: PiStatusColor;
  enabled: boolean;
}

export function renderPiResearchStatus(snapshot: ResearchCoreSnapshot, theme: PiStatusTheme): string {
  const projection = projectPiStatus(snapshot);
  const marker = theme.fg(projection.tone, projection.marker);
  const research = theme.fg(projection.enabled ? "accent" : "dim", "research");
  const mode = theme.fg(projection.tone, projection.mode);
  const details = projection.details
    .map((detail) => `${theme.fg("dim", " · ")}${theme.fg("text", detail)}`)
    .join("");
  return `${marker} ${research}  ${mode}${details}`;
}

export function projectPiStatus(snapshot: ResearchCoreSnapshot): PiStatusProjection {
  if (!snapshot.state.enabled) {
    return { marker: "◇", mode: "off", details: [], tone: "dim", enabled: false };
  }
  if (snapshot.checkpointReached) {
    return {
      marker: "◆",
      mode: "checkpoint",
      details: [count(snapshot.checkpointResultCount, "result")],
      tone: "success",
      enabled: true,
    };
  }

  const mode = snapshot.state.workMode;
  const projection: PiStatusProjection = {
    marker: mode === "experiment" ? "◆" : "◇",
    mode,
    details: modeDetails(snapshot),
    tone: modeTone(mode),
    enabled: true,
  };
  if (snapshot.softReviewPending) {
    projection.tone = "warning";
    projection.details.push("review due");
  }
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

function modeTone(mode: WorkMode): PiStatusColor {
  return {
    normal: "accent",
    brainstorming: "warning",
    exploration: "accent",
    experiment: "success",
  }[mode] as PiStatusColor;
}

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? "" : "s"}`;
}

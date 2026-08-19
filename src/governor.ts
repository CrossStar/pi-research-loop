// Backward-compatible Pi adapter import surface. Harness-neutral policy and
// governor logic lives in core so Claude Code and Pi use the same decisions.
export * from "./core/governor.js";

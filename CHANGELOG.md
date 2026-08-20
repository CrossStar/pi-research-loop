# Changelog

All notable changes to Research Loop are documented in this file.

## 0.4.0 - 2026-08-21

### Checkpoint presentation

- Start a session-scoped, localhost-only Pi checkpoint server on the first available port from a configurable base and append the rendered report URL to every checkpoint output.
- Render reports from the approved LaTeX-like HTML layout with formulas, tables, images, progressive experiment details, and an inspectable large-JSON viewer.
- Keep current-session checkpoint history in memory and clear it when the Pi session shuts down.
- Prefer Chafa for Pi terminal image previews, with Pi's native terminal-image protocols as the automatic fallback.

## 0.3.1 - 2026-08-20

### User decisions

- Detect the optional `ask_user_question` Pi tool and inject balanced guidance at material protocol, cost/scope trade-off, and next-experiment branch decisions.
- Surface questionnaire waits in the Pi footer without making the third-party package a hard dependency; cancelling the questionnaire aborts the current turn.
- Replace advisory cost and protocol blocks in Pi with real host confirmation dialogs; approval permits the exact action, while decline aborts the current turn.
- Stop the Pi agent turn when it repeats an unchanged blocked tool call, returning control instead of allowing an automatic retry loop.

## 0.3.0 - 2026-08-20

### Work modes

- Remove Normal Mode; Research Loop now exposes Brainstorming, Exploration, and Experiment.
- Start enabled sessions in Exploration and return there after checkpoint or abort.
- Treat ordinary implementation work as Research Loop OFF and migrate saved Normal state to Exploration.

## 0.2.0 - 2026-08-20

### Claude subagent support

- Add parent-owned read-only Subagent leases for built-in Explore and Plugin explorer/reviewer agents.
- Add dedicated `research-explorer` and `research-reviewer` Agent definitions.
- Split dispatch, lease, and append-only artifact event persistence for concurrent Subagents.
- Add Subagent lifecycle hooks, lifecycle ownership gates, and active-agent Status Line projection.
- Keep lifecycle transitions in MCP handlers and wait for active Subagents before changing state.
- Prevent Research Subagents from mutating parent lifecycle state.

### Agent guidance

- Replace governance-heavy mode, Skill, and Subagent prompts with concise task-oriented guidance.
- Stop reinjecting the full policy before every allowed tool call while retaining tool restrictions.
- Keep reproduction-setting reminders specific to active reproduction experiments.

### Pi footer status

- Move Pi Research Loop state from a full-width below-editor widget into the native footer status area.
- Match the Claude Terminal Rail semantics with compact lowercase labels and hollow/solid markers.
- Use Pi theme colors for OFF, modes, Experiment, Checkpoint, and soft-review states.

## 0.1.3 - 2026-08-19

### Changed

- Replace the verbose uppercase Claude Status Line with the approved Terminal Rail design.
- Keep a low-contrast OFF rail and use mode-specific Tokyo Night colors.
- Use hollow markers for passive modes and solid markers for Experiment and Checkpoint.
- Show concise mode semantics, pluralized counters, experiment intent and soft-review state.

Version 0.1.2 was withdrawn before stable distribution and is intentionally not reused.

## 0.1.1 - 2026-08-19

### Fixed

- Automatically install the Research Loop Status Line on the first Plugin session.
- Migrate the pre-rename `pi-research-loop` Status Line without losing the user's previous command.
- Preserve an explicit Status Line uninstall through a user opt-out marker.

## 0.1.0 - 2026-08-19

### Added

- Harness-neutral Research Core with shared state, Work Modes, Governor, Research Policy,
  Experiment lifecycle, Checkpoint normalization and Artifact metadata.
- Claude Code Plugin with Skill, lifecycle MCP tools and deterministic Hooks.
- Persistent Claude Research State and structured evidence Checkpoints.
- Composable Claude Status Line with installation and restoration support.
- Pi adapter backed by the shared Research Core.
- Self-hosted Claude Code Marketplace manifest.

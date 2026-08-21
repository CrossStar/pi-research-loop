# Changelog

All notable changes to Research Loop are documented in this file.

## 0.5.0 - 2026-08-21

### Persistent Checkpoint Viewer

- Separate Pi checkpoint content from presentation: write long-lived `checkpoints/*/checkpoint.md` research notes and keep one plugin-owned Viewer.
- Replace the Pi checkpoint schema with a hybrid writer interface: four continuous Chinese Markdown sections plus structured protocol, reproduction and artifact metadata.
- Add filesystem discovery with JSON-compatible frontmatter and tolerant fallback for ordinary legacy Markdown.
- Add stable `/latest`, history `/`, per-checkpoint routes, API metadata, and symlink-aware project-bounded artifact serving without per-experiment HTML files.
- Render Markdown, currency-safe MathJax, GFM tables, figures, dynamic bar/line `checkpoint-chart` blocks, JSON key search, Raw JSON and CSV previews in the unified academic Viewer.
- Enforce formal visual units with titles above tables, titles below figures, a dedicated interpretation paragraph, and a light separator after each visual; reject “不是……而是……” and equivalent contrast constructions.
- Use TeX Main for Latin text and SimSun/Songti for Chinese checkpoint prose, with restrained non-synthetic weights.
- Print the complete SSH port-forward command on one copyable line.
- Keep real experiment artifacts in their original locations and rewrite project-relative Markdown references instead of copying or base64-embedding them.
- Keep this persistent writer/Viewer Pi-only for now; Claude MCP checkpoint behavior remains unchanged.

## 0.4.1 - 2026-08-21

### Checkpoint report fixes

- Omit the Formula-aware analysis section and navigation entry when a checkpoint contains no TeX math, and render only formula-bearing checkpoint passages when it does.
- Add a ready-to-copy SSH port-forward command below the rendered checkpoint URL, with `RESEARCH_LOOP_SSH_HOST` support for local SSH aliases.
- Add case-insensitive JSON key-name search in Tree mode while preserving raw key/value search in Raw mode.
- Render Pi checkpoint images through Chafa Sixel when available; retain Chafa symbols for `/artifacts` and native Pi image protocols as fallback.

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

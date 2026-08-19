# Changelog

All notable changes to Research Loop are documented in this file.

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

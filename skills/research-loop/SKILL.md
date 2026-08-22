---
name: research-loop
description: Use when the user explicitly asks to enable, disable, or inspect Research Loop; configure its status line; choose a research mode; run a tracked experiment; reproduce a result; or finish an experiment with a checkpoint.
version: 0.5.1
---

# Research Loop

Research Loop keeps one main Claude session in one of three modes: Brainstorming, Exploration, or
Experiment. Choose the mode for the research work currently needed. Do not map the modes to separate
agents, and do not explain the mode machinery unless the user asks.

## Start, stop, and inspect

- Call `research_set_enabled` with `enabled: true` to start. It begins in Exploration Mode.
- Call `research_state` when the saved mode or active experiment is unclear.
- Disable Research Loop for ordinary direct implementation, but only after any active Experiment has ended.

For Status Line setup, call `research_configure_statusline` with `status`, `install`, or `uninstall`.
Installation and removal require a Claude Code restart. The Status Line already displays the current
mode and activity, so do not repeat that status in normal answers.

## Choose a mode

```text
ordinary direct implementation -> Research Loop off
compare possible directions     -> Brainstorming
understand code or materials    -> Exploration
run empirical work              -> Experiment
```

When the kind of research work changes, call `research_mode` before starting it. Make the mode change
as its own tool call, then proceed without a verbal mode announcement. Do not switch modes for an
individual read or command. Turn Research Loop off rather than selecting a mode for ordinary direct
implementation, review, documentation, or software validation; these tasks do not require an
experiment checkpoint.

### Brainstorming

Compare genuinely different options, explain the trade-offs that matter, and recommend a direction.
Do not edit files or run empirical work in this mode. Organize the answer around the user's question
rather than a named template.

### Exploration

Read the relevant code and materials, trace the behavior needed for the question, and return the
findings with useful references. Do not create a fixed blueprint or file-by-file inventory. Switch to
Experiment before running work that produces empirical results.

### Experiment

Enter with `title`, `question`, `intent`, `plannedDataScope`, and a `reference` when applicable. Run
the work needed to answer the question and keep the actual settings and observations for the final
checkpoint.

For a reproduction:

- check the official paper, including appendix or supplement;
- check the README for the matching repository revision;
- check relevant open and closed issues;
- keep the referenced data, split, sampling, preprocessing, model or checkpoint, objective,
  evaluation, seeds, repeats, and material settings;
- ask the user before changing those settings;
- describe a reduced run as diagnostic, not as the reproduction result.

## Read-only subagents

Use `Explore`, `research-explorer`, or `research-reviewer` for a focused read-only task:

- `research-explorer` traces implementation and experiment setup;
- `research-reviewer` checks a specified method or result against available material;
- built-in `Explore` is also accepted.

Give each subagent one concrete question and request file references. These agents can read but
cannot edit files, run commands or experiments, start another agent, change Research Loop state, or
submit a checkpoint. Wait for them to finish before changing mode or ending an experiment.

## Finish an experiment

An Experiment ends through `research_checkpoint` or, only when nothing interpretable was produced,
`research_abort_experiment`.

Use `research_checkpoint` after at least one completed empirical run when the findings are ready to
report or the user needs to choose the next direction. Include every completed run, the settings
actually used, observations, analysis, and relevant outputs. For reproductions, include the consulted
sources and every change from the referenced setup.

Negative results, failed runs, and diagnostic observations are interpretable results when they teach
something; include them in a checkpoint. Use `research_abort_experiment` only when there is no such
result and attest `noInterpretableEvidence: true`.

After checkpoint or valid abort, Research Loop returns to Exploration Mode.

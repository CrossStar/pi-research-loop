---
name: research-loop
description: This skill should be used when the user asks to "start a research loop", "enable research mode", "show research status", "configure the research status line", "brainstorm research directions", "understand experiment code", "run an experiment", "reproduce a paper result", or requests evidence-first empirical investigation with checkpoints.
version: 0.1.3
---

# Research Loop

Use Research Loop to manage one main Claude session through explicit research work contracts. Keep
Normal, Brainstorming, Exploration, and Experiment as global modes of the same main session. Do not
map the four modes to four subagents. Delegate bounded read-only discovery to a subagent only when it
helps the active mode; keep lifecycle decisions and state changes in the main session.

## Start and Stop

Call `research_set_enabled` with `enabled: true` before beginning a Research Loop. Enabling starts in
Normal Mode. Call it with `enabled: false` only when no Experiment Mode is active or after explicitly
ending the experiment lifecycle.

Call `research_state` whenever the current mode or experiment context is uncertain. Treat the MCP
state as authoritative. Hooks persist that state, inject the current policy, and enforce deterministic
tool gates before tool execution.

## Configure the Status Line

Call `research_configure_statusline` with `action: "status"` when status-line installation is
uncertain. With user approval, call it with `action: "install"`, then ask the user to restart Claude
Code. Installation preserves an existing command-based Claude status line and renders Research Loop
on an additional line. Use `action: "uninstall"` to restore the previous status-line setting.

Treat the status line as the primary visible projection of Research State. It displays enabled state,
Work Mode, action count, Soft Review, artifact count, and active Experiment intent and title. Keep the
MCP state authoritative when display and lifecycle decisions differ.

## Select the Work Mode

Choose the mode from the dominant uncertainty:

```text
clear objective or direct implementation  -> Normal
choice or direction uncertainty           -> Brainstorming
code or protocol understanding uncertainty -> Exploration
empirical uncertainty                      -> Experiment
```

Call `research_mode` as a standalone lifecycle action before doing mode-specific work. Avoid mode
changes for individual reads or commands; switch only when the dominant behavior contract changes.

### Normal

Answer, implement, review, document, and maintain directly. Do not create research checkpoints for
ordinary software validation.

### Brainstorming

Frame the decision, generate genuinely distinct options, compare trade-offs, expose assumptions and
unknowns, and converge to a compact Decision Map. Avoid editing or empirical execution. Switch to
Normal for implementation, Exploration for systematic code understanding, or Experiment for evidence.

### Exploration

Build the minimum sufficient understanding needed to write faithful pseudocode, reproduce a result,
or explain how implementation details affect scientific conclusions. Prefer read-only inspection.
Produce an Experiment Blueprint covering objective, execution path, data, model or algorithm, loss,
optimization, variables and controls, evaluation, randomness, artifacts, caveats, and source conflicts.
Switch to Experiment before running work that can produce scientific evidence.

### Experiment

Declare `title`, `question`, `intent`, `plannedDataScope`, and any `reference` in the `research_mode`
call. For reproduction, triangulate the official paper including appendix or supplement, repository
README at the relevant revision, and relevant open and closed issues before execution. Disclose source
conflicts and obtain approval for protocol deviations.

Keep diagnostic runs separate from reproduction evidence. Preserve dataset, split, sampling,
preprocessing, model or checkpoint, objective, evaluation, seeds, repeats, and material
hyperparameters unless the user explicitly approves a disclosed deviation.

## Finish an Experiment

Do not leave Experiment Mode by switching modes or silently continuing as Normal.

Call `research_checkpoint` after at least one completed empirical experiment when evidence changes the
hypothesis, creates a meaningful branch, materially increases the cost of the next step, or stops
reducing uncertainty. Include:

- the research question and updated hypothesis;
- every completed experiment and its actual protocol;
- source coverage and every protocol deviation;
- observations before interpretation;
- structured result tables where useful;
- cross-experiment analysis and strongest justified conclusion;
- uncertainty, limitations, and the next experiment or user decision;
- only understood, relevant artifacts.

Use `research_abort_experiment` only when no interpretable evidence was produced. Explicitly attest
`noInterpretableEvidence: true`. Treat negative outcomes, failures, and diagnostic observations as
evidence that belongs in a checkpoint rather than a reason to abort.

After checkpoint or valid abort, continue from Normal Mode and select another mode only when the next
research activity requires it.

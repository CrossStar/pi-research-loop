# Pi Research Loop

Pi Research Loop 是一个面向科研 Agent 的 evidence-first Research Loop，现同时提供
Pi Extension 和 Claude Code Plugin。项目与主仓库继续使用 `pi-research-loop` 名称。
它不替 Agent 做研究决策，而是为交流、头脑风暴、实验代码理解和实验执行提供明确
的工作契约，并在实验产生 evidence 后通过 checkpoint 将控制权交还给用户。

## 核心特性

- **简单开关**：Pi 使用 `/research on|off`；Claude Code 通过 Research Loop Skill 和
  `research_set_enabled` MCP tool 启用或停用，不区分 Fast 或 Normal profile。
- **自主模式选择**：Agent 根据当前不确定性的类型，在 Normal、Brainstorming、
  Exploration 和 Experiment 四种 Work Mode 之间切换；用户指令始终具有更高优先级。
- **语义化 checkpoint**：checkpoint 由 evidence、decision、cost、uncertainty 和
  stagnation 等研究语义触发，不由固定 action 上限机械触发。
- **复现保真**：复现实验遵循 fidelity-first 原则，不静默修改数据范围、split、
  checkpoint、seed 或其他 reference invariant。
- **诊断与复现分离**：wiring test 和小样本 smoke test 属于 diagnostic，不能作为 reproduction 结果。
- **结果策展**：Artifact Radar 负责发现输出；checkpoint 只呈现 Agent 能够解释且与结论相关的结果。

## 安装

### Pi：从 GitHub 安装

```bash
pi install git:github.com/CrossStar/pi-research-loop
```

### Pi：本地运行

```bash
npm install
pi -ne -e .
```

### Claude Code：本地加载

仓库包含已构建的 Claude Code Plugin。可直接从仓库根目录加载：

```bash
claude --plugin-dir .
```

修改 `src/core/` 或 `src/claude/` 后，重新构建再加载：

```bash
npm install
npm run build:claude
claude --plugin-dir .
```

Claude Plugin 的开发说明和已知限制见
[`docs/claude-plugin.md`](docs/claude-plugin.md)。

## Pi 快速开始

Research Loop 默认关闭。进入 Pi 后，使用以下命令控制扩展：

```text
/research on
/research off
```

启用后，扩展会：

- 注入 Research Policy 并启用 Work Mode 状态机；
- 启用 Artifact Radar；
- 激活 mode transition、experiment lifecycle 和 checkpoint tools；
- 将初始 Work Mode 设置为 Normal。

停用后，扩展会：

- 停止注入 Research Policy，并停止 Artifact Radar capture；
- 禁用 research tools；
- 清除当前 Experiment Phase；
- 恢复 Pi 的常规行为。

可使用 `/artifacts` 查看当前研究会话中发现的 artifacts：

```text
/artifacts
```

## Claude Code 快速开始

使用自然语言要求 Claude “启用 Research Loop”，或显式调用
`/pi-research-loop:research-loop` Skill。Claude 会通过 Plugin MCP tools 维护状态：

```text
research_set_enabled
research_mode
research_state
research_checkpoint
research_abort_experiment
```

Plugin hooks 会在 `SessionStart` 和 `UserPromptSubmit` 注入当前 Research Policy，在
`PreToolUse` 阶段执行 Governor，并在写入受支持的 artifact 文件后记录 metadata。
Research Loop 默认关闭；启用后从 Normal Mode 开始。

## 架构

```text
src/core/       与 Agent Harness 无关的状态、Governor、Policy、Checkpoint 和 Artifact metadata
src/            Pi Extension adapter、Pi session persistence、TUI 和 artifact preview
src/claude/     Claude Code state store、Hooks handler 和 MCP server
skills/         Claude Code Research Loop Skill
hooks/          Claude Code Hook registration
```

四种 Work Mode 始终表示同一个主 Agent 的全局行为契约，而不是四个 subagents。Pi 和
Claude Code 共享 `ResearchCore`、Governor、Research Policy 和 checkpoint
normalization；各 adapter 只负责宿主注册、生命周期输入输出、持久化与体验层能力。

## 设计原则

1. **Research Loop 只有开启和关闭两种状态。** Fast execution 不再是独立模式；time-to-insight、避免无关工程化和最小有效验证是所有模式的基础原则，但不能削弱科学主张。
2. **Work Mode 表示行为契约，而不是流程装饰。** 只有主要工作方式发生变化时才切换模式，不因单次文件读取或命令执行频繁切换。
3. **Action counter 只提供可见性和 Soft Review。** 它没有固定上限，也不会自动中断实验或赋予 checkpoint 资格。
4. **复现实验优先保证协议保真。** 任何可能影响科学结论的 protocol deviation 都必须披露，并在执行前获得批准。
5. **Artifact discovery 与 evidence curation 相互分离。** 被发现的输出不一定会进入 checkpoint。

## Work Modes

| Mode | 主要不确定性 | Agent 行为 | 主要产物 |
| --- | --- | --- | --- |
| Normal | 目标明确 | 普通交流、实现、review 和维护 | 任务结果 |
| Brainstorming | 不确定应选择哪个方向 | 发散假设与方案，再收敛决策 | Decision Map |
| Exploration | 不理解现有项目或实验代码 | 阅读、追踪并提取与科学结论相关的实现 | Experiment Blueprint |
| Experiment | 需要通过实际运行获得 evidence | 声明协议、运行实验并分析结果 | Research Checkpoint |

Agent 根据主要不确定性选择模式：

```text
选择不确定性      -> BRAINSTORMING
代码事实不确定性  -> EXPLORATION
经验事实不确定性  -> EXPERIMENT
其他任务          -> NORMAL
```

Mode transition 只更新工具状态和状态栏，不要求 Agent 在正文中反复声明模式变化。

### Normal Mode

Normal 是默认工作模式，适用于普通交流、目标明确的代码实现、bug 修复、文档编写和 review。该模式没有固定输出格式，也不会产生 checkpoint。

### Brainstorming Mode

Brainstorming 用于扩大并整理决策空间。Agent 应明确以下内容：

- 问题边界；
- 候选方向及其 trade-off；
- 关键假设和未知项；
- 推荐方向。

该模式默认不修改代码、不运行实验，退出时形成紧凑的 Decision Map。

### Exploration Mode

Exploration 用于理解项目，尤其是实验代码。Agent 应提取“最小充分实验描述”，使研究者能够：

- 写出忠实的伪代码；
- 列出科学变量和关键超参数；
- 解释数据到结果的完整路径；
- 识别可能改变实验结论的实现细节。

Experiment Blueprint 应覆盖：

```text
Research Objective
Entry Point and Execution Path
Data Pipeline
Model / Algorithm
Pseudocode
Objective and Loss
Optimization and Key Hyperparameters
Variables, Controls, Baselines, Ablations
Evaluation Protocol
Randomness, Seeds, and Repeats
Outputs and Artifacts
Critical Implementation Details
Source Conflicts and Unknowns
```

信息筛选遵循以下规则：

```text
它是否是写出伪代码所必需的？
它是否是复现实验结果所必需的？
改变它是否可能改变科学结论？
```

如果三个问题的答案都是否，则忽略该信息。Slurm、queue、日志框架、CLI boilerplate
和通用 utility 默认不进入 Blueprint，除非它们会影响科学结果。

Exploration 可以进行静态 introspection、查看 resolved config 和检查数据结构。
一旦开始运行能够产生科学 evidence 的任务，Agent 必须进入 Experiment Mode。

### Experiment Mode

进入 Experiment Mode 时，Agent 必须声明：

- Research Question；
- experiment intent；
- planned data scope；
- reference protocol。

一个 Experiment Mode 可以包含多个围绕同一研究问题的实验，但不能静默退出：

```text
EXPERIMENT -> research_checkpoint -> NORMAL
```

如果没有产生任何可解释的 evidence，可以通过 `research_abort_experiment` 退出并说明
原因。已经产生负结果、失败模式或 diagnostic evidence 时，不能使用 abort 隐藏结果，
必须通过 `research_checkpoint` 汇报。

## Checkpoint 与 Soft Review

状态栏可能显示以下状态：

```text
RESEARCH ON | NORMAL | ACTIONS 2 | OUTPUTS 0
RESEARCH ON | BRAINSTORMING | ACTIONS 4 | OUTPUTS 0
RESEARCH ON | EXPLORATION | ACTIONS 8 | OUTPUTS 1
RESEARCH ON | EXPERIMENT | ACTIONS 6 | SOFT REVIEW | OUTPUTS 3
RESEARCH ON | CHECKPOINT REACHED | RESULTS 2
RESEARCH OFF
```

`SOFT REVIEW` 是非阻塞的语义复盘提示。它不会停止工具执行、自动调用 checkpoint，也不会使任务获得 checkpoint 资格。

Action counter 不能替代 Agent 对 evidence、decision、cost、uncertainty 和 stagnation
的判断。如果当前实验尚未完成，且没有满足语义触发条件，Agent 应继续执行实验。

## Reproduction Fidelity

启动复现前，Agent 必须核对：

- official paper，包括 appendix 和 supplementary material；
- 对应 commit 或 tag 的 official repository README；
- 相关 open/closed GitHub issues，并优先关注 maintainer 的澄清。

当 paper、README、issue guidance 或实际代码行为之间存在冲突时，Agent 必须披露冲突及其科学影响，不能静默选择其中一个版本。

每个 checkpoint experiment 都应记录：

- `protocol.intent`：`reproduction`、`diagnostic`、`exploratory` 或 `ablation`；
- `protocol.dataScope`：实际 dataset、split、sample count 和 sampling scope；
- `protocol.sources`：paper、README 和 issues 的状态、引用及 guidance；
- `protocol.deviations`：reference、actual、原因、限制和批准状态。

Reproduction 缺少 source coverage 时显示 `MISSING`；存在未批准的 deviation 时显示 `NO`。

## Artifact Radar

Artifact Radar 支持以下格式：

- 图片：PNG、JPG 和 SVG；
- 表格与数据：CSV、JSON 和 Parquet；
- 文档：HTML 和 PDF。

PNG 和 JPG 可以在终端内联预览；CSV 和 Parquet 只展示指定列或有限行。表格分片会按父目录聚合为一个 Dataset Artifact。

Checkpoint 不会自动附加本轮产生的所有输出。Curated result 支持以下角色：

```text
evidence
diagnostic
dataset
intermediate
```

## 开发

运行 TypeScript 类型检查：

```bash
npm run check
```

项目仓库：[github.com/CrossStar/pi-research-loop](https://github.com/CrossStar/pi-research-loop)

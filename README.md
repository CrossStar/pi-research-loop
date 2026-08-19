# Research Loop

Research Loop 是一个面向科研 Agent 的 evidence-first 研究控制插件，同时支持
**Claude Code Plugin** 和 **Pi Extension**。

它不替 Agent 做研究决策，而是为同一个主 Agent 提供可持续的 Research State、四种
Work Mode、工具行为约束、Experiment 生命周期和结构化 Checkpoint。在实验产生 evidence
后，Research Loop 会把控制权正式交还给用户。

## 核心能力

- **四种 Work Mode**：Normal、Brainstorming、Exploration 和 Experiment。
- **跨 Harness Research Core**：Claude Code 与 Pi 共享状态机、Governor、Policy、
  Checkpoint 和 Artifact metadata。
- **真实工具约束**：Claude Code 通过 `PreToolUse` Hook 执行 Governor，而不只依赖 Prompt。
- **完整实验生命周期**：Experiment 必须通过 Checkpoint 或有效 Abort 正式结束。
- **复现保真**：禁止静默缩小数据、改变 split、替换 checkpoint、减少 seeds 或修改其他
  reference invariants。
- **结构化 evidence**：Checkpoint 记录实验条件、协议来源、偏差、结果、分析、不确定性和
 下一步决策。
- **可见状态**：Claude Status Line 持续展示 mode、actions、artifacts、Soft Review 和
  active experiment。

## 支持情况

| 能力 | Claude Code | Pi |
| --- | --- | --- |
| Research State 与 Work Modes | 支持 | 支持 |
| Research Policy 持续注入 | Hooks | Context injection |
| Governor 工具约束 | `PreToolUse` | Pi tool gate |
| Experiment lifecycle | MCP tools | Pi tools |
| Research Checkpoint | Markdown report | TUI + Markdown report |
| Artifact metadata | Write/Edit Hooks | Artifact Radar |
| Artifact preview | Claude 原生文件读取 | Pi TUI 图片和表格 preview |
| Status display | Claude Status Line | Pi widget |

## Claude Code 安装

仓库本身是一个可直接添加的 Claude Code Marketplace。

### 1. 添加 Marketplace

```bash
claude plugin marketplace add CrossStar/research-loop
```

### 2. 安装 Plugin

```bash
claude plugin install research-loop@research-loop
```

### 3. 首次启动并激活 Status Line

安装完成后启动 Claude Code。`SessionStart` Hook 会自动安装或迁移 Research Loop
Status Line，并保留已有的 command-based Status Line。首次启动会提示：

```text
Research Loop Status Line was installed or migrated. Restart Claude Code once to display it.
```

看到提示后再重启一次 Claude Code，状态栏即可显示。Claude Code 在 Plugin Hook 执行前已经
读取完本轮 settings，因此首次安装后的一次额外重启无法省略。

如果自动安装失败，也可以输入“请安装 Research Loop Status Line”，让 Claude 调用
`research_configure_statusline` 的 `install` action。

### 4. 启用 Research Loop

输入：

```text
请启用 Research Loop。
```

也可以显式调用 Skill：

```text
/research-loop:research-loop
```

Research Loop 默认关闭；启用后从 Normal Mode 开始。

### 更新与卸载

```bash
claude plugin update research-loop@research-loop
claude plugin uninstall research-loop@research-loop
claude plugin marketplace remove research-loop
```

卸载 Plugin 前，可以要求 Claude 卸载 Status Line，以恢复原有配置：

```text
请卸载 Research Loop Status Line。
```

## Claude Code 组件

### Skill

`skills/research-loop/SKILL.md` 是用户入口和 Research Policy 使用说明。四种 Work Mode
始终是同一个主 session 的全局行为契约，不会被简单映射成四个 subagents。

### MCP tools

```text
research_set_enabled
research_mode
research_state
research_configure_statusline
research_checkpoint
research_abort_experiment
```

| Tool | 作用 |
| --- | --- |
| `research_set_enabled` | 启用或关闭 Research Loop |
| `research_mode` | 切换 Work Mode，并声明 Experiment Context |
| `research_state` | 查询当前权威状态、artifacts 和 policy |
| `research_configure_statusline` | 安装、检查或卸载 Claude Status Line |
| `research_checkpoint` | 提交结构化 evidence report 并结束 Experiment |
| `research_abort_experiment` | 仅在没有 interpretable evidence 时中止 Experiment |

### Hooks

| Hook | 作用 |
| --- | --- |
| `SessionStart` | 初始化或恢复 Research State，并注入当前状态 |
| `SessionEnd` | 将 snapshot 标记为 inactive，避免显示过期状态 |
| `UserPromptSubmit` | 记录用户请求、重置 round counters 并注入 Policy |
| `PreToolUse` | 执行 Governor、fidelity guard 和 lifecycle gate |
| `PostToolUse` | 为受支持的 Write/Edit 输出记录 artifact metadata |

### Status Line

Research Loop 关闭时不额外占用一行；启用后显示与 Powerline 主题协调的紧凑状态胶囊：

```text
◈ Research · Normal · 2A · 0O
◈ Research · Experiment · Reproduction · 6A · 3O · Review
◈ Research · Checkpoint · 2 results
```

`A` 表示本轮 actions，`O` 表示已索引 outputs。Status Line 直接读取本地
`ResearchCoreSnapshot`，不调用模型或 MCP，不写 Research State，并在错误时 fail-open。
已有 command-based Status Line 会被保留并显示在 Research Loop 上方。

## Pi 安装

### 从 GitHub 安装

```bash
pi install git:github.com/CrossStar/research-loop
```

### 本地加载

```bash
git clone https://github.com/CrossStar/research-loop.git
cd research-loop
npm install
pi -ne -e .
```

Pi 中使用：

```text
/research on
/research off
/artifacts
```

## Work Modes

| Mode | 主要不确定性 | Agent 行为 | 主要产物 |
| --- | --- | --- | --- |
| Normal | 目标明确 | 普通交流、实现、review 和维护 | 任务结果 |
| Brainstorming | 不确定应选择哪个方向 | 发散方案、比较 trade-off、收敛决策 | Decision Map |
| Exploration | 不理解项目或实验代码 | 提取与科学结论相关的最小充分实现 | Experiment Blueprint |
| Experiment | 需要实际运行获得 evidence | 声明协议、执行实验、分析结果 | Research Checkpoint |

Agent 根据主要不确定性选择模式：

```text
选择不确定性      -> BRAINSTORMING
代码事实不确定性  -> EXPLORATION
经验事实不确定性  -> EXPERIMENT
其他任务          -> NORMAL
```

Mode transition 只在主要行为契约发生变化时执行，不因单次文件读取或命令调用频繁切换。

### Normal Mode

用于目标明确的交流、实现、bug 修复、文档和 review。普通软件验证不是科研实验，也不会产生
Research Checkpoint。

### Brainstorming Mode

用于扩大并整理决策空间。Agent 应明确问题边界、候选方向、trade-off、关键假设、未知项和
推荐方向。该模式默认不编辑代码，也不运行 empirical experiment。

### Exploration Mode

用于建立研究者所需的最小充分理解，而不是生成 file-by-file summary。Experiment Blueprint
应覆盖：

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

开始任何能够产生科学 evidence 的任务前，必须切换到 Experiment Mode。

### Experiment Mode

进入时必须声明：

- Research Question；
- experiment title 和 intent；
- planned data scope；
- reference protocol（如适用）。

Experiment 不能静默退出：

```text
EXPERIMENT -> research_checkpoint -> NORMAL
```

只有完全没有产生 interpretable evidence 时，才能使用 `research_abort_experiment`。负结果、
失败模式和 diagnostic observation 都属于应进入 Checkpoint 的 evidence。

## Checkpoint

Checkpoint 由研究语义触发，而不是固定 action 上限。典型触发条件包括：

- evidence 改变当前 hypothesis；
- 后续实验出现有意义的分支；
- 下一步成本显著增加；
- uncertainty 不再下降；
- 需要用户作出研究决策。

Checkpoint 应包含：

- Research Question 和 working hypothesis；
- 每个已完成实验的实际 protocol；
- data scope、sources 和 deviations；
- observation、structured results 和 analysis；
- strongest justified conclusion；
- uncertainty、limitations 和 next step；
- 仅包含能够解释且与结论相关的 artifacts。

`SOFT REVIEW` 只是非阻塞语义复盘提示，不会自动中断实验，也不会自动赋予 Checkpoint
资格。

## Reproduction Fidelity

启动复现前必须核对：

- official paper，包括 appendix 和 supplementary material；
- 对应 commit 或 tag 的 official repository README；
- 相关 open/closed GitHub issues，优先关注 maintainer clarification。

当 paper、README、issue guidance 或实际代码行为存在冲突时，必须披露冲突及其科学影响。

每个 reproduction experiment 应记录：

- `protocol.intent`；
- `protocol.dataScope`；
- `protocol.sources`；
- `protocol.deviations`。

缺少 paper、README 或 issue source coverage 时，Checkpoint validation 会拒绝 reproduction
report。未获用户批准的 deviation 会显示为 protocol warning。

## 架构

```text
research-loop/
├── src/core/       # Harness-neutral state、Governor、Policy、Checkpoint、Artifact metadata
├── src/            # Pi adapter、Pi session persistence、TUI 和 artifact preview
├── src/claude/     # Claude state store、Hooks、MCP server 和 Status Line
├── skills/         # Claude Code Research Loop Skill
├── hooks/          # Claude Code Hook registration
└── .claude-plugin/ # Plugin manifest 和 Marketplace manifest
```

Research Core 不依赖 Pi 或 Claude Code API。Adapter 只负责宿主注册、生命周期事件、状态持久化
和体验层能力。

详细迁移说明见 [`docs/claude-plugin.md`](docs/claude-plugin.md)。

## 本地开发

```bash
git clone https://github.com/CrossStar/research-loop.git
cd research-loop
npm install
npm run check
npm run test:claude
npm run check:claude
```

本地加载 Claude Plugin：

```bash
claude --plugin-dir .
```

验证 Marketplace：

```bash
claude plugin validate --strict .claude-plugin/marketplace.json
```

构建 Claude bundles：

```bash
npm run build:claude
```

## 当前限制

- 同一 worktree 建议只运行一个启用了 Research Loop 的 Claude session；当前状态路由仍以
  project path 为主。
- Claude Artifact metadata 目前优先覆盖 Write/Edit 输出；Bash 生成文件的完整增量扫描仍在
 后续计划中。
- Claude Code Plugin manifest 尚不支持原生注册 Status Line，因此首次 `SessionStart` 会
  自动安装 renderer，但需要再重启一次 Claude Code 才能显示。

## 仓库

<https://github.com/CrossStar/research-loop>

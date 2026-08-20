# Research Loop

Research Loop 是一个面向科研 Agent 的 evidence-first 研究控制插件，同时支持
**Claude Code Plugin** 和 **Pi Extension**。

它不替 Agent 做研究决策，而是为同一个主 Agent 保存 Research State，提供三种 Work Mode、
实际生效的工具限制，以及用于记录实验结果的 Checkpoint。普通调研直接围绕问题展开；只有
真正运行实验时才要求记录实验设置和结果。

## 核心能力

- **三种 Work Mode**：Brainstorming、Exploration 和 Experiment。
- **跨 Harness Research Core**：Claude Code 与 Pi 共享状态机、Governor、Policy、
  Checkpoint 和 Artifact metadata。
- **真实工具约束**：Claude Code 通过 `PreToolUse` Hook 执行 Governor，而不只依赖 Prompt。
- **完整实验生命周期**：Experiment 必须通过 Checkpoint 或有效 Abort 正式结束。
- **复现设置保护**：禁止未经用户同意缩小数据、改变 split、替换 checkpoint、减少 seeds
  或修改其他关键设置；缩减运行必须明确作为 diagnostic。
- **结构化 evidence**：Checkpoint 记录实际实验条件、参考来源、设置变化、结果、分析和
  下一步。
- **可见状态**：Claude Status Line 持续展示 mode、actions、artifacts、Soft Review 和
  active experiment。

## 支持情况

| 能力 | Claude Code | Pi |
| --- | --- | --- |
| Research State 与 Work Modes | 支持 | 支持 |
| 当前模式提示 | Session/Prompt Hooks | Context injection |
| Governor 工具约束 | `PreToolUse` | Pi tool gate |
| Experiment lifecycle | MCP tools | Pi tools |
| Research Checkpoint | Markdown report | TUI + Markdown report |
| Artifact metadata | Write/Edit Hooks | Artifact Radar |
| Artifact preview | Claude 原生文件读取 | Pi TUI 图片和表格 preview |
| Status display | Claude Status Line | Pi footer status |

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

Research Loop 默认关闭；启用后从 Exploration Mode 开始。普通直接实现任务应保持关闭。

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

`skills/research-loop/SKILL.md` 是用户入口和使用说明。三种 Work Mode 表示同一个主 session
当前正在做的工作，不会被简单映射成独立 subagents。Skill 要求 Agent 在模式切换后直接工作，
不向用户复述内部流程。

### Read-only Subagents

Plugin 提供两个可选的只读 workers：

| Agent | 用途 | 工具 |
| --- | --- | --- |
| `research-explorer` | 追踪执行路径、实验设置和实现事实 | Read、Grep、Glob |
| `research-reviewer` | 核对指定方法、复现设置或结果解释 | Read、Grep、Glob |

Claude 内置 `Explore` Agent 也可以作为只读 worker。Subagent 直接回答主会话给出的具体问题，
不能切换模式、启停 Research Loop、提交 Checkpoint、运行实验或继续派生 Agent。主 Agent
需要等 active Subagents 结束后再改变 Research Loop 状态。内部仍用 dispatch 和 lease 绑定
并发 worker，但这些实现术语不会被反复注入 Agent 提示。

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
| `UserPromptSubmit` | 记录用户请求、重置 round counters 并注入一次简短模式提示 |
| `PreToolUse` | 静默执行 Governor、复现设置检查、subagent 权限和状态转换检查；只在拒绝时返回原因 |
| `PostToolUse` | 静默记录 parent/subagent artifact metadata；成功返回不提前回收尚待 `SubagentStart` 领取的 dispatch |
| `PostToolUseFailure` | 回收失败的 Agent dispatch |
| `SubagentStart` | 将 pending dispatch 绑定到 agent id 并注入一次任务和只读说明 |
| `SubagentStop` | 关闭 lease，使 parent lifecycle 可以继续 |

### Status Line

Status Line 使用附属于主状态栏的 Terminal Rail，不修改已有 `ccline` 或其他 command-based
Status Line：

```text
  ╰─ ◇ research  off
  ╰─ ◇ research  brainstorming  ·  read only
  ╰─ ◇ research  exploration  ·  read only
  ╰─ ◆ research  experiment  ·  reproduction  ·  6 actions  ·  3 outputs
  ╰─ ◇ research  exploration  ·  read only  ·  2 agents
  ╰─ ◆ research  checkpoint  ·  2 results
```

OFF 状态保留低对比度弱提示；Experiment 和 Checkpoint 使用实心标记。Status Line 直接读取
本地 `ResearchCoreSnapshot`，不调用模型或 MCP，不写 Research State，并在错误时
fail-open。已有 command-based Status Line 会被保留并显示在 Research Loop 上方。

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

### Pi Footer Status

Pi 版本使用原生 footer status，不再在编辑器下方占用一整行。视觉语义与 Claude Terminal
Rail 一致，同时使用当前 Pi theme 的语义色：

```text
◇ research  off
◇ research  brainstorming · read only
◇ research  exploration · read only
◆ research  experiment · reproduction · 6 actions · 3 outputs · review due
◆ research  checkpoint · 2 results
```

Exploration 使用 accent，Brainstorming 和 soft review 使用 warning，Experiment 和 Checkpoint
使用 success。扩展在 reload 时会清除旧 `belowEditor` widget，在 session shutdown
时清理 footer status。

## Work Modes

| Mode | 当前工作 | Agent 行为 | 结果 |
| --- | --- | --- | --- |
| Brainstorming | 比较可能方向 | 比较真正不同的方案并给出推荐 | 按问题组织的建议 |
| Exploration | 理解代码或材料 | 定向读取、追踪行为并给出引用 | 相关发现 |
| Experiment | 实际运行获得 evidence | 声明问题与计划、执行并记录结果 | Research Checkpoint |

```text
普通直接实现   -> RESEARCH OFF
比较可能方向   -> BRAINSTORMING
理解代码或材料 -> EXPLORATION
运行经验工作   -> EXPERIMENT
```

Agent 在模式切换工具完成后直接开始工作，不需要向用户播报模式或内部流程。只有工作类型变化时
才切换 Mode，不因单次文件读取或命令调用频繁切换。

Research Loop 不再为普通工作保留单独的 Mode。目标明确的实现、bug 修复、文档、review 和
普通软件验证应关闭 Research Loop；它们不会产生 Research Checkpoint。

### Brainstorming Mode

用于比较可能方向。Agent 应提出真正不同的候选方案，解释与当前选择有关的 trade-off，并给出
推荐。回答结构随问题而定；该模式默认不编辑代码，也不运行 empirical experiment。

### Exploration Mode

用于理解与当前问题有关的代码或材料，而不是生成 file-by-file summary。Agent 只追踪回答问题
所需的执行路径、配置和关键实现，并直接给出发现及有用的文件引用；不强制生成固定 Blueprint。
开始任何能够产生科学 evidence 的任务前，必须切换到 Experiment Mode。

### Experiment Mode

进入时必须声明：

- Research Question；
- experiment title 和 intent；
- planned data scope；
- reference protocol（如适用）。

Experiment 不能静默退出：

```text
EXPERIMENT -> research_checkpoint -> EXPLORATION
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

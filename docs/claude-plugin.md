# Claude Code Plugin 迁移说明

本文记录 Claude Code Plugin 的代码库分析、迁移边界、运行方式和后续计划。
项目名、Plugin 名、Marketplace 名和 GitHub 仓库名统一为 `research-loop`。

## 代码库分析

迁移前的实现可以分为三类：

| 原模块 | 研究语义 | Harness 耦合 | 第一阶段处理 |
| --- | --- | --- | --- |
| `governor.ts` | Work Mode policy、fidelity guard、command gate | 无 | 移入 `src/core/`，保留兼容 re-export |
| `runtime.ts` | 状态机、mode transition、experiment lifecycle | 强依赖 Pi session、tools 和 TUI | 状态机抽入 `ResearchCore`，原文件变为 Pi adapter |
| `checkpoint.ts` | 协议、实验、结果、分析和不确定性表达 | schema 与格式化可复用，render 强依赖 Pi TUI | normalization 与 Markdown report 抽入 core，保留 Pi render |
| `artifacts.ts` | artifact metadata、发现、preview | metadata 与扫描基本独立；Parquet 和 UI preview 依赖 Pi | 抽出 metadata resolver；Pi Radar 与 preview 暂时保留 |
| `index.ts` | 无新增研究语义 | Pi extension registration 和 lifecycle | 保持为 Pi adapter 入口 |

这一区分避免将 Pi API 机械替换成 Claude API。第一阶段只抽取两个 adapter 实际共享的
状态、判断和报告逻辑，不引入 factory、通用 event bus 或无实际调用方的 interface。

## 当前结构

```text
research-loop/
├── src/core/
│   ├── types.ts          # Work Mode、Experiment Context、Research State、Artifact metadata
│   ├── governor.ts       # Research Policy、fidelity 和 command gates
│   ├── research-core.ts  # Harness-neutral state machine 与 experiment lifecycle
│   ├── checkpoint.ts     # Checkpoint normalization、validation 和 Markdown report
│   └── artifacts.ts      # Harness-neutral artifact metadata resolver
├── src/
│   ├── index.ts          # Pi registration adapter
│   ├── runtime.ts        # Pi persistence、tool availability 和 TUI adapter
│   ├── checkpoint.ts     # Pi tool schema、preview 和 TUI render adapter
│   └── artifacts.ts      # Pi Artifact Radar、preview 和 TUI integration
├── src/claude/
│   ├── state-store.ts       # Parent snapshot、subagent leases 和 append-only events
│   ├── subagents.ts         # Dispatch、lease policy 和只读 tool gate
│   ├── hook.ts              # Claude Code parent/subagent hook handler
│   ├── mcp-server.ts        # Claude lifecycle MCP tools
│   ├── statusline.ts        # 可组合的 Claude Status Line renderer
│   ├── statusline-config.ts # 安装、恢复和已有 status line preservation
│   └── statusline-cli.ts    # 本地 install/status/uninstall CLI
├── agents/
│   ├── research-explorer.md
│   └── research-reviewer.md
├── skills/research-loop/SKILL.md
├── hooks/hooks.json
└── .claude-plugin/
    ├── plugin.json      # Plugin manifest and bundled MCP server registration
    └── marketplace.json # Self-hosted Claude Code Marketplace manifest
```

## Claude 原生机制映射

### Skill

`skills/research-loop/SKILL.md` 是用户入口和 Research Loop 工作说明。它强调四种 Work
Mode 是同一主 session 的全局行为契约，不是四个 subagents。

### MCP tools

内置 stdio MCP server 暴露以下状态操作：

- `research_set_enabled`：启用或关闭 Research Loop；
- `research_mode`：切换 Normal、Brainstorming、Exploration 或 Experiment；
- `research_state`：读取权威状态、active experiment、artifacts 和 policy；
- `research_configure_statusline`：安装、检查或卸载 Claude Status Line；
- `research_checkpoint`：验证并格式化 checkpoint，然后正式结束 Experiment；
- `research_abort_experiment`：仅在明确确认没有 interpretable evidence 时中止。

Experiment Mode 必须在进入时声明 title、question、intent 和 planned data scope。进入后不能
通过普通 mode transition 离开，只能 checkpoint 或有效 abort。

### Read-only Subagents

`research-explorer` 和 `research-reviewer` 是 Plugin 自带的只读 workers；Claude 内置
`Explore` 也作为 compatibility worker。它们获得 parent 当前 Work Mode 的不可变 lease，
只允许 Read、Grep、Glob 及受控的只读查询。Subagent 不能调用 lifecycle MCP tools、修改
文件、运行 shell/experiment 或继续 dispatch Agent。

Work Mode 和 Experiment Context 始终由 parent session 持有。Agent dispatch 先写入独立的
pending record，`SubagentStart` 或首个带 agent identity 的 tool hook 再将其绑定为 lease。
`SubagentStop` 关闭 lease；只要存在 active 或 pending worker，parent lifecycle transition
就会被拒绝。Subagent artifacts 使用唯一 event 文件汇入 parent，避免并行 worker 覆盖同一
snapshot。

### Hooks

`hooks/hooks.json` 注册：

- `SessionStart`：初始化 session state，并注入 Plugin 状态；
- `SessionEnd`：将 snapshot 标记为 inactive，避免无 Plugin session 显示过期状态；
- `UserPromptSubmit`：记录当前用户请求、重置 round counters，并注入最新 policy；
- `PreToolUse`：区分 parent/subagent、运行 Governor 或 lease gate，并再次注入 policy；
- `PostToolUse`：记录 artifacts，并清理已完成 Agent dispatch；
- `PostToolUseFailure`：清理失败的 Agent dispatch；
- `SubagentStart`：绑定 dispatch、注入只读 lease；
- `SubagentStop`：关闭 lease，使 parent lifecycle 可以继续。

Governor 因此不只存在于 prompt 中。Brainstorming 和 Exploration 的写入会被实际拒绝；
这些 read-oriented mode 中检测到的 empirical shell command 也会被拒绝。Experiment 的
terminal transition 和 reproduction fidelity guard 同样在 PreToolUse 生效。

### Status Line

Claude Code Plugin manifest 当前不支持声明 `statusLine` 字段；strict validation 会将该字段
判定为 ignored。Research Loop 因此在首次 `SessionStart` 时运行一次性 installer，并通过
`systemMessage` 明确提示用户重启。Claude Code 在 Hook 执行前已经读取本轮 settings，所以
首次安装后必须额外重启一次。

也可以要求 Claude 手动调用：

```text
research_configure_statusline { "action": "install" }
```

也可以从仓库运行：

```bash
npm run statusline:install
npm run statusline:status
npm run statusline:uninstall
```

安装器将自包含 renderer 复制到稳定的 Claude 用户目录，并更新
`~/.claude/settings.json`。如果用户已有 command-based status line，安装器会保存原配置、
先运行原 command，再把 Research Loop 状态显示在下一行；卸载时恢复原配置。旧版
`pi-research-loop` installer 会被自动迁移，同时保留 migration config 中的原 Status Line。

显式卸载会写入 opt-out marker，防止下一次 `SessionStart` 自动重装。重新执行 install 会
清除 marker。安装、迁移和卸载后都需要重启 Claude Code。

Status Line 从共享 `ResearchCoreSnapshot` 读取，并以 Terminal Rail 形式附属于已有状态栏：

```text
  ╰─ ◇ research  off
  ╰─ ◇ research  normal  ·  2 actions  ·  1 output
  ╰─ ◇ research  brainstorming  ·  read only
  ╰─ ◇ research  exploration  ·  blueprint
  ╰─ ◆ research  experiment  ·  reproduction  ·  6 actions  ·  3 outputs
  ╰─ ◇ research  exploration  ·  blueprint  ·  2 agents
  ╰─ ◆ research  checkpoint  ·  2 results
```

OFF 状态保留低对比度提示；Experiment 和 Checkpoint 使用实心标记；soft review 会将强调色
切换为琥珀色并追加 `review due`。renderer 不调用模型或 MCP，不写 Research State，并在
错误时 fail-open。没有 active Plugin session state 的项目不会追加 Research Loop 行。

## 状态持久化

Hook 和 MCP server 是独立进程，不能依赖单个 JavaScript 进程内存。Claude adapter 使用
project-keyed 目录，并把 parent、dispatch、lease 和 events 分开：

```text
$TMP/research-loop/<project-path-hash>/
├── state.json
├── dispatches/<dispatch-hash>.json
├── agents/<agent-hash>.json
└── events/<timestamp>-<uuid>.json
```

`state.json` 只由 parent session 持有，包含 Work Mode、Experiment Context、artifacts、action
counters 和 lifecycle transition。每个 pending dispatch 和 active lease 使用独立文件；并行
Subagents 通过 append-only artifact events 交付 metadata。lease claim 使用原子 lock directory，
避免两个并行 worker 领取同一个 dispatch。相同 parent session id 的 resume 会恢复状态；新
parent session 会从 Research Loop OFF 开始并清理旧 leases。

同一 worktree 的多个独立 parent Claude sessions 仍共享 project owner，因此暂不支持同时启用；
同一 parent 下的多个只读 Subagents 则是本阶段明确支持的并发模型。

## Marketplace 安装

```bash
claude plugin marketplace add CrossStar/research-loop
claude plugin install research-loop@research-loop
```

仓库根目录同时是 Plugin source，因此 Marketplace entry 使用 `"source": "./"`。Plugin
和 Marketplace version 必须保持一致，发布 tag 使用 `research-loop--v<version>`。

## 本地开发与加载

Claude Plugin 的 Hook、MCP 和 Status Line 入口会构建为自包含 JavaScript bundle，
避免安装后的 runtime 依赖解析问题。

```bash
npm install
npm run build:claude
claude plugin validate --strict .
npm run statusline:install
claude --plugin-dir .
```

在 Claude Code 中可使用自然语言要求“启用 Research Loop”，或调用：

```text
/research-loop:research-loop
```

使用 `/mcp` 检查 `research-loop` server 及 tools 是否已连接，使用 `/hooks` 检查 Plugin
hooks 是否已注册。

## 验证

```bash
npm run check
npm run test:claude
claude plugin validate --strict .claude-plugin/plugin.json
claude plugin validate --strict .claude-plugin/marketplace.json
```

`test:claude` 包含：

1. Core mode、Governor 和 checkpoint lifecycle smoke test；
2. Hook session、policy injection 和 PreToolUse denial smoke test；
3. Subagent dispatch、lease、只读 gate、lifecycle ownership、并发 artifact events 和 cleanup
   smoke test；
4. 通过官方 MCP SDK client 启动 bundled server，完成 enable → Experiment → checkpoint
   → Normal，并验证 Status Line install、state rendering、已有 command composition 和
   uninstall restore。

## 第一版边界

已完成最小闭环：

```text
enable
  -> choose Work Mode
  -> persist state and inject policy
  -> govern tools in PreToolUse
  -> enter Experiment
  -> execute and report evidence
  -> research_checkpoint
  -> Normal
```

暂未作为第一优先级实现：

- Pi 图片、表格和 widget 体验的 Claude 等价实现；
- Bash 生成文件的完整实时 Artifact Radar；
- 专用 explorer/researcher subagent；
- marketplace 发布与自动升级；
- 同一 worktree 的并发 Claude session isolation。

这些能力可以在核心闭环经实际使用稳定后逐步加入，而无需改变 Research Core 的状态和
checkpoint 语义。

## 后续迁移计划

1. 将剩余 Pi checkpoint schema duplication 收敛到共享 schema 描述，同时保留 Pi render。
2. 将 Artifact Radar 的文件变化采集与 preview 完全分离，为 Claude PostToolUse/monitor
   adapter 提供增量扫描。
3. 增加可选的 read-only explorer subagent，但禁止 subagent 持有或修改全局 Research
   State。
4. 在 Claude 提供稳定 session identity 后，将 state store 升级为并发安全的 per-session
   storage。
5. 增加 marketplace packaging，并在 Claude Code 提供 Plugin 原生 Status Line registration
   后替换一次性 settings installer。

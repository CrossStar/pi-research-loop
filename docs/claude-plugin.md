# Claude Code Plugin 迁移说明

本文记录 `claude-plugin` 分支第一阶段的代码库分析、迁移边界、运行方式和后续计划。
项目名、Plugin 名和仓库名均保持 `pi-research-loop`。

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
pi-research-loop/
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
│   ├── state-store.ts    # Claude hook/MCP 共享状态
│   ├── hook.ts           # Claude Code hook handler
│   └── mcp-server.ts     # Claude lifecycle MCP tools
├── skills/research-loop/SKILL.md
├── hooks/hooks.json
└── .claude-plugin/plugin.json # manifest and bundled MCP server registration
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
- `research_checkpoint`：验证并格式化 checkpoint，然后正式结束 Experiment；
- `research_abort_experiment`：仅在明确确认没有 interpretable evidence 时中止。

Experiment Mode 必须在进入时声明 title、question、intent 和 planned data scope。进入后不能
通过普通 mode transition 离开，只能 checkpoint 或有效 abort。

### Hooks

`hooks/hooks.json` 注册：

- `SessionStart`：初始化 session state，并注入 Plugin 状态；
- `UserPromptSubmit`：记录当前用户请求、重置 round counters，并注入最新 policy；
- `PreToolUse`：加载权威状态、运行共享 Governor、拒绝违规调用，并再次注入 policy；
- `PostToolUse`：为 Write/Edit 类工具产生的受支持文件记录 artifact metadata。

Governor 因此不只存在于 prompt 中。Brainstorming 和 Exploration 的写入会被实际拒绝；
这些 read-oriented mode 中检测到的 empirical shell command 也会被拒绝。Experiment 的
terminal transition 和 reproduction fidelity guard 同样在 PreToolUse 生效。

## 状态持久化

Hook 和 MCP server 是独立进程，不能依赖单个 JavaScript 进程内存。Claude adapter 将
`ResearchCoreSnapshot` 写入操作系统临时目录：

```text
$TMP/pi-research-loop/<project-path-hash>/state.json
```

状态包含 session id、Work Mode、Experiment Context、artifacts、action counters、当前用户
请求和 terminal transition 信息。相同 session id 的 resume 会恢复状态；新 session 会从
Research Loop OFF 开始。

第一版使用项目级 active state 文件，因此同一项目内同时运行多个 Claude Code sessions
可能互相覆盖 active session。后续可在 Claude MCP transport 提供稳定 session identity 后
改为完整的 per-session routing；在此之前，同一 worktree 建议只运行一个启用 Research
Loop 的 Claude session。

## 本地开发与加载

Claude Plugin 的 hook 和 MCP 入口会构建为自包含 JavaScript bundle，避免安装后的
runtime 依赖解析问题。

```bash
npm install
npm run build:claude
claude plugin validate --strict .
claude --plugin-dir .
```

在 Claude Code 中可使用自然语言要求“启用 Research Loop”，或调用：

```text
/pi-research-loop:research-loop
```

使用 `/mcp` 检查 `research-loop` server 及 tools 是否已连接，使用 `/hooks` 检查 Plugin
hooks 是否已注册。

## 验证

```bash
npm run check
npm run test:claude
claude plugin validate --strict .
```

`test:claude` 包含：

1. Core mode、Governor 和 checkpoint lifecycle smoke test；
2. Hook session、policy injection 和 PreToolUse denial smoke test；
3. 通过官方 MCP SDK client 启动 bundled server 并完成 enable → Experiment → checkpoint
   → Normal 的端到端 smoke test。

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
- status line；
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
5. 在核心行为稳定后增加 status line 和 marketplace packaging。

# Research Loop

Research Loop 是一个面向科研 Agent 的 evidence-first 研究控制插件，同时支持
**Claude Code Plugin** 和 **Pi Extension**。

它不替 Agent 做研究决策，而是为同一个主 Agent 保存 Research State，提供三种 Work Mode、
实际生效的工具限制，以及用于记录实验结果的 Checkpoint。普通调研直接围绕问题展开；只有
真正运行实验时才要求记录实验设置和结果。

## 核心能力

- **三种 Work Mode**：Brainstorming、Exploration 和 Experiment。
- **跨 Harness Research Core**：Claude Code 与 Pi 共享状态机、Governor、Policy 和
  Artifact metadata；Pi 额外提供持久化 Markdown Checkpoint 与统一 Viewer。
- **真实工具约束**：Claude Code 通过 `PreToolUse` Hook 执行 Governor，而不只依赖 Prompt。
- **完整实验生命周期**：Experiment 必须通过 Checkpoint 或有效 Abort 正式结束。
- **复现设置保护**：禁止未经用户同意缩小数据、改变 split、替换 checkpoint、减少 seeds
  或修改其他关键设置；缩减运行必须明确作为 diagnostic。
- **真实用户决策**：Pi 对精确的成本升级和协议偏差显示同步确认；可选检测
  `ask_user_question`，在关键研究分支中使用结构化问答而不是猜测。
- **结构化 evidence**：Checkpoint 记录实际实验条件、参考来源、设置变化、结果、分析和
  下一步；Pi 将中文研究记录持久化为 Markdown，并由插件内唯一的 Viewer 统一阅读。
- **可见状态**：Claude Status Line 持续展示 mode、actions、artifacts、Soft Review 和
  active experiment。

## 支持情况

| 能力 | Claude Code | Pi |
| --- | --- | --- |
| Research State 与 Work Modes | 支持 | 支持 |
| 当前模式提示 | Session/Prompt Hooks | Context injection |
| Governor 工具约束 | `PreToolUse` | Pi tool gate |
| Experiment lifecycle | MCP tools | Pi tools |
| Research Checkpoint | MCP Markdown report | 持久化 checkpoint.md + TUI 摘要 + localhost Viewer |
| Artifact metadata | Write/Edit Hooks | Artifact Radar |
| Artifact preview | Claude 原生文件读取 | Chafa 优先的图片、表格和网页 preview |
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

### 结构化用户决策（可选）

Research Loop 会检测当前 active tools 中是否存在 `ask_user_question`。安装
`@juicesharp/rpiv-ask-user-question` 后，Pi policy 会要求 Agent 仅在以下关键决策点集中询问：

- 会实质改变科研解释的 protocol 或 data scope；
- 多个成本或运行范围方案之间的选择；
- 多个真正不同的下一实验分支；
- Checkpoint 前确实需要用户选择下一方向。

```bash
pi install npm:@juicesharp/rpiv-ask-user-question
```

这是可选集成，不是 Research Loop 的运行时依赖。普通、可逆或用户已经回答的选择不会重复询问。
结构化问答打开时 footer 会显示 `waiting for decision`；用户按 Esc 取消问卷时，Research Loop
会中止当前 turn 并交还控制权，而不是让 Agent 再次发起同一问卷。

对于 Governor 已经识别出的某一条精确命令或设置变更，Research Loop 直接使用 Pi host
confirmation：批准后只放行该次 action；拒绝或取消会中止当前 Agent turn。对于其他 Governor
拒绝，首次结果会明确禁止原样重试；如果 Agent 仍重复同一 tool call，第二次拒绝会主动中止
当前 turn 并交还控制权。

### Pi Checkpoint Markdown 与 Viewer

Pi 的 Checkpoint Writer 与 Viewer 完全分离。完成实验时，Agent 使用混合接口提交四段连续中文
Markdown 正文，同时提交结构化 protocol、复现信息和 artifact metadata。插件将记录写入项目：

```text
checkpoints/
└── checkpoint-20260821-234100-example/
    └── checkpoint.md
```

`checkpoint.md` 包含 JSON-compatible frontmatter 和以下固定阅读结构：

```text
Checkpoint：一句话标题
1. 研究目的
2. 实验设置
3. 结果与分析
4. 结论与下一步
复现信息
```

正文中的项目相对 artifact 路径会在落盘时改写成相对于 `checkpoint.md` 的标准 Markdown 路径。
图片、CSV、JSON、模型输出和日志不会复制到 checkpoint 目录；Markdown 直接引用实验产生的原始
文件。重要 evidence 图片必须嵌入 `resultsMarkdown` 的对应分析位置，不能只出现在附件列表中。

插件内部只维护一套 `src/checkpoint-report-template.html`。Viewer 每次读取项目中的 Markdown，
因此字体、页面宽度、目录、表格、Figure caption、JSON 或代码样式更新后，所有历史 checkpoint
立即使用新样式，不需要重新生成 HTML。主要路由为：

```text
/                   # checkpoint 历史
/latest             # 永久指向最新 checkpoint
/checkpoints/{id}   # 指定 checkpoint
/api/checkpoints    # 自动发现的 metadata
/artifacts/{path}   # 项目边界内的原始 artifact
```

Viewer 支持 Markdown、MathJax、GFM 表格、Figure、右侧章节目录、历史浏览、JSON Tree/Raw 与
键名搜索、CSV preview，以及轻量的 `checkpoint-chart`。展示型图表使用 JSON code fence：

````markdown
```checkpoint-chart
{"type":"bar","title":"图 2　出现分化的实验数量","items":[{"label":"正常监督","value":0},{"label":"严格零相关监督","value":53}]}
```

图 2 显示分化集中出现在严格零相关监督条件下，这一结果提示监督条件改变了系统行为。

---
````

真正的科研图表仍由实验代码生成并正常保存；不要为了 checkpoint 装饰额外写入小 PNG。

Viewer 默认监听 `127.0.0.1`，从端口 `43119` 向上寻找空闲端口。可以配置：

```bash
RESEARCH_LOOP_CHECKPOINT_PORT=45000 RESEARCH_LOOP_SSH_HOST=moon pi -ne -e .
```

Checkpoint 完成后的固定入口和转发提示类似：

```text
✓ Experiment completed
✓ Checkpoint generated

Checkpoint:
http://127.0.0.1:43119/latest

ssh -N -o RemoteCommand=none -o RequestTTY=no -L 43119:127.0.0.1:43119 moon
```

通过 SSH 转发后，本地浏览器只需长期打开 `http://127.0.0.1:43119/latest` 并刷新。Viewer Server
随 Pi session 启停，但 Markdown 历史长期保存在项目中。默认目录可用
`RESEARCH_LOOP_CHECKPOINT_DIR` 改为项目内的其他相对路径。没有新 frontmatter 的旧 Markdown
也会被宽容发现：标题取一级标题，时间取文件修改时间，结论从结论章节推断。

模板当前的 MathJax 与 KaTeX 字体资源来自 CDN，因此公式和 TeX 字体的首次加载需要网络。

### Pi 图片渲染

如果 `chafa` 可从 `PATH` 运行，Pi Checkpoint 中的图片会优先使用 Chafa 的 Sixel renderer；
`/artifacts` 交互预览继续使用 Chafa ANSI symbol renderer。如果 Chafa 不可用或无法解码某张
图片，则自动回退到 Pi 原生的 Kitty、iTerm2、Ghostty、WezTerm 或 Warp 图片协议，不影响
artifact link 和网页图片。Checkpoint 的 Sixel 输出会按图片高度预留 TUI rows，避免覆盖后续文本。

### Pi Footer Status

Pi 版本使用原生 footer status，不再在编辑器下方占用一整行。视觉语义与 Claude Terminal
Rail 一致，同时使用当前 Pi theme 的语义色：

```text
◇ research  off
◇ research  brainstorming · read only
◇ research  exploration · read only
◆ research  experiment · reproduction · 6 actions · 3 outputs · review due
◆ research  experiment · diagnostic · 3 actions · 1 output · waiting for decision
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

#### Pi 实验代码

Pi 在 Experiment Mode 中新建或修改实验代码时，优先优化研究者的阅读、运行、调试、修改与检查
体验。顶层 `main()` 应映射自然实验阶段；Python 脚本使用 Rich 展示配置、phase、关键检查、结果表
和保存路径，使用 `tqdm` 展示真正耗时的重复工作。研究参数集中在 config/CLI，并提供直接运行、
清晰 `--help` 以及长实验的 `--quick` 或 `--smoke` 路径。

代码应显式说明随机性和实验条件，使用稳定结果目录，保存科研 artifact 一次，并以可采取行动的
错误尽早终止会浪费长时间计算的运行。避免工厂、registry、strategy/context hierarchy、细碎 wrapper、
广泛 retry/fallback 和生产服务式防御层。详细约束见
[`docs/experiment-code.md`](docs/experiment-code.md)。

## Checkpoint

Checkpoint 由研究语义触发，而不是固定 action 上限。典型触发条件包括：

- evidence 改变当前 hypothesis；
- 后续实验出现有意义的分支；
- 下一步成本显著增加；
- uncertainty 不再下降；
- 需要用户作出研究决策。

Pi Checkpoint 是简短、连续、可快速恢复上下文的中文科研记录，而不是实验日志。固定正文为：

1. **研究目的**：前置现象、要区分的问题、解释 A/B 和双方预期；
2. **实验设置**：只保留理解结果所需的条件、核心自变量、方法、参数、指标和判断标准；
3. **结果与分析**：全文主体，按“现象 → 图表证据 → 图表含义 → 解释 → 局部结论”连续写作；
4. **结论与下一步**：保守结论、关键证据、尚不能证明的内容和可区分机制的下一实验；
5. **复现信息**：模型、revision、数据版本、commit、seeds、参数、环境、files、sources 和 deviations。

每张重要图表必须直接嵌入相应分析段落，并形成独立的“图（表）→ 正式标题 → 解析”单元。
标题遵循“上表下图”：表题位于表格上方，图题位于图片或动态图表下方；解析必须说明内容的研究
含义，并在末尾用浅色分隔线与下一图表分开。Checkpoint 全文禁止使用“不是……而是……”及
同类转折句式。完整路径和审计配置进入文末，不挤占正文。打开页面后第一屏会同时显示标题、实验
metadata 和 `shortConclusion`。

`SOFT REVIEW` 只是非阻塞语义复盘提示，不会自动中断实验，也不会自动赋予 Checkpoint 资格。
Claude Code 当前仍使用原有 MCP 结构化 Markdown report；持久化项目 Markdown 与 Viewer 是 Pi
adapter 的能力。

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
├── src/core/                  # Harness-neutral state、Governor、Policy、Claude checkpoint types
├── src/checkpoint-store.ts    # Pi Markdown writer、frontmatter、discovery 和兼容读取
├── src/checkpoint-server.ts   # 单一 Viewer Server、Markdown renderer、artifact routes
├── src/checkpoint-report-template.html # 插件内唯一 Viewer HTML/CSS/JS
├── src/checkpoint.ts          # Pi hybrid writer schema、validation 和 TUI summary
├── src/                       # Pi adapter、session persistence 和 artifact preview
├── src/claude/                # Claude state store、Hooks、MCP server 和 Status Line
├── skills/         # Claude Code Research Loop Skill
├── hooks/          # Claude Code Hook registration
└── .claude-plugin/ # Plugin manifest 和 Marketplace manifest
```

Research Core 不依赖 Pi 或 Claude Code API。Adapter 只负责宿主注册、生命周期事件、状态持久化
和体验层能力。

详细文档：

- [`docs/experiment-code.md`](docs/experiment-code.md)：Pi Experiment Mode 实验代码 contract；
- [`docs/checkpoint-viewer.md`](docs/checkpoint-viewer.md)：Pi Markdown Writer、Viewer、artifact 和 chart contract；
- [`docs/claude-plugin.md`](docs/claude-plugin.md)：Claude Code Plugin 迁移与 adapter 说明。

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
- 持久化 `checkpoint.md` 与 Checkpoint Viewer 当前只在 Pi adapter 启用；Claude MCP 仍返回原有
  Markdown report，不会写入 `checkpoints/`。
- Viewer 的 MathJax 和 TeX web fonts 当前使用 CDN；无网络时正文、图片、表格和历史仍可阅读，
  但公式与 TeX 字体会使用降级表现。

## 仓库

<https://github.com/CrossStar/research-loop>

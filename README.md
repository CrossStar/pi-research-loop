# Research Loop

Research Loop 是一个面向 **Pi** 的 evidence-first 科研工作流插件。它为同一个 Agent session
维护研究状态，提供 Brainstorming、Exploration 和 Experiment 三种工作模式，并把实验结果保存为
长期可读的 Markdown Checkpoint。

插件关注真实研究循环：理解问题、设计实验、执行并观察进度、检查结果、保存 artifacts、形成阶段性
结论，然后进入下一轮实验。普通实现、文档修改和常规软件验证应关闭 Research Loop。

## 主要功能

- **三种 Work Mode**：Brainstorming、Exploration、Experiment。
- **实验生命周期**：Experiment 必须通过 Checkpoint 或有效 Abort 正式结束。
- **工具约束**：只读模式阻止实验执行和文件修改；Experiment Mode 允许实证工作。
- **复现设置保护**：修改数据范围、split、checkpoint、seeds 或其他关键设置前需要用户批准。
- **研究者友好的实验代码**：清晰 `main()`、Rich phase 展示、tqdm 进度、集中参数和可预测输出。
- **持久化 Checkpoint**：在项目的 `checkpoints/` 中写入中文 Markdown 研究记录。
- **统一 Checkpoint Viewer**：一个插件内 Viewer 展示全部历史记录、公式、表格、图片和 JSON/CSV。
- **Artifact Radar**：发现实验产生的 PNG、SVG、CSV、JSON、Parquet、PDF 等结果文件。
- **终端图片预览**：Checkpoint 图片优先使用 Chafa Sixel，`/artifacts` 使用 Chafa symbols。
- **可见状态**：Pi footer 持续显示当前 mode、实验 intent、actions、outputs 和 review 状态。

## 安装

### 从 GitHub 安装

```bash
pi install git:github.com/CrossStar/research-loop
```

安装到当前项目的 Pi settings：

```bash
pi install -l git:github.com/CrossStar/research-loop
```

固定到某个 release：

```bash
pi install git:github.com/CrossStar/research-loop@research-loop--v0.5.1
```

> Pi package 会以当前用户权限运行。安装第三方扩展前应检查源码。

### 临时试用

临时加载且不写入 settings：

```bash
pi -e git:github.com/CrossStar/research-loop
```

### 更新

更新已安装的 Pi packages：

```bash
pi update --extensions
```

查看已安装 packages：

```bash
pi list
```

### 卸载

```bash
pi remove git:github.com/CrossStar/research-loop
```

### 本地源码加载

```bash
git clone https://github.com/CrossStar/research-loop.git
cd research-loop
npm install
pi -e .
```

## 快速开始

Research Loop 默认关闭。在 Pi 中输入：

```text
/research on
```

启用后从 Exploration Mode 开始。可以直接给 Agent 一个研究任务，例如：

```text
请理解当前评估流程，并设计一个能够区分两种解释的实验。
```

开始实证执行前，Agent 会调用 `research_mode` 进入 Experiment Mode，并声明：

- Research Question；
- experiment title；
- intent；
- planned data scope；
- reference protocol（如适用）。

实验产生可解释结果后，Agent 调用 `research_checkpoint`。插件会：

1. 写入持久化 `checkpoint.md`；
2. 将状态返回 Exploration Mode；
3. 在终端显示最新 Checkpoint URL；
4. 保留真实实验 artifacts 的原始位置。

关闭 Research Loop：

```text
/research off
```

查看本 session 发现的 artifacts：

```text
/artifacts
```

## Work Modes

| Mode | 用途 | 允许的工作 | 典型结果 |
| --- | --- | --- | --- |
| Brainstorming | 比较研究方向 | 阅读、比较方案、分析 trade-off | 推荐方向 |
| Exploration | 理解代码和材料 | 定向读取、追踪行为、核对设置 | 相关发现 |
| Experiment | 获取 empirical evidence | 修改实验代码、运行实验、分析结果 | Research Checkpoint |

```text
普通直接实现   → Research Loop OFF
比较可能方向   → Brainstorming
理解代码或材料 → Exploration
运行实证工作   → Experiment
```

Experiment 不能静默退出：

```text
EXPERIMENT → research_checkpoint → EXPLORATION
```

只有完全没有产生 interpretable evidence 时，才能使用 `research_abort_experiment`。负结果、失败模式
和 diagnostic observation 都属于应进入 Checkpoint 的 evidence。

## Experiment Mode 代码规范

Pi 在 Experiment Mode 中新建或修改实验代码时，会注入一组克制的研究代码约束：

- 顶层 `main()` 映射自然语言实验阶段；
- 函数对应自然实验动作或清晰职责；
- Python 脚本使用 Rich 展示配置、phase、关键检查、结果表和保存路径；
- 真正耗时的重复工作使用 `tqdm`；
- 模型、数据、layers、seeds、batch size、split、threshold 和输出目录集中管理；
- 常规入口保持为 `python experiment.py`，并提供清晰 `--help`；
- 长实验提供 `--quick` 或 `--smoke` 路径，并显式展示缩减设置；
- seed 对 split、pseudo labels、初始化和 sampling 的影响保持可见；
- 关键 phase 结束后展示能够判断科学异常的中间结果；
- 运行完成后使用 Rich table 汇总结果，并列出准确 artifact 路径；
- 避免 factory、registry、strategy/context hierarchy、细碎 wrapper 和广泛 fallback；
- 对会浪费长时间计算的问题尽早给出具体、可采取行动的错误。

详细规范见 [`docs/experiment-code.md`](docs/experiment-code.md)。

## 持久化 Checkpoint

默认目录结构：

```text
checkpoints/
├── checkpoint-20260821-231400-example/
│   └── checkpoint.md
└── checkpoint-20260822-001500-example/
    └── checkpoint.md
```

`checkpoint.md` 包含 JSON-compatible frontmatter 和固定中文研究结构：

```text
Checkpoint：一句话标题
1. 研究目的
2. 实验设置
3. 结果与分析
4. 结论与下一步
复现信息
```

Writer 使用混合接口：四段主要正文使用自然 Markdown，protocol、reproduction 和 artifact references
保持结构化并接受校验。

### 图表规范

每个图表形成独立的“图（表）→ 正式标题 → 解析”单元：

- 表题放在表格上方；
- 图题放在图片或动态图表下方；
- 图表后必须有单独的解析段落，说明内容及其研究含义；
- 解析后使用独立的 `---` 浅色分隔线；
- Checkpoint 禁止使用“不是……而是……”“而不是”“而非”等同类转折句式。

表格示例：

```markdown
### 表 1　逐种子准确率

| 条件 | 种子数量 | 准确率 |
| --- | ---: | ---: |
| 实验组 | 2 | 0.91 |
| 对照组 | 2 | 0.82 |

表 1 显示实验组准确率领先 0.09，这一结果说明汇总差异与逐种子方向保持一致。

---
```

图片示例：

```markdown
![图 1　主要结果趋势](results/main.png "图 1　主要结果趋势")

图 1 显示两个随机种子的差异方向一致，这一证据支持稳定效应解释。

---
```

轻量展示图表可以使用 `checkpoint-chart`：

````markdown
```checkpoint-chart
{"type":"bar","title":"图 2　平均准确率","items":[{"label":"实验组","value":0.91},{"label":"对照组","value":0.82}]}
```

图 2 显示实验组柱高超过对照组，这一差异意味着当前范围内存在稳定的正向效应。

---
````

真正的科研图表仍由实验代码生成并保存在原始结果目录。Viewer 动态生成的展示图不额外写入 PNG。

## Checkpoint Viewer

插件只维护一个 HTML/CSS/JS Viewer。历史 Checkpoint 保持 Markdown 格式，Viewer 样式更新后，所有
历史记录立即使用新样式，无需重新生成 HTML。

主要路由：

```text
/                   Checkpoint 历史
/latest             最新 Checkpoint 的稳定入口
/checkpoints/{id}   指定历史记录
/api/checkpoints    自动发现的 metadata
/artifacts/{path}   项目内原始 artifact
```

Viewer 支持：

- Markdown 与 GFM tables；
- MathJax 公式；
- 图片和正式图题；
- `checkpoint-chart` bar/line 图；
- 右侧章节目录和历史导航；
- JSON Tree、Raw、键名搜索和大数组分组；
- CSV 前 100 行预览；
- 图片放大；
- Print / PDF；
- TeX Main 英文、宋体中文和 Maple Mono 代码字体。

`$...$`、`$$...$$`、`\(...\)` 和 `\[...\]` 可以渲染公式。普通金额文本如 `$5 and $10`
会保持原样。

### 监听地址

默认只监听 loopback：

```bash
RESEARCH_LOOP_CHECKPOINT_HOST=127.0.0.1 pi -e .
```

在可信局域网中直接访问时，可以显式监听全部 IPv4 interfaces：

```bash
RESEARCH_LOOP_CHECKPOINT_HOST=0.0.0.0 pi -e .
```

只接受 `127.0.0.1` 和 `0.0.0.0`。`0.0.0.0` 模式没有 authentication，Pi 会显示安全警告。
终端 URL 使用服务器 hostname；客户端无法解析时，使用服务器 IP 替换 hostname。

### SSH 转发

远程访问推荐保留 `127.0.0.1`，并在本地计算机执行终端给出的单行命令：

```bash
ssh -N -o RemoteCommand=none -o RequestTTY=no -L 43119:127.0.0.1:43119 moon
```

然后打开：

```text
http://127.0.0.1:43119/latest
```

## Artifact 行为

Experiment Runner 负责生成真实科研 artifacts，例如：

```text
PNG / SVG
CSV / Parquet
JSON / JSONL
logs
model checkpoints
raw predictions
activations
```

Checkpoint Writer 只记录引用。图片、表格和模型输出不会复制到 `checkpoints/`，也不会以 base64
写入 Markdown。

如果 `chafa` 在 `PATH` 中：

- Checkpoint evidence 图片使用 Chafa Sixel；
- `/artifacts` 图片使用 Chafa ANSI symbols；
- Chafa 不可用时回退到 Pi 原生 terminal image protocols。

检查 Chafa：

```bash
chafa --version
```

## 结构化用户决策

Research Loop 会检测 active tools 中是否存在 `ask_user_question`。安装可选集成后，Agent 会在以下
关键节点集中询问：

- 会改变科研解释的 protocol 或 data scope；
- 多个成本或运行范围方案之间的选择；
- 多个真正不同的下一实验分支；
- Checkpoint 前需要用户选择的研究方向。

安装：

```bash
pi install npm:@juicesharp/rpiv-ask-user-question
```

普通、可逆或已经回答的选择不会重复询问。长时间运行、分布式启动和调度命令本身不会触发成本确认；
如果命令同时改变 reproduction protocol，仍需批准该 protocol deviation。用户取消问卷时，当前
Agent turn 会停止并交还控制权。

## Reproduction Fidelity

启动 reproduction 前应核对：

- official paper，包括 appendix 和 supplementary material；
- 对应 commit/tag 的 official repository README；
- 相关 open/closed issues，优先关注 maintainer clarification。

每个 reproduction protocol 记录：

```text
intent
dataScope
sources
deviations
```

Checkpoint validation 要求 paper、README 和 issue-search coverage。任何数据范围、split、模型、
checkpoint、preprocessing、seeds 或 repeats 变化都应明确记录，并在执行前获得用户批准。

## Footer Status

Pi footer 使用紧凑状态提示：

```text
◇ research  off
◇ research  brainstorming · read only
◇ research  exploration · read only
◆ research  experiment · diagnostic · 3 actions · 1 output
◆ research  experiment · reproduction · 6 actions · 3 outputs · review due
◆ research  checkpoint · 2 results
```

Experiment 和 Checkpoint 使用实心标记，Brainstorming、Exploration 和 OFF 使用空心标记。

## 配置

| 环境变量 | 默认值 | 作用 |
| --- | --- | --- |
| `RESEARCH_LOOP_CHECKPOINT_DIR` | `checkpoints` | 项目内 Checkpoint 目录 |
| `RESEARCH_LOOP_CHECKPOINT_PORT` | `43119` | Viewer 起始端口；占用时自动向上寻找 |
| `RESEARCH_LOOP_CHECKPOINT_HOST` | `127.0.0.1` | `127.0.0.1` 或 `0.0.0.0` |
| `RESEARCH_LOOP_SSH_HOST` | 当前 hostname | SSH config alias 或远端主机名 |

示例：

```bash
RESEARCH_LOOP_CHECKPOINT_PORT=45000 \
RESEARCH_LOOP_CHECKPOINT_HOST=127.0.0.1 \
RESEARCH_LOOP_SSH_HOST=moon \
pi -e .
```

PowerShell：

```powershell
$env:RESEARCH_LOOP_CHECKPOINT_PORT = "45000"
$env:RESEARCH_LOOP_CHECKPOINT_HOST = "127.0.0.1"
$env:RESEARCH_LOOP_SSH_HOST = "moon"
pi -e .
```

## 项目结构

```text
research-loop/
├── src/index.ts                         # Pi extension entry
├── src/runtime.ts                       # Pi Research State、policy 和 tool gate
├── src/checkpoint.ts                    # Checkpoint tool 与 TUI result
├── src/checkpoint-store.ts              # Markdown writer、discovery 和 validation
├── src/checkpoint-server.ts             # Viewer server、renderer 和 artifact routes
├── src/checkpoint-report-template.html  # 唯一 Viewer HTML/CSS/JS
├── src/artifacts.ts                     # Artifact Radar 与 preview
├── src/terminal-image.ts                # Chafa 和 native image fallback
└── src/core/                            # State machine、Governor 和共享类型
```

详细文档：

- [`docs/experiment-code.md`](docs/experiment-code.md)：Experiment Mode 实验代码规范；
- [`docs/checkpoint-viewer.md`](docs/checkpoint-viewer.md)：Markdown Writer、Viewer、artifact 和 chart contract。

## 本地开发与测试

```bash
git clone https://github.com/CrossStar/research-loop.git
cd research-loop
npm install
npm run check
npm run test:pi
```

本地启动：

```bash
pi -e .
```

## 安全说明

- Pi extensions 以当前用户权限运行，能够执行代码和访问文件；安装前应检查源码。
- Viewer 默认绑定 `127.0.0.1`。
- `0.0.0.0` Viewer 没有 authentication，只应在可信网络中启用。
- Artifact routes 会解析 symlink 并阻止访问项目根目录以外的文件。
- Viewer 的 MathJax 和 TeX web fonts 当前使用 CDN；离线时正文、表格、图片和历史仍可阅读。

## Repository

https://github.com/CrossStar/research-loop

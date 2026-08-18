# pi-research-loop

面向科研 Agent 的 Pi Research Control Extension。它不替 Agent 做研究决策，而是为不同研究活动提供明确的工作契约：交流、头脑风暴、理解实验代码和执行实验分别采用不同 Work Mode；实验产生 evidence 后，通过 checkpoint 把控制权交还给用户。

## 核心观点

1. **Research Loop 只有开启和关闭。** 用户通过 `/research on|off` 控制插件，不再区分 Fast 或 Normal profile。
2. **Work Mode 由 Agent 自主选择。** Agent 根据当前不确定性的类型，在 Normal、Brainstorming、Exploration 和 Experiment 之间切换；用户指令始终拥有更高优先级。
3. **模式代表行为契约，不是流程装饰。** 只有当主要工作方式发生变化时才切换，不因一次文件读取或一条命令频繁切换。
4. **Checkpoint 由研究语义触发。** Action counter 只提供可见性和 Soft Review；没有固定上限，也不会机械中断实验。
5. **Fast execution 不再是独立模式。** Time-to-insight、避免无关工程化和最小有效验证成为 Research Loop 的基础原则，但不能削弱科学主张。
6. **复现实验采用 fidelity-first。** Agent 不得静默缩小数据、改变 split、替换 checkpoint、减少 seeds 或修改其他 reference invariants。
7. **Diagnostic 不能冒充 reproduction。** Wiring 或小样本 smoke test 是独立 diagnostic；protocol deviation 必须披露并获得执行前批准。
8. **Artifact discovery 与 evidence curation 分离。** Radar 可以发现输出，但 checkpoint 只展示 Agent 能解释且与结论相关的结果。

## 开关

```text
/research on
/research off
```

默认是 `off`。

`/research on`：

- 启用 Research Policy 和 Work Mode 状态机
- 启用 Artifact Radar
- 激活 mode transition、experiment lifecycle 和 checkpoint tools
- 初始进入 Normal Mode

`/research off`：

- 停止 policy 注入和 Artifact Radar capture
- 禁用 research tools
- 清除活动的 Experiment Phase
- 回到普通 Pi 行为

## Work Modes

| Mode | 主要不确定性 | Agent 的行为 | 主要产物 |
|---|---|---|---|
| Normal | 目标明确 | 普通交流、实现、review 和维护 | 任务结果 |
| Brainstorming | 不知道选择哪个方向 | 发散假设与方案，再收敛决策 | Decision Map |
| Exploration | 不理解现有项目或实验代码 | 阅读、追踪和提取科学相关实现 | Experiment Blueprint |
| Experiment | 需要通过实际运行获得 evidence | 声明协议、运行实验和分析结果 | Research Checkpoint |

Agent 使用以下判断选择主要模式：

```text
选择不确定性     -> BRAINSTORMING
代码事实不确定性 -> EXPLORATION
经验事实不确定性 -> EXPERIMENT
其余任务         -> NORMAL
```

状态栏示例：

```text
RESEARCH ON | NORMAL | ACTIONS 2 | OUTPUTS 0
RESEARCH ON | BRAINSTORMING | ACTIONS 4 | OUTPUTS 0
RESEARCH ON | EXPLORATION | ACTIONS 8 | OUTPUTS 1
RESEARCH ON | EXPERIMENT | ACTIONS 6 | CHECKPOINT REVIEW | OUTPUTS 3
RESEARCH ON | CHECKPOINT REACHED | RESULTS 2
RESEARCH OFF
```

Mode transition 只更新工具状态和状态栏，不要求 Agent 在正文中反复宣布模式变化。

### Normal Mode

默认工作方式。用于普通交流、目标明确的代码实现、Bug 修复、文档和 review。它没有固定输出格式，也不产生 checkpoint。

### Brainstorming Mode

用于扩大并整理决策空间。Agent 应明确问题边界、候选方向、tradeoff、假设、未知项和推荐方向。默认不修改代码、不运行实验，退出时形成紧凑的 Decision Map。

### Exploration Mode

用于理解项目，尤其是实验代码。Agent 应提取“最小充分实验描述”：足以让研究者写出忠实伪代码、列出科学变量和关键超参、解释数据到结果路径，并识别会改变实验结论的实现细节。

`Experiment Blueprint` 应覆盖：

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

信息筛选规则：

```text
它是否是写出伪代码所必需的？
它是否是复现实验结果所必需的？
改变它是否可能改变科学结论？
```

三个答案都是否，就忽略。Slurm、queue、日志框架、CLI boilerplate 和通用 utility 默认不进入 Blueprint，除非它们影响科学结果。

Exploration 可以执行静态 introspection、查看 resolved config 和检查数据结构；一旦开始运行能够产生科学 evidence 的任务，Agent 必须进入 Experiment Mode。

### Experiment Mode

进入时必须声明 Research Question、experiment intent、planned data scope 和 reference protocol。一个 Experiment Mode 可以包含多个围绕同一问题的实验。

Experiment Mode 不能静默退出：

```text
EXPERIMENT -> research_checkpoint -> NORMAL
```

如果尚未产生任何可解释 evidence，可以通过 abort 退出并说明原因。已经产生负结果、失败模式或 diagnostic evidence 时，不能用 abort 隐藏结果。

## Reproduction Fidelity

启动复现前，Agent 必须核对：

- official paper，包括 appendix 和 supplementary material
- 对应 commit/tag 的 official repository README
- 相关 open/closed GitHub issues，优先关注 maintainer 澄清

Paper、README、issue guidance 或实际代码行为冲突时，Agent 必须披露冲突及其科学影响，不能静默选择。

每个 checkpoint experiment 记录：

- `protocol.intent`：`reproduction|diagnostic|exploratory|ablation`
- `protocol.dataScope`：实际 dataset、split、sample count 和 sampling scope
- `protocol.sources`：paper、README、issues 的状态、引用和 guidance
- `protocol.deviations`：reference、actual、原因、限制和批准状态

Reproduction 缺少 source coverage 时显示 `MISSING`；未批准 deviation 时显示 `NO`。

## Artifact Radar

```text
/artifacts
```

支持 PNG/JPG、SVG、CSV、JSON、HTML、PDF 和 Parquet。PNG/JPG 在终端内联；CSV/Parquet 只展示指定列或有限行。表格分片按父目录聚合为一个 Dataset Artifact。

Checkpoint 不会自动附加本轮所有输出。Curated result 角色支持：

```text
evidence
diagnostic
dataset
intermediate
```

## 安装与运行

```bash
npm install
pi -ne -e .
```

安装 GitHub package：

```bash
pi install git:github.com/CrossStar/pi-research-loop
```

开发验证：

```bash
npm run check
```

仓库：https://github.com/CrossStar/pi-research-loop

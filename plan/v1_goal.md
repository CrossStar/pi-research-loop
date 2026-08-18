# pi-research-loop V1 Goal

## 1. 项目目标

`pi-research-loop` 是一个运行在 Pi Agent 中的 Research Control Extension。第一版不试图重新实现 Agent Harness，也不试图把 Pi 改造成完整的科研平台，而是直接改善科研场景下 Agent 的执行循环。

这个项目需要解决一个核心问题：当前 Coding Agent 更倾向于长时间自治执行，并且经常采用防御性工程策略。对于科研探索而言，这种行为会导致大量时间花在测试、验证、环境处理、重构和其他当前研究问题并不需要的工作上。同时，Agent 往往需要运行很久才重新将控制权交给用户，使得用户无法在研究方向发生偏移时及时进行 calibration。

V1 的目标是把 Pi 从“提交问题后等待最终答案”的执行方式，改变成一种有边界的科研协作循环。

理想循环是：

```text
提出研究问题
→ 快速检查
→ 最小实验或最小修改
→ 得到可观察结果
→ 展示 Artifact
→ Research Checkpoint
→ 交还控制权
→ 用户校准
→ 继续下一轮
```

第一版是否成功，不由代码规模、架构完整度或者测试覆盖率决定，而由这个循环是否明显改善实际使用 Pi 做研究时的体验决定。

------

## 2. 核心设计原则

这个插件首先优化的是 **Time to Insight**，而不是工程完备性。

在研究探索阶段，Agent 应该优先寻找能够最快降低不确定性的操作。例如读取真正相关的几个文件、运行一个小规模 probe、修改一个变量、抽样几十条数据或者生成一张快速图表。

Agent 不应该默认把一个探索问题当作生产软件交付任务。

因此，在 Research Fast Mode 下，Agent 应主动避免与当前研究问题没有直接关系的防御性工程，包括大范围测试、完整测试套件、checksum、完整环境固定、无关重构、过度异常处理、过早抽象、完整 benchmark 和为了潜在未来需求构建基础设施。

这些限制不是绝对禁止验证，而是要求验证的成本与当前结论的重要程度匹配。

在探索阶段，一个能够帮助用户决定下一步的粗略结果通常比一个两小时后才完成的完美结果更有价值。

------

## 3. FAST Policy 必须独立于上下文存在

Research Fast Mode 的行为约束不能只存在于用户最开始发送的一段 Prompt 中，也不能依赖模型在长对话中记住这些要求。

Pi 发生 context compaction、session resume、branch 或其他上下文变化之后，Agent 仍然必须知道自己当前运行在 Research Fast Mode。

因此插件必须维护独立的 Research State，并在每次必要的模型调用阶段重新注入核心 Research Policy。

Research Policy 应始终强调三个目标：

```text
Optimize for time-to-insight.

Avoid unnecessary defensive engineering.

Return control after meaningful evidence.
```

即使历史上下文被压缩，这三个原则也不能因为摘要缺失而消失。

Research Mode 的状态属于插件，而不是 conversation history。

------

## 4. Research Mode

V1 至少提供三种状态：

```text
/research fast
/research normal
/research off
```

`fast` 是本项目最重要的模式。

Fast Mode 下，Agent 应以研究探索速度为第一优先级。它应该寻找不削弱当前科学主张的最小可执行验证，而不是主动提高整个项目的工程质量。对于复现或基准对比，reference protocol 的忠实度高于节省运行成本。

`normal` 模式保留 Research Loop 的 checkpoint、artifact 和执行边界能力，但降低对防御性操作的限制，使 Agent 可以进行更完整的验证。

`off` 表示插件不再主动改变 Pi 的执行策略，使 Pi 尽可能接近原始行为。

V1 不需要设计复杂的配置系统。Research Mode 应该能够通过简单命令切换，并且当前状态能够在 Pi 界面中被清楚看到。

------

## 5. Fast Governor

Fast Governor 是 V1 的核心模块。

它同时通过 Prompt Policy 和 Tool Policy 影响 Agent。

Prompt Policy 负责告诉模型什么样的行为是当前阶段需要的。Agent 应优先采用最小实验、针对性检查、小范围修改和能够快速产生信息的工具调用，但最小化不能改变实验所声称回答的问题。

复现、基准对比和 reference-result 任务必须采用 fidelity-first。数据范围与 split、sampling、preprocessing、model/checkpoint、objective、evaluation protocol、seeds/repeats 和关键超参都属于科学协议。Agent 不得为了节省时间或成本静默改变这些条件。

在启动复现前，Agent 必须进行三源核对：官方 paper（包括 appendix/supplement）、相关 commit/tag 下的官方 repository README，以及相关 open/closed GitHub issues。Issue 搜索应覆盖 dataset、model、command、metric、error 和 reproduction setting 等具体关键词，并优先关注 maintainer 澄清、已知 bug、参数修正与版本兼容信息。

Agent 必须记录 paper citation、README revision 和 issue URL/number，以及每个来源对 protocol 的具体影响。若 paper、README、实际 code behavior 或 maintainer issue guidance 冲突，必须披露冲突及其科学影响；不能静默选取一个版本。若没有找到相关 issue 或无法访问，也应记录搜索结果和限制。

小样本 wiring 或 smoke test 只能作为独立 diagnostic。Agent 必须在执行前披露 reference scope、proposed scope、修改理由和推断限制，并获得用户明确批准；diagnostic 结果不能替代或冒充官方复现结果。

Tool Policy 则负责处理模型没有遵守这一原则的情况。对于明确的复现执行请求，常见的 sample/data-scope reduction 应被拦截，除非用户已经明确授权 diagnostic scope。

例如，在没有明显理由时，Agent 如果准备运行整个 repository 的测试套件，Fast Governor 应阻止这次操作，并要求 Agent 使用更小的 targeted test。

类似地，如果 Agent 主动开始为实验文件计算 SHA256、构建完整 reproducibility manifest、进行 repository-wide formatting 或者启动明显与当前假设无关的大规模验证，插件应该能够阻止或者提醒 Agent重新选择更小的操作。

Tool Gate 不应该简单依赖黑名单。

例如：

```text
pytest tests/test_reward.py::test_normalization
```

可能是合理的。

而：

```text
pytest
```

在 Fast Mode 中通常是不合理的。

判断标准应始终围绕一个问题：

> 这一步是否是当前获得下一条有价值研究信息所必需的？

V1 可以采用简单启发式规则，不需要实现复杂分类器。

------

## 6. Research Activity 与 Soft Review

V1 不再为 Agent 的连续执行设置固定 tool-action 上限。

插件应记录从本轮用户输入开始的 tool action 数量，但这个数字只用于状态可见性和 checkpoint 重新评估，不作为 block 或 terminate 的条件。

例如：

```text
RESEARCH FAST | ACTIONS 6 | CHECKPOINT REVIEW | OUTPUTS 2
```

每完成六个 tool actions，插件应在下一次模型调用中注入一次 Soft Review，要求 Agent 判断是否已经出现有意义 evidence、研究分支、成本升级、不确定性停滞或探索无进展。

如果当前最小实验仍未完成，并且没有上述语义触发条件，Agent 可以继续执行，不需要 checkpoint。

Action counter 没有硬性上限。Checkpoint 的时机由研究语义决定，而不是由固定次数决定。

------

## 7. Research Checkpoint

Research Checkpoint 是人类重新获得控制权的主要机制。

插件必须注册一个 `research_checkpoint` tool，使 Agent 能够明确表示当前一个研究片段已经结束。

Checkpoint 应是一份紧凑的研究报告，而不是固定字段摘要。整体结构为 Checkpoint Title、Research Question、Condition & Result、Overall Analysis、Uncertainty、Next 和 Relevant Artifacts。

`Condition & Result` 按执行顺序包含从上一次 checkpoint（或本轮用户校准开始）到当前 checkpoint 之间完成的所有关键实验。每个实验应分别说明为什么需要它、条件与控制、protocol provenance、观察结果、结构化结果表和局部分析，不应重复更早实验或把计划中的实验写成已完成实验。

每个实验必须声明 `reproduction|diagnostic|exploratory|ablation` intent 和实际 data scope。复现实验还应给出 reference，并通过 `protocol.sources` 记录 paper、README 和 issue 的 `consulted|not-found|inaccessible` 状态、精确引用和 protocol guidance。缺少任一来源类别时，Reference Sources 表应显示 `MISSING`。

实验还必须逐项列出所有 protocol deviations 的 reference value、actual value、原因、推断限制和执行前用户批准状态。Deviation 表必须在终端中醒目展示；没有批准的 diagnostic 不能被总结为 reproduction evidence。

一个典型 checkpoint 应表达：

```text
Checkpoint: Response Length May Bias Safety Reward

Research Question
Reward 变化来自 response length，还是来自语义内容与格式？
当前假设是增加 response length 本身可能提高 reward。

Condition & Result

Experiment 1 - Neutral Response Extension
对 30 组 original/extended responses 进行配对评分。

Response   | Mean Reward | Delta
-----------+-------------+-------
Original   | 0.4123      | -
Extended   | 0.4940      | 0.0817

结果支持 length-associated effect，但尚未隔离 filler semantics。

Experiment 2 - Equal-Length Formatting Control
保持 token count 基本相等，仅改变 formatting。

Response     | Mean Reward | Delta
-------------+-------------+-------
Plain        | 0.4871      | -
Reformatted  | 0.4914      | 0.0043

该结果削弱 formatting 是主要解释的假设。

Overall Analysis
跨实验综合判断 response length 比 formatting 更可能解释 reward 变化。

Uncertainty
新增文本内容仍与 token count 混杂。

Next
使用多个独立 filler family 重复 length sweep。

Relevant Artifacts
- results/reward_length_sweep.json
- figures/reward_length_sweep.png
```

Setup、variables 和 experiment hyperparameters 只在理解 evidence 所必需时显示，并用紧凑表格呈现。Setup 可包括 Model、Dataset、Loss、Optimizer 和 Evaluation protocol。Slurm partition、QoS、节点数、walltime、日志和调度参数不应进入实验细节，除非研究问题本身就是系统性能或调度行为。

每个实验可以提供多张结构化结果表。数值 cell 应按测量精度保留适当有效位数；CSV/Parquet supporting results 在终端中直接显示有界 preview，图片应内联到其关联的实验下。所有 curated artifacts 在报告末尾统一列出。

Checkpoint 必须包含至少一个实际运行的实验。非实验型讨论、规划、代码维护、文档工作和软件验证不应创建 checkpoint；需要用户批准尚未运行的高成本实验时，应通过普通回复交还选择，而不是构造空实验 checkpoint。

Checkpoint 不只是输出一段文本。

调用 checkpoint 后，插件应停止当前连续 Agent loop，并真正把控制权交回用户。

用户可以选择继续，也可以直接修改研究方向。

这意味着 Research Checkpoint 是一个 Harness-level primitive，而不是一句“如果你愿意我可以继续”。

------

## 8. Checkpoint Trigger

V1 不应该简单地按照固定次数机械 checkpoint。

Agent 首先根据用户意图判断当前对话是否要求开展科研实验，并确认至少一个实验已经实际开始运行。只有满足这个资格条件后，才评估 checkpoint trigger。普通对话、问题回答、规划、实现工作以及仅用于验证软件改动的测试不属于科研实验；tool action 数量本身也不能产生 checkpoint 资格。

实验开始后至少需要考虑三种触发条件。

第一种是 Evidence Trigger。当一个新的实验结果明显改变了当前假设，例如产生了一张关键图、一个显著统计结果或者一个出乎预期的观察时，Agent 应自主判断是否 checkpoint，而不是自动扩展实验。

第二种是 Decision Trigger。当后续实验存在两个或多个明显不同的研究方向，或者下一项实验成本明显升高时，应优先把选择交给用户。

第三种是 Stagnation Trigger。当连续实验没有明显降低不确定性，或者当前实验无法区分多个解释时，Agent 应总结当前障碍并 checkpoint。

Tool action 每增加六次时，插件只提醒 Agent：若当前用户请求已经启动科研实验，则重新评估这些条件；否则忽略 checkpoint 语义并继续普通任务。

V1 不需要真正计算复杂的 intervention value。通过 prompt 规则、action counter 和 Soft Review 实现这一行为即可。

------

## 9. Artifact Radar

科研过程中，文件不应该只是 Agent 工作之后遗留在服务器上的副作用。

V1 需要实现轻量的 Artifact Radar。

插件应监控当前研究 workspace 中新产生或者明显更新的科研结果文件，并及时告诉用户。

第一版重点支持：

```text
PNG
JPG
SVG
CSV
JSON
HTML
PDF
Parquet
```

Artifact Radar 不需要建立数据库，不需要对象存储，不需要 checksum，也不需要完整 provenance system。

它首先只解决一个问题：

> Agent 刚刚产生了什么值得我看的东西？

发现 artifact 后，应记录当前 session 中的简单 artifact 列表，并更新 Pi 界面中的 artifact 数量。

用户不应该再必须打开 VSCode、SSH 到远程服务器然后自己寻找 `outputs/result_23.png`。

------

## 10. Artifact Preview

对于终端能够直接展示的文件，应尽可能在 Pi 中提供即时 preview。

PNG、JPG 等图片是 V1 最重要的 preview 类型。

如果当前 terminal 支持 Pi 的 inline image 能力，则 Artifact Radar 应能够直接在终端中显示图片。

如果环境不支持图片显示，则至少应该清楚展示 artifact 的文件名、路径、大小和类型。

CSV 第一版只需要显示少量行和基础 shape。

JSON 可以显示顶层结构或有限内容。

Parquet 可以只显示 row count、column count 和简单 schema。

PDF 第一版只需要识别文件并暴露路径，不需要实现 PDF reader。

Artifact Preview 的原则与整个项目相同：

> 尽快让用户看到足够判断下一步的信息，而不是构建完整文件浏览器。

------

## 11. `/artifacts`

V1 提供简单的：

```text
/artifacts
```

命令。

它展示当前 Research Session 中发现的 artifact。

例如：

```text
1. reward_vs_length.png
2. probe_results.csv
3. normalized_reward.png
4. run_config.json
```

用户可以快速选择一个 artifact 查看支持的 preview 或得到清晰路径。

Artifact 列表只服务于当前 session 即可。

V1 不需要实现跨项目 Artifact Registry。

------

## 12. 状态可见性

Research Loop 当前是否启用必须始终容易判断。

Research 状态应通过 `belowEditor` widget 在编辑器下方独占一行，不与 Pi 内置 footer 或其他 extension status 混排。状态行应使用清晰的语义标签，例如：

```text
RESEARCH FAST | ACTIONS 12 | OUTPUTS 2
RESEARCH FAST | ACTIONS 12 | CHECKPOINT REVIEW | OUTPUTS 2
RESEARCH FAST | CHECKPOINT REACHED | RESULTS 2
RESEARCH OFF
```

其中：

`RESEARCH FAST` 表示当前 Research Mode。

`ACTIONS 12` 表示本轮已执行十二个 tool actions，不表示预算或上限。

`OUTPUTS 2` 表示当前 session 索引了两个逻辑输出，但不代表它们已经成为 evidence。

`CHECKPOINT REVIEW` 表示 Agent 应重新判断语义触发条件，但可以继续当前未完成的最小实验。

`RESULTS 2` 表示 checkpoint 中包含两个已经解释和策展的研究结果。

状态信息应该保持简短且语义明确，不应占据大量终端空间。

用户不需要打开配置文件才能知道当前插件正在以什么方式控制 Agent。

------

## 13. V1 不解决的问题

第一版明确不做完整 Research Operating System。

不做独立 Web UI。

不做 PostgreSQL。

不做用户系统。

不做云端服务。

不做 VS Code Extension。

不做多 Agent orchestration。

不做 Research DAG。

不做完整 Evidence Graph。

不做 Claim Ledger。

不做复杂 Artifact Registry。

不做 S3 或 MinIO。

不做完整 reproducibility framework。

不做自动论文生成。

不做完整实验管理平台。

不做 Kubernetes。

也暂时不做复杂的异步 GPU Job Scheduler。

这些能力未来是否值得实现，应由 V1 的真实使用结果决定。

------

## 14. 长任务的 V1 边界

V1 仍然允许 Pi 执行普通 Bash 命令。

但是 Fast Governor 应尽量避免 Agent 在没有必要的情况下主动启动超长任务。

当检测到明显可能长时间阻塞的操作时，可以提醒 Agent先进行更小规模 probe。

真正的：

```text
submit_job
get_job
cancel_job
tail_job
```

异步任务系统属于后续版本。

只有在 Research Loop 本身证明有明显价值之后，再继续解决数小时训练任务的异步生命周期问题。

------

## 15. 实现原则

V1 本身也必须按照 Research Fast Mode 的理念开发。

不要为这个插件建立复杂架构。

不要编写大规模测试套件。

不要建立完整 plugin framework。

不要为潜在未来需求设计大量 abstraction。

不要添加没有直接支持 V1 Golden Demo 的基础设施。

优先把插件作为少量 TypeScript 文件直接运行起来。

允许实现粗糙。

允许启发式规则存在。

允许部分文件类型 preview 不完善。

允许 UI 不漂亮。

不允许为了理论上的工程质量拖延第一个真实可用版本。

实现顺序应该始终是：

```text
Make it work.
Make it visible.
Use it yourself.
Find what hurts.
Improve that.
```

------

## 16. V1 完成定义

V1 是否完成由一个 Golden Demo 决定。

启动 Pi 后：

```text
/research fast
```

然后输入一个真实科研任务，例如：

```text
分析这个 repository 中 reward hacking
可能来自哪里，并通过一个最小实验验证你的第一个假设。
```

理想情况下，Pi 应该：

快速检查真正相关的代码，而不是系统性扫描整个 repository。

形成一个可以被实验验证的初始假设。

进行最小代码修改或创建最小 probe。

运行这个 probe，而不是马上构建完整实验 pipeline。

如果产生图表或数据文件，Artifact Radar 应立即发现。

如果环境支持图片，用户应直接看到关键图片。

得到第一条有意义 evidence 后，Agent 应形成 Research Checkpoint。

Checkpoint 应说明当前假设、观察、不确定性和下一步。

随后 Agent 应停止自动继续工作，把输入控制权交还给用户。

整个过程中，如果 Agent试图进行明显无关的大规模测试、checksum 或其他防御性工程，Fast Governor 应能够阻止这种行为。

Context 被压缩或者 session 恢复以后，Research Fast Policy 仍然必须生效。

如果这个 Golden Demo 的实际体验明显优于没有插件的原始 Pi，那么 V1 成功。

------

## 17. 最终原则

`pi-research-loop` V1 的目标不是让 Agent 一次性完成更多事情。

目标恰恰相反。

它应该让 Agent：

**少做一点。**

**更快做出有信息量的东西。**

**更早让用户看到。**

**更频繁地允许用户改变方向。**

最终我们希望得到的不是一个更自治的 Agent，而是一个：

> **更适合科研过程中高频人机校准的 Agent execution loop。**
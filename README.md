# pi-research-loop

面向科研探索的 Pi Research Control Extension。V1 优先缩短 time-to-insight，并在得到有意义 evidence 后尽早把控制权交还给用户。

## 运行

在本仓库中直接试用：

```bash
npm install
pi -e ./src/index.ts
```

也可以把本地 package 安装到 Pi：

```bash
pi install ./
```

## 命令

```text
/research fast
/research normal
/research off
/artifacts
```

默认状态是 `off`。Research 状态使用编辑器下方的独立一行显示，不与 Pi 内置 footer 或其他 extension status 混排：

```text
RESEARCH FAST | ACTIONS 3 | OUTPUTS 2
```

插件不再设置固定 action 上限。每完成 6 个 tool actions，状态栏暂时显示 `CHECKPOINT REVIEW`，并要求 Agent 根据 evidence、研究分支、成本、停滞和不确定性判断是否需要 checkpoint；当前最小实验尚未完成时可以直接继续。

```text
RESEARCH FAST | ACTIONS 6 | CHECKPOINT REVIEW | OUTPUTS 2
RESEARCH FAST | CHECKPOINT REACHED | RESULTS 2
RESEARCH OFF
```

Fast Mode 会阻止高置信度的全仓测试、全仓格式化、checksum/reproducibility bookkeeping 和明显无关的长任务入口，同时要求 Agent 优先做不削弱科学主张的最小实验。它不允许为了节省成本而静默改变复现协议。

`research_checkpoint` 是 terminating tool。它输出一份研究报告，而不是固定字段摘要：Checkpoint Title、Research Question、Condition & Result、Overall Analysis、Uncertainty、Next 和 Relevant Artifacts。

启用 Research Mode 不等于每项任务都需要 checkpoint。Agent 必须先判断当前用户请求是否让它实际开展了科研实验；只有至少一个实验已经运行后，Agent 才根据 evidence、decision branch、uncertainty、stagnation 和下一实验成本自主判断是否 checkpoint。普通对话、问题回答、规划、代码维护、文档修改和用于验证软件改动的测试都不具备 checkpoint 资格。尚未运行实验时若需要成本批准，应使用普通回复询问用户。

复现、基准对比和 reference-result 任务采用 fidelity-first：reference 的数据范围与 split、采样、预处理、模型/checkpoint、objective、评估协议、seeds/repeats 和关键超参都是科学协议的一部分。Agent 不得静默缩小或更改这些条件。小样本 wiring/smoke test 必须作为独立的 `diagnostic` 实验，运行前披露 reference 与 proposed scope、用途和推断限制并获得用户明确批准，结果也不能当作官方复现 evidence。

启动复现前，Agent 必须进行三源核对：阅读官方 paper（包括 appendix/supplement）、相关 commit/tag 下的官方 repository README，并搜索相关 open/closed GitHub issues，优先关注 maintainer 澄清、已知 bug、参数修正和版本兼容信息。必须记录精确 citation、revision 和 issue URL/number。若三者或实际 code behavior 冲突，Agent 应披露冲突及其科学影响，不能静默选择；若没有找到相关 issue 或无法访问，也必须记录搜索结果和限制。

`experiments` 是必填字段，按执行顺序记录从上一次 checkpoint（或本轮用户校准开始）到当前 checkpoint 之间完成的所有关键实验。每个实验拥有独立的动机、设计、protocol provenance、结构化细节、结果表和局部分析；`overallAnalysis` 再综合各实验对假设的共同影响。

```json
{
  "title": "Response Length May Bias Safety Reward",
  "researchQuestion": "reward 变化来自 response length，还是语义和格式？",
  "hypothesis": "增加 response length 本身可能提高 reward",
  "experiments": [
    {
      "title": "Neutral Response Extension",
      "protocol": {
        "intent": "exploratory",
        "dataScope": "30 paired responses from the fixed evaluation split",
        "sources": [
          {
            "kind": "paper",
            "status": "consulted",
            "reference": "Paper section 4.2",
            "summary": "Defines the evaluation claim and metric"
          },
          {
            "kind": "readme",
            "status": "consulted",
            "reference": "github.com/org/repo@v1.2/README.md",
            "summary": "Defines the released evaluation command"
          },
          {
            "kind": "issue",
            "status": "not-found",
            "summary": "Searched open and closed issues for evaluator and metric terms"
          }
        ],
        "deviations": []
      },
      "rationale": "检验初始 length association",
      "design": "对 30 组 original/extended response 进行配对评分",
      "setup": [
        { "name": "Evaluator", "value": "safety-rm-v2" }
      ],
      "parameters": [
        { "name": "temperature", "value": "0" }
      ],
      "observation": "23 组上升，5 组下降，2 组基本不变",
      "tables": [
        {
          "columns": ["Response", "Mean Reward", "Mean Delta"],
          "rows": [
            [{ "text": "Original" }, { "value": 0.4123, "significantDigits": 4 }, { "text": "-" }],
            [{ "text": "Extended" }, { "value": 0.494, "significantDigits": 4 }, { "value": 0.0817, "significantDigits": 4 }]
          ]
        }
      ],
      "analysis": "结果支持 length-associated effect，但还没有隔离 filler semantics"
    }
  ],
  "overallAnalysis": "跨实验综合判断 response length 比 formatting 更可能解释 reward 变化",
  "conclusion": "当前最强结论，但不超出已有控制条件",
  "uncertainty": "新增文本内容仍与 token count 混杂",
  "next": "使用多个独立 filler family 重复 length sweep"
}
```

每个实验的 `protocol` 必填：`intent` 为 `reproduction|diagnostic|exploratory|ablation`，`dataScope` 必须写实际 dataset、split、sample count 和 sampling scope；复现任务还应填写 `reference`。`sources` 记录 `paper|readme|issue`、`consulted|not-found|inaccessible` 状态、精确引用和与协议相关的结论。Reproduction 缺少任一来源类别时，终端的 Reference Sources 表会显示 `MISSING`。所有 protocol deviation 都必须结构化记录 reference、actual、原因、推断限制和是否在执行前获得用户批准，并在终端中以醒目的 Protocol Deviations 表展示。

`setup`、`variables` 和 `parameters` 是可选的结构化实验细节。Setup 用于 Model、Dataset、Loss、Optimizer、Evaluation protocol 等理解 evidence 所需的信息；`parameters` 只记录实验超参。Slurm partition、QoS、节点数、walltime、日志和调度参数不会展示，除非研究问题本身就是系统性能或调度行为。

`tables` 支持每个实验最多 4 张、每张最多 6 列和 20 行的任意结果表。数值 cell 使用 `value`，并可通过 `significantDigits` 保留有意义的精度和尾零；非数值 cell 使用 `text`。CSV/Parquet artifact 仍提供有界 terminal preview。

Checkpoint 不会自动附加刚生成的文件。Agent 只能通过结构化 `results` 提交自己能够解释的 supporting results：

```json
{
  "path": "outputs/probe_samples/",
  "title": "Reward probe 样本",
  "role": "dataset",
  "description": "本轮最小实验生成的逐样本数据",
  "takeaway": "用于检查 reward 与 response length 的关系",
  "columns": ["reward", "response_length", "prompt_id"],
  "experiment": "Controlled Length Sweep"
}
```

`role` 支持 `evidence`、`diagnostic`、`dataset` 和 `intermediate`。前三种提供有界 preview；`intermediate` 只显示语义说明和文件链接。

Checkpoint 中的结果会显示可点击的本地文件链接。PNG/JPG 会在支持 inline image 的终端中直接显示。CSV 默认显示前 6 列和前 5 行；提供 `columns` 后优先显示指定列。Parquet 在环境已安装 `pyarrow` 时采用相同策略，否则保留 Dataset Card 和路径。

Artifact Radar 只负责发现和索引，不再自动把未知文件以内联结果展示。命名为 `part-*`、`shard-*`、`chunk-*` 或 `*-00000-of-*` 的 CSV/Parquet 会按父目录聚合为一个 dataset。显式提交数据集目录时，插件最多扫描 500 个目录项和 200 个数据文件，用样本分片生成 Dataset Card，不遍历整个数据集。

`/artifacts` 用于查看当前 session 尚未策展的 artifact 索引和按需 preview。

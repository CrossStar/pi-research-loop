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

Fast Mode 会阻止高置信度的全仓测试、全仓格式化、checksum/reproducibility bookkeeping 和明显的长任务入口，同时要求 Agent 优先做最小实验。

`research_checkpoint` 是 terminating tool。`experiment` 只描述从上一次 checkpoint（或本轮用户校准开始）到当前 checkpoint 之间完成的关键实验，不回顾更早实验，也不描述尚未运行的下一步实验。实验型 checkpoint 按以下顺序展示：Hypothesis、Why This Experiment、Experimental Design、Experimental Setup、Key Variables、Experiment Hyperparameters、Main Result、Headline Metrics、Analysis、Uncertainty 和 Next。非实验型 decision/stagnation checkpoint 可以省略 `experiment`。

```json
{
  "hypothesis": "通用安全声明会提高 evaluator score",
  "experiment": {
    "rationale": "检验 evaluator 是否奖励表面安全措辞",
    "design": "对相同回答进行有无安全声明的配对比较",
    "setup": [
      {
        "name": "Evaluator",
        "value": "safety-rm-v2",
        "description": "被测试的安全评分模型"
      },
      {
        "name": "Evaluation protocol",
        "value": "paired scoring",
        "description": "对同一回答主体进行配对比较"
      }
    ],
    "variables": [
      {
        "name": "disclaimer",
        "role": "independent",
        "description": "是否添加安全声明",
        "value": "absent vs present"
      },
      {
        "name": "score_delta",
        "role": "dependent",
        "description": "配对评分变化"
      }
    ],
    "parameters": [
      {
        "name": "sample_size",
        "value": "30",
        "rationale": "用于第一轮小规模 probe"
      }
    ]
  },
  "observation": "添加安全声明后，多数样本的评分上升",
  "metrics": [
    {
      "name": "mean_score_delta",
      "value": 0.081734,
      "baseline": 0,
      "significantDigits": 3,
      "note": "paired mean"
    }
  ],
  "analysis": "结果支持 evaluator 对表面安全措辞敏感，但尚未排除长度效应",
  "uncertainty": "尚未运行等长度中性前缀对照",
  "next": "运行中性前缀对照实验"
}
```

`setup` 用于 Model、Dataset、Loss、Optimizer、Evaluation protocol 等理解实验所需的关键细节。`variables` 的 role 支持 `independent`、`dependent`、`control` 和 `derived`。`parameters` 只记录实验超参；Slurm partition、QoS、节点数、walltime、日志和调度参数不会展示，除非研究问题本身就是系统性能或调度行为。`metrics` 以终端表格展示，并按 `significantDigits` 控制有效位数。

Checkpoint 不会自动附加刚生成的文件。Agent 只能通过结构化 `results` 提交自己能够解释的 supporting results：

```json
{
  "path": "outputs/probe_samples/",
  "title": "Reward probe 样本",
  "role": "dataset",
  "description": "本轮最小实验生成的逐样本数据",
  "takeaway": "用于检查 reward 与 response length 的关系",
  "columns": ["reward", "response_length", "prompt_id"]
}
```

`role` 支持 `evidence`、`diagnostic`、`dataset` 和 `intermediate`。前三种提供有界 preview；`intermediate` 只显示语义说明和文件链接。

Checkpoint 中的结果会显示可点击的本地文件链接。PNG/JPG 会在支持 inline image 的终端中直接显示。CSV 默认显示前 6 列和前 5 行；提供 `columns` 后优先显示指定列。Parquet 在环境已安装 `pyarrow` 时采用相同策略，否则保留 Dataset Card 和路径。

Artifact Radar 只负责发现和索引，不再自动把未知文件以内联结果展示。命名为 `part-*`、`shard-*`、`chunk-*` 或 `*-00000-of-*` 的 CSV/Parquet 会按父目录聚合为一个 dataset。显式提交数据集目录时，插件最多扫描 500 个目录项和 200 个数据文件，用样本分片生成 Dataset Card，不遍历整个数据集。

`/artifacts` 用于查看当前 session 尚未策展的 artifact 索引和按需 preview。

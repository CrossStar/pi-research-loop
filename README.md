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

默认状态是 `off`。启用后状态栏显示类似：

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

`research_checkpoint` 是 terminating tool。Agent 调用后会展示 hypothesis、observation、uncertainty 和 next，并结束当前连续执行循环。

Checkpoint 不会自动附加刚生成的文件。Agent 只能通过结构化 `results` 提交自己能够解释的结果：

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

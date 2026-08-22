# Pi Experiment Code Contract

该规范只约束 Pi Research Loop 在 Experiment Mode 中新建或修改的实验代码。目标是缩短真实研究
循环：研究者能够快速理解流程、修改参数、运行实验、观察进度、判断异常、找到结果并进入下一轮。

```text
可读 · 可运行 · 可观察 · 可修改 · 可检查 · 不过度工程化
```

## 顶层流程

入口应直接映射自然语言实验设计。研究者阅读 `main()` 时，应能看见数据加载、表示提取、条件
构造、seed 循环、分析和保存等主要阶段：

```python
def main():
    config = parse_args()
    print_experiment_overview(config)

    data = load_datasets(config)
    activations = extract_activations(config, data)
    normal_results = run_normal_condition(config, activations)
    null_results = run_null_condition(config, activations)
    summary = analyze_results(normal_results, null_results)

    save_results(config, summary)
    print_final_summary(summary)
```

函数对应自然实验动作或清晰职责。自然完整的几十行步骤可以保留在一起；不要制造两三行 wrapper
链，也不要把整个实验塞进一个数千行函数。

## 终端可观察性

Python 实验脚本使用 Rich 展示：

- 启动时的配置摘要；
- 大 phase 的开始和完成；
- 能够判断科学异常的中间检查；
- condition、dataset 和 metric 结果表；
- 最终结论摘要；
- 每类结果文件的准确路径。

Rich 负责信息层级，不负责装饰。不要输出每个函数、batch、样本、tensor shape 或重复内部状态。
`rich` 和 `tqdm` 应登记在项目现有的依赖入口中，不要再实现一套 fallback 终端 UI。

阶段内部真正耗时的重复工作使用 `tqdm`，包括数据集处理、批量推理、activation 提取、layer
扫描、seed sweep 和大规模评估。毫秒级循环不添加进度条，避免多层嵌套进度条。

关键 phase 结束后只显示有研究判断价值的检查，例如：

```text
✓ Dataset loaded
  Train samples: 4,812
  Test samples: 1,204

✓ Activations extracted
  Shape: [4812, 48, 3840]

✓ Strict-null labels generated
  Positive: 2406
  Negative: 2406
  Truth correlation: 0.000
```

## 参数与运行入口

模型、数据集、layers、seeds、batch size、split、threshold、重复次数和输出目录集中在一个明显的
config 或 CLI surface。实验代码中不散落具有研究含义的 magic numbers。

常规入口保持简单：

```bash
python experiment.py
python experiment.py --model ... --seeds 50
python experiment.py --help
```

长实验提供 `--quick` 或 `--smoke`，用最小范围跑通整个 pipeline。终端必须展示被缩减的参数。
复现任务的快速运行属于 diagnostic；只有用户明确批准后，才能把缩减设置登记为 protocol deviation。

## 随机性与隐藏行为

代码和启动摘要应明确每个 seed 控制的对象，例如 train split、pseudo labels、初始化或 sampling。
普通函数不得静默修改全局配置、seed、device、模型、环境变量、输出目录或实验条件。禁止 silent
fallback。

## 命名与注释

名称表达研究含义，例如：

```python
pseudo_label_seed
truth_correlation
primary_layer
test_truth_auc
direction_norm
```

注释解释研究选择的原因：为什么固定训练子集、为什么使用某个指标、为什么选择某层、为什么实现
偏离论文。不要逐行翻译 Python 语法。

## 克制的代码组织

模型加载、数据处理、实验条件、统计分析和绘图形成真实独立职责时可以拆分。一次探索性实验不引入：

```text
AbstractExperiment
BaseExperimentRunner
ExperimentFactory
ExperimentRegistry
ExperimentStrategy
ExperimentContext
```

只有多个真实实验反复需要同一模式时才抽象。避免为了函数短小制造 `prepare_impl()`、
`prepare_inner()` 等调用链。

研究脚本不需要生产服务式防御层。避免广泛 `try/except`、retry、compatibility shim、silent
recovery、重复 existence check 和 defensive wrapper。会浪费长时间计算或产生误导结果的问题应在
运行前失败，并给出具体、可操作的信息：缺少哪个文件、期望哪个 revision、哪个参数冲突。

## 结果与 artifacts

输出目录稳定且可预测：

```text
results/
└── seed_bimodality/
    └── run-20260821-2314/
        ├── summary.json
        ├── per_seed.csv
        ├── per_layer.csv
        └── figures/
```

科研 artifact，如 CSV、JSON、PNG、checkpoint、prediction 和 activation，保存一次并保留原始位置。
终端展示不产生额外文件，Checkpoint 不复制已有 artifact。

实验结束时使用简洁 Rich table 汇总主要 condition 和 metric，并列出准确路径：

```text
Results saved to:
  summary   results/.../summary.json
  per-seed  results/.../per_seed.csv
  figures   results/.../figures/
```

研究者不需要在运行结束后猜测结果位置。

## 实现判断

每个实现选择都服务于以下循环：

```text
阅读设计 → 修改参数 → 运行 → 观察 phase/progress → 检查异常
→ 查看关键结果 → 找到 artifacts → 下一轮实验
```

根据具体实验选择最简单、最自然、最容易理解的实现。该规范不会被实现成新的实验框架。

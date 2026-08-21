# Pi Checkpoint Writer 与 Viewer

Pi adapter 将实验执行、研究记录和浏览器展示分成三层：

```text
Experiment Runner
  └─ PNG / CSV / JSON / model output / logs
          ↓
Checkpoint Writer
  └─ checkpoints/<id>/checkpoint.md
          ↓
Checkpoint Viewer
  └─ plugin-owned HTML / CSS / JS
          ↓
Browser
```

Experiment Runner 决定真实结果是什么；Checkpoint Writer 决定本次实验最重要的信息如何表达；
Viewer 只决定这些内容如何阅读。Writer 不生成 HTML，Viewer 不修改科研结论。

> 当前持久化 Writer 与 Viewer 只在 Pi adapter 启用。Claude MCP 保持原有 checkpoint report。

## 存储与发现

默认目录：

```text
checkpoints/
├── checkpoint-20260821-234100-example/
│   └── checkpoint.md
└── checkpoint-20260822-001500-example/
    └── checkpoint.md
```

可通过 `RESEARCH_LOOP_CHECKPOINT_DIR` 改为项目内的其他目录。该配置不能指向项目根目录之外。

每份新文档以 JSON-compatible frontmatter 开头：

```markdown
---
{"schema_version":1,"id":"checkpoint-...","title":"...","created_at":"...","experiment_id":"...","short_conclusion":"...","artifact_paths":["results/summary.json"]}
---
```

Viewer 不依赖 manifest 或数据库，而是扫描 checkpoint 目录。对没有 frontmatter 的旧 Markdown：

- title 从一级标题推断；
- created_at 使用文件修改时间；
- short_conclusion 尝试从“结论与下一步”章节的第一个段落推断；
- id 使用目录名或文件名。

## Writer 接口

Pi `research_checkpoint` 使用混合接口：

- `purposeMarkdown`：研究目的正文；
- `setupMarkdown`：实验设置正文；
- `resultsMarkdown`：结果与分析正文；
- `conclusionMarkdown`：结论与下一步正文；
- `protocols`：intent、reference、data scope、sources、deviations；
- `reproduction`：模型、数据、commit、seeds、参数和环境；
- `artifacts`：真实实验文件及其语义。

插件负责 frontmatter、固定标题、复现信息、Protocol 审计和 artifact 文件列表。Agent 只负责连续
科研叙述，不需要知道 Viewer 的 HTML 结构。

生成的正文固定为：

```markdown
# Checkpoint：{一句话概括实验及最重要现象}

## 1. 研究目的

{前置现象、问题、解释 A/B、核心假设及双方预期}

---

## 2. 实验设置

{系统、任务、条件差异、方法、必要参数、指标和预先判断标准}

---

## 3. 结果与分析

{核心发现；图表；图表含义；结果解释；局部结论；必要的第二张图或精确表格}

---

## 4. 结论与下一步

{最终结论、关键证据、不能证明的内容、保守表述和下一实验}

---

## 复现信息

{结构化 reproduction、files 和 protocol audit}
```

## 写作约束

- 正文优先使用自然中文；必要术语首次写为“中文（English term）”。
- 结果与分析应是全文主体。
- 每张重要图表必须出现在对应分析位置，并解释读者应该观察什么及其研究含义。
- 每个图表形成独立的“图（表）→ 正式标题 → 解析”单元；解析后使用独立的 `---` 浅色分隔线，再进入下一个图表。
- 标题遵循“上表下图”：表题位于表格上方，图题位于图片或动态图表下方。
- 不逐项复述图表全部数字，只解释决定判断的差异。
- Checkpoint 全文禁止使用“不是……而是……”“并非……而是……”“不在于……而在于……”“而不是”和“而非”等转折句式，直接陈述观察与结论。
- 实验设置只保留理解结果所需的信息。
- 完整版本、commit、seeds、路径和 protocol audit 统一放在复现信息中。
- `shortConclusion` 显示在 Viewer 第一屏，必须采用最保守且可由证据支持的表述。

## Artifact 引用

Artifact 保留在实验原始位置，例如：

```text
results/main_figure.png
results/summary.json
results/per_seed.csv
```

Agent 在 `resultsMarkdown` 使用项目相对路径。图题写入 Markdown image caption，由 Viewer
显示在图片下方：

```markdown
![图 1　实验组和对照组的主要差异](results/main_figure.png "图 1　实验组和对照组的主要差异")

图 1 显示两个条件的差异方向在所有种子上一致，这一结果支持稳定效应解释。

---
```

表题位于表格上方，解析和分隔线位于表格下方：

```markdown
### 表 1　逐种子准确率

| 条件 | 种子数量 | 准确率 |
| --- | ---: | ---: |
| 实验组 | 2 | 0.91 |
| 对照组 | 2 | 0.82 |

表 1 显示实验组的汇总准确率领先 0.09，这一差异与逐种子结果保持一致。

---
```

落盘时 Writer 将目标改写成相对于 `checkpoint.md` 的标准 Markdown 路径。Viewer 再把这个路径
安全映射到 `/artifacts/`。文件不会复制、转 base64 或写入 HTML。

标记为 `evidence` 的图片必须通过 Markdown image syntax 直接嵌入 `resultsMarkdown`；仅登记在
artifact 列表中会被 validation 拒绝。

JSON 和 CSV 使用普通 Markdown link。Viewer 在链接旁提供可展开 preview：

- JSON：Tree、按键名搜索、Raw 搜索和大数组分组；
- CSV：表头和前 100 行预览；
- 原文件链接仍然可直接访问。

## 结构化展示图表

纯展示型图表不需要落盘。使用 JSON `checkpoint-chart` block：

````markdown
```checkpoint-chart
{
  "type": "bar",
  "title": "图 2　出现两端分化的实验数量",
  "items": [
    { "label": "正常监督", "value": 0 },
    { "label": "严格零相关监督", "value": 53 }
  ]
}
```

图 2 显示严格零相关监督条件下出现了集中分化，这一结果提示该监督条件改变了系统行为。

---
````

Line chart 格式：

````markdown
```checkpoint-chart
{
  "type": "line",
  "title": "图 3　逐层准确率",
  "series": [
    {
      "name": "实验组",
      "points": [{ "x": 1, "y": 0.71 }, { "x": 2, "y": 0.82 }]
    }
  ]
}
```

图 3 显示实验组准确率随层数持续上升，这一趋势支持累积改善解释。

---
````

Viewer 使用内联 SVG 动态绘制，并把正式图题放在图下方；Markdown 只保存结构化数值。

公式可使用 `$...$`、`$$...$$`、`\(...\)` 或 `\[...\]`。Renderer 会先区分公式与普通金额，
因此 `$5 and $10` 会保留为货币文本，不会被 MathJax 误处理。代码块和行内代码也不会进入公式渲染。

## Viewer Server

Viewer 默认绑定 `127.0.0.1`，从 `43119` 开始寻找空闲端口：

```text
/                   checkpoint history
/latest             latest checkpoint
/checkpoints/{id}   one checkpoint
/api/checkpoints    discovered metadata
/api/latest         rendered latest checkpoint payload
/artifacts/{path}   original project artifact
```

`/latest` 不随新实验变化。每次刷新都会读取当前最新 checkpoint。

远程使用：

```bash
ssh -N -o RemoteCommand=none -o RequestTTY=no -L 43119:127.0.0.1:43119 moon
```

然后在本地访问：

```text
http://127.0.0.1:43119/latest
```

Server 只允许提供项目根目录内的 artifact；路径检查会解析符号链接，避免项目内 symlink 指向
项目外文件。原文件使用流式响应，并附加禁用主动内容的安全策略。Viewer 随 Pi session 关闭，
但 `checkpoint.md` 和真实 artifacts 保持不变。

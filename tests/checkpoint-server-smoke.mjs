import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";

const bundle = await build({
  stdin: {
    contents: 'export * from "./src/checkpoint-server.ts"; export * from "./src/checkpoint-store.ts";',
    resolveDir: process.cwd(),
    sourcefile: "checkpoint-viewer-test-entry.ts",
    loader: "ts",
  },
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  write: false,
});
const source = bundle.outputFiles[0]?.text;
assert.ok(source, "checkpoint viewer bundle was not generated");
const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const {
  CheckpointStore,
  CheckpointViewerServer,
  formatSshPortForwardCommand,
  parseCheckpointMarkdown,
  validateCheckpointDraft,
} = await import(moduleUrl);

assert.equal(
  formatSshPortForwardCommand("http://127.0.0.1:43119/latest", "moon"),
  "ssh -N -o RemoteCommand=none -o RequestTTY=no -L 43119:127.0.0.1:43119 moon",
);

const project = await mkdtemp(join(tmpdir(), "research-loop-checkpoint-viewer-"));
const outside = await mkdtemp(join(tmpdir(), "research-loop-checkpoint-outside-"));
const results = join(project, "results");
await mkdir(results, { recursive: true });
const pngPath = join(results, "figure.png");
const jsonPath = join(results, "summary.json");
const csvPath = join(results, "per_seed.csv");
await writeFile(pngPath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
await writeFile(jsonPath, JSON.stringify({ aggregate: { accuracy: 0.91 }, seeds: [7, 42] }, null, 2));
await writeFile(csvPath, "seed,accuracy\n7,0.90\n42,0.92\n", "utf8");
await writeFile(join(outside, "secret.json"), JSON.stringify({ secret: true }), "utf8");
await symlink(outside, join(project, "escape"), process.platform === "win32" ? "junction" : "dir");
await mkdir(join(project, "checkpoints"), { recursive: true });
await writeFile(
  join(project, "checkpoints", "legacy.md"),
  "# Checkpoint：旧格式记录\n\n## 4. 结论与下一步\n\n旧记录也应被 Viewer 发现。\n",
  "utf8",
);
await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));

const artifact = (path, name, extension, size) => ({
  kind: "file",
  path,
  name,
  extension,
  size,
  mtimeMs: Date.now(),
  discoveredAt: Date.now(),
});
const artifacts = [
  {
    path: "results/figure.png",
    title: "主要结果图",
    role: "evidence",
    description: "展示实验组与对照组差异。",
    artifact: artifact("results/figure.png", "figure.png", ".png", 68),
    absolutePath: pngPath,
  },
  {
    path: "results/summary.json",
    title: "汇总指标",
    role: "diagnostic",
    description: "保存聚合指标。",
    artifact: artifact("results/summary.json", "summary.json", ".json", 80),
    absolutePath: jsonPath,
  },
  {
    path: "results/per_seed.csv",
    title: "逐种子结果",
    role: "dataset",
    description: "保存逐种子精确数值。",
    artifact: artifact("results/per_seed.csv", "per_seed.csv", ".csv", 32),
    absolutePath: csvPath,
  },
];
const draft = {
  title: "实验组在主要指标上稳定优于对照组",
  experimentId: "viewer-smoke-001",
  shortConclusion: "两个随机种子都显示同方向差异。",
  purposeMarkdown: "此前观察到实验组可能优于对照组；运行成本介于 $5 and $10。本次希望判断该差异是稳定效应，还是单一种子波动。\n\n<script>unsafe()</script>",
  setupMarkdown: "本实验比较实验组和对照组，使用两个随机种子，并以准确率作为主要指标。",
  resultsMarkdown: [
    "本实验最重要的结果是：**两个随机种子都显示实验组更高。**",
    "",
    "![图 1　两个条件的准确率差异](results/figure.png \"图 1　两个条件的准确率差异\")",
    "",
    "图 1 显示两个随机种子的差异方向一致，支持稳定效应解释。汇总关系写为 $a+b=c$，代码字面量 `$not_math$` 保持原样。",
    "",
    "---",
    "",
    "[查看汇总 JSON](results/summary.json)",
    "",
    "[查看逐种子 CSV](results/per_seed.csv)",
    "",
    "### 表 1　逐种子准确率",
    "",
    "| 条件 | 种子数量 | 准确率 |",
    "| --- | ---: | ---: |",
    "| 实验组 | 2 | 0.91 |",
    "| 对照组 | 2 | 0.82 |",
    "",
    "表 1 显示实验组在汇总准确率上领先 0.09，这一结果说明总体差异与逐种子观察保持一致。",
    "",
    "---",
    "",
    "```checkpoint-chart",
    JSON.stringify({ type: "bar", title: "图 2　平均准确率比较", items: [{ label: "实验组", value: 0.91 }, { label: "对照组", value: 0.82 }] }),
    "```",
    "",
    "图 2 显示实验组柱高超过对照组，意味着当前数据范围内存在稳定的正向差异。",
    "",
    "---",
  ].join("\n"),
  conclusionMarkdown: "本实验支持实验组稳定优于对照组，但还不能证明具体机制。下一步应进行消融实验。",
  protocols: [{ title: "viewer smoke", intent: "diagnostic", dataScope: "two synthetic seeds", sources: [], deviations: [] }],
  reproduction: {
    model: "test-model",
    modelRevision: "r1",
    dataset: "synthetic",
    dataRevision: "v1",
    codeCommit: "abc1234",
    seeds: ["7", "42"],
    parameters: [{ name: "samples", value: "100" }],
    environment: "CPU smoke test",
  },
};
assert.deepEqual(validateCheckpointDraft(draft, artifacts).errors, []);
const detachedFigure = structuredClone(draft);
detachedFigure.resultsMarkdown = detachedFigure.resultsMarkdown.replace("![图 1　两个条件的准确率差异]", "[图 1　两个条件的准确率差异]");
assert.match(validateCheckpointDraft(detachedFigure, artifacts).errors.join("\n"), /必须直接引用/);
const invalidChart = structuredClone(draft);
invalidChart.resultsMarkdown = invalidChart.resultsMarkdown.replace('"type":"bar"', '"type":"pie"');
assert.match(validateCheckpointDraft(invalidChart, artifacts).errors.join("\n"), /type 必须是 bar 或 line/);
const forbiddenContrast = structuredClone(draft);
forbiddenContrast.conclusionMarkdown = "该结果不是随机波动，而是稳定差异。";
assert.match(validateCheckpointDraft(forbiddenContrast, artifacts).errors.join("\n"), /禁止使用/);
forbiddenContrast.conclusionMarkdown = "结果支持稳定差异，而不是随机波动。";
assert.match(validateCheckpointDraft(forbiddenContrast, artifacts).errors.join("\n"), /禁止使用/);

assert.throws(() => new CheckpointStore(project, "."), /subdirectory inside the project/);
await assert.rejects(new CheckpointStore(project, "escape").write(draft, []), /resolves outside the project/);
const store = new CheckpointStore(project);
const stored = await store.write(draft, artifacts);
const markdown = await readFile(stored.markdownPath, "utf8");
assert.match(markdown, /^---\n\{"schema_version":1,/);
assert.match(markdown, /## 1\. 研究目的/);
assert.match(markdown, /## 2\. 实验设置/);
assert.match(markdown, /## 3\. 结果与分析/);
assert.match(markdown, /## 4\. 结论与下一步/);
assert.match(markdown, /## 复现信息/);
assert.match(markdown, /\.\.\/\.\.\/results\/figure\.png \"图 1　两个条件的准确率差异\"/);
assert.equal(parseCheckpointMarkdown(markdown).metadata.title, draft.title);
const discovered = await store.list();
assert.equal(discovered.length, 2);
assert.equal(discovered[0].metadata.id, stored.metadata.id);
assert.equal(discovered.some((item) => item.metadata.title === "旧格式记录"), true);

const blocker = createServer((_request, response) => response.end("occupied"));
await new Promise((resolveListen, rejectListen) => {
  blocker.once("error", rejectListen);
  blocker.listen(0, "127.0.0.1", resolveListen);
});
const blockedPort = blocker.address().port;
const server = new CheckpointViewerServer(store, {
  basePort: blockedPort,
  templatePath: resolve("src/checkpoint-report-template.html"),
});
try {
  await server.start();
  assert.match(server.latestUrl, /^http:\/\/127\.0\.0\.1:\d+\/latest$/);
  assert.notEqual(new URL(server.latestUrl).port, String(blockedPort));
  const origin = server.origin;

  const viewer = await fetch(`${origin}/`);
  assert.equal(viewer.status, 200);
  const viewerHtml = await viewer.text();
  assert.match(viewerHtml, /class="checkpoint-viewer"/);
  assert.doesNotMatch(viewerHtml, /实验组在主要指标/);

  const history = await fetch(`${origin}/api/checkpoints`).then((response) => response.json());
  assert.equal(history.length, 2);
  assert.equal(history[0].url, `/checkpoints/${encodeURIComponent(stored.metadata.id)}`);

  const latestShell = await fetch(`${origin}/latest`);
  assert.equal(latestShell.status, 200);
  const latest = await fetch(`${origin}/api/latest`).then((response) => response.json());
  assert.equal(latest.metadata.title, draft.title);
  assert.match(latest.html, /id="1-研究目的"/);
  assert.match(latest.html, /\/artifacts\/results\/figure\.png/);
  assert.match(latest.html, /<figcaption>图 1　两个条件的准确率差异<\/figcaption>/);
  assert.doesNotMatch(latest.html, /<p><figure/);
  assert.match(latest.html, /data-preview-kind="json"/);
  assert.match(latest.html, /<figure class="checkpoint-chart"/);
  const tableTitleIndex = latest.html.indexOf('class="table-title"');
  const tableIndex = latest.html.indexOf("<table>");
  assert.equal(tableTitleIndex >= 0 && tableTitleIndex < tableIndex, true);
  assert.match(latest.html, /\$5 and \$10/);
  assert.match(latest.html, /\\\(a\+b=c\\\)/);
  assert.match(latest.html, /<code>\$not_math\$<\/code>/);
  assert.match(latest.html, /class="raw-html"/);
  assert.doesNotMatch(latest.html, /<script>/);
  assert.doesNotMatch(latest.html, /\\\(5 and /);
  assert.equal(latest.toc.some((item) => item.text === "3. 结果与分析"), true);

  const checkpointShell = await fetch(`${origin}/checkpoints/${stored.metadata.id}`);
  assert.equal(checkpointShell.status, 200);
  const image = await fetch(`${origin}/artifacts/results/figure.png`);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("content-type"), "image/png");
  assert.equal(image.headers.get("content-security-policy"), "default-src 'none'; sandbox");
  assert.equal(image.headers.get("cross-origin-resource-policy"), "same-origin");
  const preview = await fetch(`${origin}/api/artifacts/results/summary.json`).then((response) => response.json());
  assert.equal(preview.kind, "json");
  assert.match(preview.text, /accuracy/);
  const traversal = await fetch(`${origin}/artifacts/%2E%2E/package.json`);
  assert.equal([403, 404].includes(traversal.status), true);
  const symlinkEscape = await fetch(`${origin}/artifacts/escape/secret.json`);
  assert.equal(symlinkEscape.status, 403);
} finally {
  await server.stop();
  await new Promise((resolveClose) => blocker.close(resolveClose));
  await rm(project, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
}

console.log("Checkpoint Viewer and persistent Markdown smoke test passed");

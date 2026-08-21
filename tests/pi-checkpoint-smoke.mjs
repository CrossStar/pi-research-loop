import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const bundle = await build({
  entryPoints: ["src/checkpoint.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  write: false,
});
const source = bundle.outputFiles[0]?.text;
assert.ok(source, "Pi checkpoint bundle was not generated");
const directory = await mkdtemp(join(tmpdir(), "research-loop-pi-checkpoint-"));
const outside = await mkdtemp(join(tmpdir(), "research-loop-pi-checkpoint-outside-"));
try {
  const bundlePath = join(directory, "checkpoint.mjs");
  await writeFile(bundlePath, source, "utf8");
  process.env.RESEARCH_LOOP_SSH_HOST = "moon";
  const { registerResearchCheckpoint } = await import(pathToFileURL(bundlePath).href);
  let tool;
  const pi = { registerTool(value) { tool = value; } };
  let reached;
  registerResearchCheckpoint(pi, {
    getArtifacts: () => [],
    async save(draft, artifacts) {
      assert.equal(draft.title, "持久化 Markdown 正常生成");
      assert.equal(artifacts.length, 1);
      assert.equal(artifacts[0].artifact.path, "results/run.log");
      return {
        stored: {
          metadata: {
            schema_version: 1,
            id: "checkpoint-test",
            title: draft.title,
            created_at: new Date().toISOString(),
            short_conclusion: draft.shortConclusion,
            artifact_paths: [],
          },
          directory,
          markdownPath: join(directory, "checkpoint.md"),
          relativeMarkdownPath: "checkpoints/checkpoint-test/checkpoint.md",
        },
        viewerUrl: "http://127.0.0.1:43119/latest",
      };
    },
    onReached(resultCount) { reached = resultCount; },
  });
  assert.equal(tool.name, "research_checkpoint");
  const notifications = [];
  const context = {
    cwd: directory,
    ui: { notify(message, level) { notifications.push({ message, level }); } },
  };
  const params = {
    title: "持久化 Markdown 正常生成",
    experimentId: "smoke-1",
    shortConclusion: "Viewer 始终读取项目中的最新研究记录。",
    purposeMarkdown: "此前缺少持久化研究记录。本次检查 Markdown writer。",
    setupMarkdown: "使用合成输入检查四段正文。",
    resultsMarkdown: "最重要的结果是 checkpoint 已保存。",
    conclusionMarkdown: "实现支持持久化记录，下一步检查浏览器。",
    protocols: [{ title: "smoke", intent: "diagnostic", dataScope: "synthetic", sources: [], deviations: [] }],
    reproduction: {
      model: "not-applicable",
      modelRevision: "not-applicable",
      dataset: "synthetic",
      dataRevision: "v1",
      codeCommit: "test",
      seeds: [],
      parameters: [],
    },
    artifacts: [{
      path: "results/run.log",
      title: "运行日志",
      role: "diagnostic",
      description: "保存原始运行输出。",
    }],
  };
  await mkdir(join(directory, "results"), { recursive: true });
  await writeFile(join(directory, "results", "run.log"), "epoch=1 loss=0.25\n", "utf8");
  const outsidePath = join(outside, "secret.json");
  await writeFile(outsidePath, JSON.stringify({ secret: true }), "utf8");
  const unsafe = await tool.execute("call-unsafe", {
    ...params,
    artifacts: [{
      path: relative(directory, outsidePath),
      title: "outside",
      role: "diagnostic",
      description: "must not escape project",
    }],
  }, undefined, undefined, context);
  assert.equal(unsafe.isError, true);
  assert.match(unsafe.content[0].text, /must stay inside the project/);

  const result = await tool.execute("call-1", params, undefined, undefined, context);
  assert.equal(result.terminate, true);
  assert.equal(reached, 1);
  const text = result.content[0].text;
  assert.match(text, /✓ Experiment completed/);
  assert.match(text, /Saved: checkpoints\/checkpoint-test\/checkpoint\.md/);
  assert.match(text, /http:\/\/127\.0\.0\.1:43119\/latest/);
  assert.match(text, /-L 43119:127\.0\.0\.1:43119/);
  assert.match(text, / moon$/);
  assert.equal(notifications.length, 0);
} finally {
  delete process.env.RESEARCH_LOOP_SSH_HOST;
  await rm(directory, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
}

console.log("Pi persistent checkpoint tool smoke test passed");

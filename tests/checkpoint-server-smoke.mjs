import assert from "node:assert/strict";
import { resolve } from "node:path";
import { build } from "esbuild";

const bundle = await build({
  entryPoints: ["src/checkpoint-server.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  write: false,
});
const source = bundle.outputFiles[0]?.text;
assert.ok(source, "checkpoint server bundle was not generated");
const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const {
  CheckpointReportServer,
  formatSshPortForwardCommand,
  renderCheckpointHtml,
} = await import(moduleUrl);

const template = "<!doctype html><script id=\"checkpoint-data\" type=\"application/json\">__RESEARCH_LOOP_CHECKPOINT_DATA__</script>";
const details = {
  title: "Escaped </script> checkpoint",
  researchQuestion: "Does it render?",
  hypothesis: "Yes",
  experiments: [],
  overallAnalysis: "Local only",
  uncertainty: "Smoke scope",
  next: "Inspect",
  results: [],
};
const rendered = renderCheckpointHtml(template, details);
assert.doesNotMatch(rendered, /Escaped <\/script>/);
assert.match(rendered, /Escaped \\u003c\/script>/);
assert.equal(
  formatSshPortForwardCommand("http://127.0.0.1:43119/session/checkpoints/1", "moon"),
  [
    "ssh -N \\",
    "  -o RemoteCommand=none \\",
    "  -o RequestTTY=no \\",
    "  -L 43119:127.0.0.1:43119 \\",
    "  moon",
  ].join("\n"),
);

const server = new CheckpointReportServer({
  basePort: 43119,
  templatePath: resolve("src/checkpoint-report-template.html"),
});
try {
  const firstUrl = await server.publish(details);
  const secondUrl = await server.publish({ ...details, title: "Second checkpoint" });
  assert.match(firstUrl, /^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{32}\/checkpoints\/1$/);
  assert.match(secondUrl, /\/checkpoints\/2$/);
  assert.equal(server.reportCount, 2);

  const response = await fetch(firstUrl);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/html/);
  const html = await response.text();
  assert.match(html, /Escaped \\u003c\/script>/);
  assert.match(html, /class="app-shell"/);
  assert.match(html, /function renderJsonViewer/);

  const root = new URL(firstUrl);
  root.pathname = root.pathname.replace(/\/checkpoints\/1$/, "/");
  const latest = await fetch(root, { redirect: "manual" });
  assert.equal(latest.status, 302);
  assert.match(latest.headers.get("location") ?? "", /\/checkpoints\/2$/);
} finally {
  await server.stop();
}
assert.equal(server.reportCount, 0);
console.log("Checkpoint report server smoke test passed");

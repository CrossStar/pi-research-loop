import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const bundle = await build({
  entryPoints: ["src/terminal-image.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  write: false,
});
const source = bundle.outputFiles[0]?.text;
assert.ok(source, "terminal image bundle was not generated");
const directory = await mkdtemp(join(tmpdir(), "research-loop-terminal-image-"));
try {
  const bundlePath = join(directory, "terminal-image.mjs");
  await writeFile(bundlePath, source, "utf8");
  const { buildChafaArguments, formatSixelLines } = await import(pathToFileURL(bundlePath).href);

  assert.deepEqual(
    buildChafaArguments("sixels", 72, 24),
    ["--format=sixels", "--colors=full", "--size=72x24", "-"],
  );
  assert.deepEqual(
    buildChafaArguments("symbols", 80, 28),
    ["--format=symbols", "--colors=full", "--size=80x28", "-"],
  );
  const lines = formatSixelLines("\u001bPqSIXEL-DATA\u001b\\\n", 3);
  assert.equal(lines.length, 3);
  assert.equal(lines[0], "");
  assert.equal(lines[1], "");
  assert.equal(lines[2], "\u001b[2A\u001bPqSIXEL-DATA\u001b\\");
} finally {
  await rm(directory, { recursive: true, force: true });
}

console.log("Terminal image smoke test passed");

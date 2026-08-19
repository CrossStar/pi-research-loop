import { build } from "esbuild";
import { mkdir } from "node:fs/promises";

await mkdir("dist/claude", { recursive: true });

for (const entry of ["hook", "mcp-server", "statusline", "statusline-cli"]) {
  await build({
    entryPoints: [`src/claude/${entry}.ts`],
    outfile: `dist/claude/${entry}.js`,
    bundle: true,
    platform: "node",
    target: "node20",
    format: "esm",
    minify: true,
    sourcemap: false,
    legalComments: "none",
  });
}

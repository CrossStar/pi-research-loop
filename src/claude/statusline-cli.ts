#!/usr/bin/env node
import {
  claudePluginRoot,
  getClaudeStatusLineStatus,
  installClaudeStatusLine,
  uninstallClaudeStatusLine,
} from "./statusline-config.js";

const action = process.argv[2] ?? "status";
const result = action === "install"
  ? await installClaudeStatusLine(claudePluginRoot(import.meta.url))
  : action === "uninstall"
    ? await uninstallClaudeStatusLine()
    : action === "status"
      ? await getClaudeStatusLineStatus()
      : undefined;

if (!result) {
  process.stderr.write("Usage: statusline-cli.js install|uninstall|status\n");
  process.exitCode = 2;
} else {
  process.stdout.write(`${result.installed ? "Research status line installed" : "Research status line not installed"}\n`);
  process.stdout.write(`Settings: ${result.settingsPath}\n`);
  process.stdout.write(`Command: ${result.command}\n`);
  if (result.preservesPreviousStatusLine) {
    process.stdout.write("The previous Claude status line is preserved and rendered above Research Loop.\n");
  }
}

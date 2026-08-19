import { access, copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface ClaudeSettings {
  statusLine?: unknown;
  [key: string]: unknown;
}

interface InstalledStatusLineConfig {
  schemaVersion: 1;
  hadPreviousStatusLine: boolean;
  previousStatusLine?: unknown;
  baseCommand?: string;
  installedAt: string;
}

export interface StatusLineConfigurationStatus {
  installed: boolean;
  settingsPath: string;
  command: string;
  preservesPreviousStatusLine: boolean;
}

export function claudePluginRoot(moduleUrl: string): string {
  return resolve(dirname(fileURLToPath(moduleUrl)), "../..");
}

export async function installClaudeStatusLine(pluginRoot: string): Promise<StatusLineConfigurationStatus> {
  const paths = statusLinePaths();
  const settings = await readSettings(paths.settingsPath);
  const currentIsOurs = isOurStatusLine(settings.statusLine, paths.command);
  const previousConfig = await readInstalledConfig(paths.configPath);
  const hadPreviousStatusLine = currentIsOurs
    ? previousConfig?.hadPreviousStatusLine ?? false
    : Object.prototype.hasOwnProperty.call(settings, "statusLine");
  const previousStatusLine = currentIsOurs ? previousConfig?.previousStatusLine : settings.statusLine;
  const baseCommand = commandFromStatusLine(previousStatusLine);

  await mkdir(paths.installDirectory, { recursive: true });
  await copyFile(join(pluginRoot, "dist", "claude", "statusline.js"), paths.scriptPath);
  await writeJsonAtomic(paths.configPath, {
    schemaVersion: 1,
    hadPreviousStatusLine,
    previousStatusLine,
    baseCommand,
    installedAt: new Date().toISOString(),
  } satisfies InstalledStatusLineConfig);

  settings.statusLine = {
    type: "command",
    command: paths.command,
    padding: statusLinePadding(previousStatusLine),
  };
  await writeJsonAtomic(paths.settingsPath, settings);
  return getClaudeStatusLineStatus();
}

export async function uninstallClaudeStatusLine(): Promise<StatusLineConfigurationStatus> {
  const paths = statusLinePaths();
  const settings = await readSettings(paths.settingsPath);
  const config = await readInstalledConfig(paths.configPath);
  if (isOurStatusLine(settings.statusLine, paths.command)) {
    if (config?.hadPreviousStatusLine) settings.statusLine = config.previousStatusLine;
    else delete settings.statusLine;
    await writeJsonAtomic(paths.settingsPath, settings);
  }
  await rm(paths.installDirectory, { recursive: true, force: true });
  return getClaudeStatusLineStatus();
}

export async function getClaudeStatusLineStatus(): Promise<StatusLineConfigurationStatus> {
  const paths = statusLinePaths();
  const settings = await readSettings(paths.settingsPath);
  const config = await readInstalledConfig(paths.configPath);
  const scriptExists = await fileExists(paths.scriptPath);
  return {
    installed: scriptExists && isOurStatusLine(settings.statusLine, paths.command),
    settingsPath: paths.settingsPath,
    command: paths.command,
    preservesPreviousStatusLine: Boolean(config?.hadPreviousStatusLine),
  };
}

function statusLinePaths() {
  const claudeHome = process.env.PI_RESEARCH_LOOP_CLAUDE_HOME
    ? resolve(process.env.PI_RESEARCH_LOOP_CLAUDE_HOME)
    : join(homedir(), ".claude");
  const installDirectory = join(claudeHome, "pi-research-loop");
  const scriptPath = join(installDirectory, "statusline.mjs");
  const configPath = join(installDirectory, "statusline-config.json");
  const settingsPath = join(claudeHome, "settings.json");
  const portableScriptPath = scriptPath.replace(/\\/g, "/");
  return {
    installDirectory,
    scriptPath,
    configPath,
    settingsPath,
    command: `node "${portableScriptPath}"`,
  };
}

async function readSettings(path: string): Promise<ClaudeSettings> {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Claude settings must contain a JSON object.");
    }
    return value as ClaudeSettings;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`Could not read Claude settings at ${path}: ${String(error)}`);
  }
}

async function readInstalledConfig(path: string): Promise<InstalledStatusLineConfig | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<InstalledStatusLineConfig>;
    return value.schemaVersion === 1 ? value as InstalledStatusLineConfig : undefined;
  } catch {
    return undefined;
  }
}

function commandFromStatusLine(statusLine: unknown): string | undefined {
  if (!statusLine || typeof statusLine !== "object") return undefined;
  const candidate = statusLine as { type?: unknown; command?: unknown };
  return candidate.type === "command" && typeof candidate.command === "string"
    ? candidate.command
    : undefined;
}

function statusLinePadding(statusLine: unknown): number {
  if (!statusLine || typeof statusLine !== "object") return 0;
  const padding = (statusLine as { padding?: unknown }).padding;
  return typeof padding === "number" && Number.isInteger(padding) && padding >= 0 ? padding : 0;
}

function isOurStatusLine(statusLine: unknown, command: string): boolean {
  const configured = commandFromStatusLine(statusLine);
  if (configured === command) return true;
  return typeof configured === "string"
    && /pi-research-loop[\\/]statusline\.(?:mjs|js)["']?\s*$/.test(configured.replace(/\\\\/g, "/"));
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    await rename(temporary, path);
  } catch {
    await rm(path, { force: true });
    await rename(temporary, path);
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

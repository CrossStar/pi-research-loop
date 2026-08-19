import { access, copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
export function claudePluginRoot(moduleUrl) {
    return resolve(dirname(fileURLToPath(moduleUrl)), "../..");
}
export async function installClaudeStatusLine(pluginRoot) {
    const paths = statusLinePaths();
    const settings = await readSettings(paths.settingsPath);
    const currentIsOurs = isOurStatusLine(settings.statusLine, paths.command);
    const currentConfig = await readInstalledConfig(paths.configPath);
    const previousConfig = currentConfig ?? await readInstalledConfig(paths.legacyConfigPath);
    const hadPreviousStatusLine = currentIsOurs
        ? previousConfig?.hadPreviousStatusLine ?? false
        : Object.prototype.hasOwnProperty.call(settings, "statusLine");
    const previousStatusLine = currentIsOurs ? previousConfig?.previousStatusLine : settings.statusLine;
    const baseCommand = previousConfig?.baseCommand ?? commandFromStatusLine(previousStatusLine);
    await mkdir(paths.installDirectory, { recursive: true });
    await copyFile(join(pluginRoot, "dist", "claude", "statusline.js"), paths.scriptPath);
    await writeJsonAtomic(paths.configPath, {
        schemaVersion: 1,
        hadPreviousStatusLine,
        previousStatusLine,
        baseCommand,
        installedAt: new Date().toISOString(),
    });
    settings.statusLine = {
        type: "command",
        command: paths.command,
        padding: statusLinePadding(previousStatusLine),
    };
    await writeJsonAtomic(paths.settingsPath, settings);
    await rm(paths.disabledPath, { force: true });
    if (paths.legacyInstallDirectory !== paths.installDirectory) {
        await rm(paths.legacyInstallDirectory, { recursive: true, force: true });
    }
    return getClaudeStatusLineStatus();
}
export async function ensureClaudeStatusLine(pluginRoot) {
    const paths = statusLinePaths();
    const status = await getClaudeStatusLineStatus();
    if (status.installed)
        return { changed: false, disabledByUser: false, status };
    if (await fileExists(paths.disabledPath)) {
        return { changed: false, disabledByUser: true, status };
    }
    return {
        changed: true,
        disabledByUser: false,
        status: await installClaudeStatusLine(pluginRoot),
    };
}
export async function uninstallClaudeStatusLine() {
    const paths = statusLinePaths();
    const settings = await readSettings(paths.settingsPath);
    const config = await readInstalledConfig(paths.configPath)
        ?? await readInstalledConfig(paths.legacyConfigPath);
    if (isOurStatusLine(settings.statusLine, paths.command)) {
        if (config?.hadPreviousStatusLine)
            settings.statusLine = config.previousStatusLine;
        else
            delete settings.statusLine;
        await writeJsonAtomic(paths.settingsPath, settings);
    }
    await rm(paths.installDirectory, { recursive: true, force: true });
    await rm(paths.legacyInstallDirectory, { recursive: true, force: true });
    await writeFile(paths.disabledPath, "Disabled by user. Run statusline install to enable again.\n", "utf8");
    return getClaudeStatusLineStatus();
}
export async function getClaudeStatusLineStatus() {
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
    const claudeHome = process.env.RESEARCH_LOOP_CLAUDE_HOME
        ? resolve(process.env.RESEARCH_LOOP_CLAUDE_HOME)
        : join(homedir(), ".claude");
    const installDirectory = join(claudeHome, "research-loop");
    const legacyInstallDirectory = join(claudeHome, "pi-research-loop");
    const scriptPath = join(installDirectory, "statusline.mjs");
    const configPath = join(installDirectory, "statusline-config.json");
    const legacyConfigPath = join(legacyInstallDirectory, "statusline-config.json");
    const disabledPath = join(claudeHome, "research-loop-statusline.disabled");
    const settingsPath = join(claudeHome, "settings.json");
    const portableScriptPath = scriptPath.replace(/\\/g, "/");
    return {
        installDirectory,
        legacyInstallDirectory,
        scriptPath,
        configPath,
        legacyConfigPath,
        disabledPath,
        settingsPath,
        command: `node "${portableScriptPath}"`,
    };
}
async function readSettings(path) {
    try {
        const value = JSON.parse(await readFile(path, "utf8"));
        if (!value || typeof value !== "object" || Array.isArray(value)) {
            throw new Error("Claude settings must contain a JSON object.");
        }
        return value;
    }
    catch (error) {
        if (error.code === "ENOENT")
            return {};
        throw new Error(`Could not read Claude settings at ${path}: ${String(error)}`);
    }
}
async function readInstalledConfig(path) {
    try {
        const value = JSON.parse(await readFile(path, "utf8"));
        return value.schemaVersion === 1 ? value : undefined;
    }
    catch {
        return undefined;
    }
}
function commandFromStatusLine(statusLine) {
    if (!statusLine || typeof statusLine !== "object")
        return undefined;
    const candidate = statusLine;
    return candidate.type === "command" && typeof candidate.command === "string"
        ? candidate.command
        : undefined;
}
function statusLinePadding(statusLine) {
    if (!statusLine || typeof statusLine !== "object")
        return 0;
    const padding = statusLine.padding;
    return typeof padding === "number" && Number.isInteger(padding) && padding >= 0 ? padding : 0;
}
function isOurStatusLine(statusLine, command) {
    const configured = commandFromStatusLine(statusLine);
    if (configured === command)
        return true;
    return typeof configured === "string"
        && /(?:pi-)?research-loop[\\/]statusline\.(?:mjs|js)["']?\s*$/.test(configured.replace(/\\\\/g, "/"));
}
async function writeJsonAtomic(path, value) {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    try {
        await rename(temporary, path);
    }
    catch {
        await rm(path, { force: true });
        await rename(temporary, path);
    }
}
async function fileExists(path) {
    try {
        await access(path);
        return true;
    }
    catch {
        return false;
    }
}

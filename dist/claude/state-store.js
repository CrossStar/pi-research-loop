import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ResearchCore } from "../core/research-core.js";
export class ClaudeStateStore {
    cwd;
    statePath;
    constructor(cwd = process.env.CLAUDE_PROJECT_DIR ?? process.cwd()) {
        this.cwd = resolve(cwd);
        const projectKey = createHash("sha256").update(this.cwd).digest("hex").slice(0, 20);
        this.statePath = join(tmpdir(), "research-loop", projectKey, "state.json");
    }
    async beginSession(sessionId) {
        const stored = await this.read();
        const core = stored?.sessionId === sessionId ? new ResearchCore(stored.core) : new ResearchCore();
        await this.write({
            schemaVersion: 1,
            sessionId,
            cwd: this.cwd,
            updatedAt: Date.now(),
            active: true,
            core: core.snapshot(),
        });
        return core;
    }
    async endSession(sessionId) {
        const stored = await this.read();
        if (!stored || stored.sessionId !== sessionId)
            return;
        await this.write({ ...stored, active: false, updatedAt: Date.now() });
    }
    async hasActiveState() {
        const stored = await this.read();
        return stored?.active === true;
    }
    async loadCore() {
        const stored = await this.read();
        return stored ? new ResearchCore(stored.core) : new ResearchCore();
    }
    async saveCore(core, sessionId) {
        const stored = await this.read();
        await this.write({
            schemaVersion: 1,
            sessionId: sessionId ?? stored?.sessionId ?? process.env.CLAUDE_SESSION_ID ?? "unbound",
            cwd: this.cwd,
            updatedAt: Date.now(),
            active: stored?.active ?? true,
            core: core.snapshot(),
        });
    }
    async read() {
        try {
            const value = JSON.parse(await readFile(this.statePath, "utf8"));
            if (value.schemaVersion !== 1 || !value.core || typeof value.sessionId !== "string")
                return undefined;
            return value;
        }
        catch {
            return undefined;
        }
    }
    async write(state) {
        const directory = dirname(this.statePath);
        await mkdir(directory, { recursive: true });
        const temporary = `${this.statePath}.${process.pid}.${Date.now()}.tmp`;
        await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
        try {
            await rename(temporary, this.statePath);
        }
        catch {
            await rm(this.statePath, { force: true });
            await rename(temporary, this.statePath);
        }
    }
}

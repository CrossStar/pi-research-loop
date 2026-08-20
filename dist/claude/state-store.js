import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ResearchCore } from "../core/research-core.js";
const DISPATCH_TTL_MS = 5 * 60 * 1_000;
const LEASE_TTL_MS = 2 * 60 * 60 * 1_000;
const LOCK_STALE_MS = 15_000;
export class ClaudeStateStore {
    cwd;
    rootDirectory;
    statePath;
    dispatchDirectory;
    agentDirectory;
    eventDirectory;
    lockDirectory;
    constructor(cwd = process.env.CLAUDE_PROJECT_DIR ?? process.cwd()) {
        this.cwd = resolve(cwd);
        const projectKey = createHash("sha256").update(this.cwd).digest("hex").slice(0, 20);
        this.rootDirectory = join(tmpdir(), "research-loop", projectKey);
        this.statePath = join(this.rootDirectory, "state.json");
        this.dispatchDirectory = join(this.rootDirectory, "dispatches");
        this.agentDirectory = join(this.rootDirectory, "agents");
        this.eventDirectory = join(this.rootDirectory, "events");
        this.lockDirectory = join(this.rootDirectory, ".state-lock");
    }
    async beginSession(sessionId) {
        const stored = await this.readState();
        const resume = stored?.sessionId === sessionId;
        const core = resume ? new ResearchCore(stored.core) : new ResearchCore();
        if (!resume)
            await this.resetSubagents();
        await this.writeState({
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
        const stored = await this.readState();
        if (!stored || stored.sessionId !== sessionId)
            return;
        const core = new ResearchCore(stored.core);
        for (const artifact of await this.readSubagentArtifacts())
            core.upsertArtifact(artifact);
        await this.writeState({
            ...stored,
            active: false,
            updatedAt: Date.now(),
            core: core.snapshot(),
        });
        await this.resetSubagents();
    }
    async hasActiveState() {
        const stored = await this.readState();
        return stored?.active === true;
    }
    async ownerSessionId() {
        return (await this.readState())?.sessionId;
    }
    async loadCore() {
        const stored = await this.readState();
        const core = stored ? new ResearchCore(stored.core) : new ResearchCore();
        for (const artifact of await this.readSubagentArtifacts())
            core.upsertArtifact(artifact);
        return core;
    }
    async saveCore(core, sessionId) {
        for (const artifact of await this.readSubagentArtifacts())
            core.upsertArtifact(artifact);
        const stored = await this.readState();
        await this.writeState({
            schemaVersion: 1,
            sessionId: sessionId ?? stored?.sessionId ?? process.env.CLAUDE_SESSION_ID ?? "unbound",
            cwd: this.cwd,
            updatedAt: Date.now(),
            active: stored?.active ?? true,
            core: core.snapshot(),
        });
    }
    async createSubagentDispatch(dispatch) {
        await writeJsonAtomic(join(this.dispatchDirectory, `${safeId(dispatch.dispatchId)}.json`), dispatch);
    }
    async removeSubagentDispatch(dispatchId) {
        await rm(join(this.dispatchDirectory, `${safeId(dispatchId)}.json`), { force: true });
    }
    async claimSubagentLease(input) {
        const existing = await this.readLease(input.agentId);
        if (existing?.active)
            return existing;
        return this.withLock(async () => {
            const dispatches = await this.readDispatches();
            const now = Date.now();
            const candidate = dispatches
                .filter((dispatch) => dispatch.parentSessionId === input.parentSessionId)
                .filter((dispatch) => now - dispatch.createdAt <= DISPATCH_TTL_MS)
                .filter((dispatch) => !input.agentType || dispatch.agentType === input.agentType)
                .sort((a, b) => a.createdAt - b.createdAt)[0];
            if (!candidate)
                return undefined;
            const lease = {
                schemaVersion: 1,
                agentId: input.agentId,
                parentSessionId: candidate.parentSessionId,
                agentType: candidate.agentType,
                description: candidate.description,
                objective: candidate.objective,
                mode: candidate.mode,
                capabilities: [...candidate.capabilities],
                active: true,
                startedAt: now,
                updatedAt: now,
            };
            await writeJsonAtomic(this.leasePath(input.agentId), lease);
            await this.removeSubagentDispatch(candidate.dispatchId);
            return lease;
        });
    }
    async loadSubagentLease(agentId) {
        const lease = await this.readLease(agentId);
        if (!lease?.active)
            return lease;
        if (Date.now() - lease.updatedAt <= LEASE_TTL_MS)
            return lease;
        await this.finishSubagent(agentId);
        return { ...lease, active: false };
    }
    async finishSubagent(agentId) {
        const lease = await this.readLease(agentId);
        if (!lease)
            return;
        await writeJsonAtomic(this.leasePath(agentId), {
            ...lease,
            active: false,
            updatedAt: Date.now(),
        });
    }
    async activeSubagentCount(parentSessionId) {
        const now = Date.now();
        const leases = await this.readLeases();
        const dispatches = await this.readDispatches();
        return leases.filter((lease) => lease.active
            && now - lease.updatedAt <= LEASE_TTL_MS
            && (!parentSessionId || lease.parentSessionId === parentSessionId)).length + dispatches.filter((dispatch) => now - dispatch.createdAt <= DISPATCH_TTL_MS
            && (!parentSessionId || dispatch.parentSessionId === parentSessionId)).length;
    }
    async recordSubagentArtifact(agentId, artifact) {
        const event = {
            schemaVersion: 1,
            kind: "artifact",
            eventId: randomUUID(),
            agentId,
            createdAt: Date.now(),
            artifact: { ...artifact },
        };
        await writeJsonAtomic(join(this.eventDirectory, `${event.createdAt}-${event.eventId}.json`), event);
    }
    async readState() {
        const value = await readJson(this.statePath);
        if (value?.schemaVersion !== 1 || !value.core || typeof value.sessionId !== "string")
            return undefined;
        return value;
    }
    async writeState(state) {
        await writeJsonAtomic(this.statePath, state);
    }
    async readDispatches() {
        return this.readJsonDirectory(this.dispatchDirectory, (value) => value.schemaVersion === 1 && typeof value.dispatchId === "string");
    }
    async readLease(agentId) {
        const value = await readJson(this.leasePath(agentId));
        return value?.schemaVersion === 1 && value.agentId === agentId ? value : undefined;
    }
    async readLeases() {
        return this.readJsonDirectory(this.agentDirectory, (value) => value.schemaVersion === 1 && typeof value.agentId === "string");
    }
    async readSubagentArtifacts() {
        const events = await this.readJsonDirectory(this.eventDirectory, (value) => value.schemaVersion === 1 && value.kind === "artifact" && Boolean(value.artifact));
        return events.map((event) => ({ ...event.artifact }));
    }
    async readJsonDirectory(directory, valid) {
        let names;
        try {
            names = await readdir(directory);
        }
        catch {
            return [];
        }
        const values = [];
        for (const name of names) {
            if (!name.endsWith(".json"))
                continue;
            const value = await readJson(join(directory, name));
            if (value && valid(value))
                values.push(value);
        }
        return values;
    }
    leasePath(agentId) {
        return join(this.agentDirectory, `${safeId(agentId)}.json`);
    }
    async resetSubagents() {
        await Promise.all([
            rm(this.dispatchDirectory, { recursive: true, force: true }),
            rm(this.agentDirectory, { recursive: true, force: true }),
            rm(this.eventDirectory, { recursive: true, force: true }),
        ]);
    }
    async withLock(operation) {
        await mkdir(this.rootDirectory, { recursive: true });
        for (let attempt = 0; attempt < 100; attempt += 1) {
            try {
                await mkdir(this.lockDirectory);
                try {
                    return await operation();
                }
                finally {
                    await rm(this.lockDirectory, { recursive: true, force: true });
                }
            }
            catch (error) {
                if (error.code !== "EEXIST")
                    throw error;
                try {
                    const details = await stat(this.lockDirectory);
                    if (Date.now() - details.mtimeMs > LOCK_STALE_MS) {
                        await rm(this.lockDirectory, { recursive: true, force: true });
                        continue;
                    }
                }
                catch {
                    // Another process released the lock between checks.
                }
                await delay(10 + attempt * 2);
            }
        }
        throw new Error("Timed out waiting for the Research Loop state lock.");
    }
}
async function readJson(path) {
    try {
        return JSON.parse(await readFile(path, "utf8"));
    }
    catch {
        return undefined;
    }
}
async function writeJsonAtomic(path, value) {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    try {
        await rename(temporary, path);
    }
    catch {
        await rm(path, { force: true });
        await rename(temporary, path);
    }
}
function safeId(value) {
    return createHash("sha256").update(value).digest("hex").slice(0, 32);
}
function delay(milliseconds) {
    return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

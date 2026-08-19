import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ResearchCore, type ResearchCoreSnapshot } from "../core/research-core.js";
import type { ArtifactMetadata } from "../core/types.js";
import type {
  SubagentArtifactEvent,
  SubagentDispatch,
  SubagentLease,
} from "./subagents.js";

interface StoredClaudeState {
  schemaVersion: 1;
  sessionId: string;
  cwd: string;
  updatedAt: number;
  active: boolean;
  core: ResearchCoreSnapshot;
}

const DISPATCH_TTL_MS = 5 * 60 * 1_000;
const LEASE_TTL_MS = 2 * 60 * 60 * 1_000;
const LOCK_STALE_MS = 15_000;

export class ClaudeStateStore {
  readonly cwd: string;
  readonly rootDirectory: string;
  private readonly statePath: string;
  private readonly dispatchDirectory: string;
  private readonly agentDirectory: string;
  private readonly eventDirectory: string;
  private readonly lockDirectory: string;

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

  async beginSession(sessionId: string): Promise<ResearchCore> {
    const stored = await this.readState();
    const resume = stored?.sessionId === sessionId;
    const core = resume ? new ResearchCore(stored.core) : new ResearchCore();
    if (!resume) await this.resetSubagents();
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

  async endSession(sessionId: string): Promise<void> {
    const stored = await this.readState();
    if (!stored || stored.sessionId !== sessionId) return;
    const core = new ResearchCore(stored.core);
    for (const artifact of await this.readSubagentArtifacts()) core.upsertArtifact(artifact);
    await this.writeState({
      ...stored,
      active: false,
      updatedAt: Date.now(),
      core: core.snapshot(),
    });
    await this.resetSubagents();
  }

  async hasActiveState(): Promise<boolean> {
    const stored = await this.readState();
    return stored?.active === true;
  }

  async ownerSessionId(): Promise<string | undefined> {
    return (await this.readState())?.sessionId;
  }

  async loadCore(): Promise<ResearchCore> {
    const stored = await this.readState();
    const core = stored ? new ResearchCore(stored.core) : new ResearchCore();
    for (const artifact of await this.readSubagentArtifacts()) core.upsertArtifact(artifact);
    return core;
  }

  async saveCore(core: ResearchCore, sessionId?: string): Promise<void> {
    for (const artifact of await this.readSubagentArtifacts()) core.upsertArtifact(artifact);
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

  async createSubagentDispatch(dispatch: SubagentDispatch): Promise<void> {
    await writeJsonAtomic(join(this.dispatchDirectory, `${safeId(dispatch.dispatchId)}.json`), dispatch);
  }

  async removeSubagentDispatch(dispatchId: string): Promise<void> {
    await rm(join(this.dispatchDirectory, `${safeId(dispatchId)}.json`), { force: true });
  }

  async claimSubagentLease(input: {
    agentId: string;
    parentSessionId: string;
    agentType?: string;
  }): Promise<SubagentLease | undefined> {
    const existing = await this.readLease(input.agentId);
    if (existing?.active) return existing;

    return this.withLock(async () => {
      const dispatches = await this.readDispatches();
      const now = Date.now();
      const candidate = dispatches
        .filter((dispatch) => dispatch.parentSessionId === input.parentSessionId)
        .filter((dispatch) => now - dispatch.createdAt <= DISPATCH_TTL_MS)
        .filter((dispatch) => !input.agentType || dispatch.agentType === input.agentType)
        .sort((a, b) => a.createdAt - b.createdAt)[0];
      if (!candidate) return undefined;

      const lease: SubagentLease = {
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

  async loadSubagentLease(agentId: string): Promise<SubagentLease | undefined> {
    const lease = await this.readLease(agentId);
    if (!lease?.active) return lease;
    if (Date.now() - lease.updatedAt <= LEASE_TTL_MS) return lease;
    await this.finishSubagent(agentId);
    return { ...lease, active: false };
  }

  async finishSubagent(agentId: string): Promise<void> {
    const lease = await this.readLease(agentId);
    if (!lease) return;
    await writeJsonAtomic(this.leasePath(agentId), {
      ...lease,
      active: false,
      updatedAt: Date.now(),
    } satisfies SubagentLease);
  }

  async activeSubagentCount(parentSessionId?: string): Promise<number> {
    const now = Date.now();
    const leases = await this.readLeases();
    const dispatches = await this.readDispatches();
    return leases.filter((lease) =>
      lease.active
      && now - lease.updatedAt <= LEASE_TTL_MS
      && (!parentSessionId || lease.parentSessionId === parentSessionId)
    ).length + dispatches.filter((dispatch) =>
      now - dispatch.createdAt <= DISPATCH_TTL_MS
      && (!parentSessionId || dispatch.parentSessionId === parentSessionId)
    ).length;
  }

  async recordSubagentArtifact(agentId: string, artifact: ArtifactMetadata): Promise<void> {
    const event: SubagentArtifactEvent = {
      schemaVersion: 1,
      kind: "artifact",
      eventId: randomUUID(),
      agentId,
      createdAt: Date.now(),
      artifact: { ...artifact },
    };
    await writeJsonAtomic(join(this.eventDirectory, `${event.createdAt}-${event.eventId}.json`), event);
  }

  private async readState(): Promise<StoredClaudeState | undefined> {
    const value = await readJson<Partial<StoredClaudeState>>(this.statePath);
    if (value?.schemaVersion !== 1 || !value.core || typeof value.sessionId !== "string") return undefined;
    return value as StoredClaudeState;
  }

  private async writeState(state: StoredClaudeState): Promise<void> {
    await writeJsonAtomic(this.statePath, state);
  }

  private async readDispatches(): Promise<SubagentDispatch[]> {
    return this.readJsonDirectory<SubagentDispatch>(this.dispatchDirectory, (value) =>
      value.schemaVersion === 1 && typeof value.dispatchId === "string");
  }

  private async readLease(agentId: string): Promise<SubagentLease | undefined> {
    const value = await readJson<SubagentLease>(this.leasePath(agentId));
    return value?.schemaVersion === 1 && value.agentId === agentId ? value : undefined;
  }

  private async readLeases(): Promise<SubagentLease[]> {
    return this.readJsonDirectory<SubagentLease>(this.agentDirectory, (value) =>
      value.schemaVersion === 1 && typeof value.agentId === "string");
  }

  private async readSubagentArtifacts(): Promise<ArtifactMetadata[]> {
    const events = await this.readJsonDirectory<SubagentArtifactEvent>(this.eventDirectory, (value) =>
      value.schemaVersion === 1 && value.kind === "artifact" && Boolean(value.artifact));
    return events.map((event) => ({ ...event.artifact }));
  }

  private async readJsonDirectory<T>(
    directory: string,
    valid: (value: T) => boolean,
  ): Promise<T[]> {
    let names: string[];
    try {
      names = await readdir(directory);
    } catch {
      return [];
    }
    const values: T[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const value = await readJson<T>(join(directory, name));
      if (value && valid(value)) values.push(value);
    }
    return values;
  }

  private leasePath(agentId: string): string {
    return join(this.agentDirectory, `${safeId(agentId)}.json`);
  }

  private async resetSubagents(): Promise<void> {
    await Promise.all([
      rm(this.dispatchDirectory, { recursive: true, force: true }),
      rm(this.agentDirectory, { recursive: true, force: true }),
      rm(this.eventDirectory, { recursive: true, force: true }),
    ]);
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(this.rootDirectory, { recursive: true });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        await mkdir(this.lockDirectory);
        try {
          return await operation();
        } finally {
          await rm(this.lockDirectory, { recursive: true, force: true });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          const details = await stat(this.lockDirectory);
          if (Date.now() - details.mtimeMs > LOCK_STALE_MS) {
            await rm(this.lockDirectory, { recursive: true, force: true });
            continue;
          }
        } catch {
          // Another process released the lock between checks.
        }
        await delay(10 + attempt * 2);
      }
    }
    throw new Error("Timed out waiting for the Research Loop state lock.");
  }
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    await rename(temporary, path);
  } catch {
    await rm(path, { force: true });
    await rename(temporary, path);
  }
}

function safeId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

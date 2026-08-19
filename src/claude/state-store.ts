import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ResearchCore, type ResearchCoreSnapshot } from "../core/research-core.js";

interface StoredClaudeState {
  schemaVersion: 1;
  sessionId: string;
  cwd: string;
  updatedAt: number;
  active: boolean;
  core: ResearchCoreSnapshot;
}

export class ClaudeStateStore {
  readonly cwd: string;
  private readonly statePath: string;

  constructor(cwd = process.env.CLAUDE_PROJECT_DIR ?? process.cwd()) {
    this.cwd = resolve(cwd);
    const projectKey = createHash("sha256").update(this.cwd).digest("hex").slice(0, 20);
    this.statePath = join(tmpdir(), "pi-research-loop", projectKey, "state.json");
  }

  async beginSession(sessionId: string): Promise<ResearchCore> {
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

  async endSession(sessionId: string): Promise<void> {
    const stored = await this.read();
    if (!stored || stored.sessionId !== sessionId) return;
    await this.write({ ...stored, active: false, updatedAt: Date.now() });
  }

  async hasActiveState(): Promise<boolean> {
    const stored = await this.read();
    return stored?.active === true;
  }

  async loadCore(): Promise<ResearchCore> {
    const stored = await this.read();
    return stored ? new ResearchCore(stored.core) : new ResearchCore();
  }

  async saveCore(core: ResearchCore, sessionId?: string): Promise<void> {
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

  private async read(): Promise<StoredClaudeState | undefined> {
    try {
      const value = JSON.parse(await readFile(this.statePath, "utf8")) as Partial<StoredClaudeState>;
      if (value.schemaVersion !== 1 || !value.core || typeof value.sessionId !== "string") return undefined;
      return value as StoredClaudeState;
    } catch {
      return undefined;
    }
  }

  private async write(state: StoredClaudeState): Promise<void> {
    const directory = dirname(this.statePath);
    await mkdir(directory, { recursive: true });
    const temporary = `${this.statePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    try {
      await rename(temporary, this.statePath);
    } catch {
      await rm(this.statePath, { force: true });
      await rename(temporary, this.statePath);
    }
  }
}

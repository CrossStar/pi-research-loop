import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { hostname } from "node:os";
import { fileURLToPath } from "node:url";
import type { CheckpointDetails } from "./checkpoint.js";

const HOST = "127.0.0.1";
const DEFAULT_BASE_PORT = 43119;
const MAX_PORT_ATTEMPTS = 100;
const DATA_PLACEHOLDER = "__RESEARCH_LOOP_CHECKPOINT_DATA__";

interface StoredCheckpoint {
  id: number;
  title: string;
  createdAt: number;
  details: CheckpointDetails;
}

export interface CheckpointReportServerOptions {
  basePort?: number;
  template?: string;
  templatePath?: string;
}

/** Session-scoped, localhost-only checkpoint report server. Reports never touch the project tree. */
export class CheckpointReportServer {
  private readonly reports = new Map<number, StoredCheckpoint>();
  private sessionToken = randomBytes(16).toString("hex");
  private readonly basePort: number;
  private readonly templateOverride?: string;
  private readonly templatePath: string;
  private server?: Server;
  private port?: number;
  private startPromise?: Promise<void>;
  private nextId = 1;

  constructor(options: CheckpointReportServerOptions = {}) {
    this.basePort = normalizeBasePort(options.basePort ?? envBasePort());
    this.templateOverride = options.template;
    this.templatePath = options.templatePath
      ?? fileURLToPath(new URL("./checkpoint-report-template.html", import.meta.url));
  }

  get origin(): string | undefined {
    return this.port === undefined ? undefined : `http://${HOST}:${this.port}`;
  }

  get reportCount(): number {
    return this.reports.size;
  }

  async start(): Promise<void> {
    if (this.server?.listening) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startListening();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = undefined;
    }
  }

  async publish(details: CheckpointDetails): Promise<string> {
    await this.start();
    if (!this.origin) throw new Error("Checkpoint report server did not start.");
    const id = this.nextId++;
    this.reports.set(id, {
      id,
      title: details.title,
      createdAt: Date.now(),
      details: structuredClone(details),
    });
    return `${this.origin}/${this.sessionToken}/checkpoints/${id}`;
  }

  async stop(): Promise<void> {
    await this.startPromise?.catch(() => undefined);
    const server = this.server;
    this.server = undefined;
    this.port = undefined;
    this.reports.clear();
    this.nextId = 1;
    this.sessionToken = randomBytes(16).toString("hex");
    if (!server?.listening) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async startListening(): Promise<void> {
    const template = this.templateOverride ?? await readFile(this.templatePath, "utf8");
    if (!template.includes(DATA_PLACEHOLDER)) {
      throw new Error(`Checkpoint HTML template is missing ${DATA_PLACEHOLDER}.`);
    }

    let lastError: unknown;
    for (let offset = 0; offset < MAX_PORT_ATTEMPTS; offset += 1) {
      const port = this.basePort + offset;
      if (port > 65535) break;
      const server = createServer((request, response) => this.handleRequest(template, request, response));
      try {
        await listen(server, port);
        server.unref();
        this.server = server;
        this.port = port;
        return;
      } catch (error) {
        lastError = error;
        server.close();
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EADDRINUSE" && code !== "EACCES") throw error;
      }
    }

    // OS-reserved ranges can cover the entire scan window (notably on Windows).
    // Port 0 preserves automatic availability without weakening loopback binding.
    const server = createServer((request, response) => this.handleRequest(template, request, response));
    try {
      await listen(server, 0);
      server.unref();
      this.server = server;
      this.port = (server.address() as AddressInfo).port;
    } catch (error) {
      server.close();
      throw new Error("Could not bind a localhost checkpoint report server.", {
        cause: lastError ?? error,
      });
    }
  }

  private handleRequest(template: string, request: IncomingMessage, response: ServerResponse): void {
    if (request.method !== "GET" && request.method !== "HEAD") {
      send(response, 405, "text/plain; charset=utf-8", "Method not allowed");
      return;
    }

    const url = new URL(request.url ?? "/", `http://${HOST}`);
    const rootPath = `/${this.sessionToken}`;
    if (url.pathname === "/health") {
      send(response, 200, "application/json; charset=utf-8", JSON.stringify({ ok: true }));
      return;
    }
    if (url.pathname === rootPath || url.pathname === `${rootPath}/`) {
      const latest = [...this.reports.keys()].at(-1);
      if (latest === undefined) {
        send(response, 404, "text/plain; charset=utf-8", "No checkpoint has been published in this session.");
        return;
      }
      response.writeHead(302, { Location: `${rootPath}/checkpoints/${latest}`, "Cache-Control": "no-store" });
      response.end();
      return;
    }
    if (url.pathname === `${rootPath}/checkpoints`) {
      const history = [...this.reports.values()].map((report) => ({
        id: report.id,
        title: report.title,
        createdAt: report.createdAt,
        url: `${this.origin}${rootPath}/checkpoints/${report.id}`,
      }));
      send(response, 200, "application/json; charset=utf-8", JSON.stringify(history, null, 2));
      return;
    }

    const match = url.pathname.match(new RegExp(`^/${this.sessionToken}/checkpoints/(\\d+)$`));
    const report = match ? this.reports.get(Number(match[1])) : undefined;
    if (!report) {
      send(response, 404, "text/plain; charset=utf-8", "Checkpoint report not found.");
      return;
    }

    const html = renderCheckpointHtml(template, report.details);
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    });
    response.end(request.method === "HEAD" ? undefined : html);
  }
}

export function formatSshPortForwardCommand(
  reportUrl: string,
  sshHost = process.env.RESEARCH_LOOP_SSH_HOST?.trim() || hostname(),
): string {
  const port = new URL(reportUrl).port;
  if (!port) throw new Error(`Checkpoint report URL has no port: ${reportUrl}`);
  return [
    "ssh -N \\",
    "  -o RemoteCommand=none \\",
    "  -o RequestTTY=no \\",
    `  -L ${port}:127.0.0.1:${port} \\`,
    `  ${sshHost}`,
  ].join("\n");
}

export function renderCheckpointHtml(template: string, details: CheckpointDetails): string {
  if (!template.includes(DATA_PLACEHOLDER)) throw new Error(`Missing template placeholder: ${DATA_PLACEHOLDER}`);
  const json = JSON.stringify(details)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
  return template.replace(DATA_PLACEHOLDER, json);
}

function envBasePort(): number {
  const configured = Number.parseInt(process.env.RESEARCH_LOOP_CHECKPOINT_PORT ?? "", 10);
  return Number.isInteger(configured) ? configured : DEFAULT_BASE_PORT;
}

function normalizeBasePort(value: number): number {
  return Number.isInteger(value) && value >= 1024 && value <= 65535 ? value : DEFAULT_BASE_PORT;
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, HOST);
  });
}

function send(response: ServerResponse, status: number, contentType: string, body: string): void {
  response.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store, max-age=0",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

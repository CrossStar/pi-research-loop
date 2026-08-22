import { createReadStream } from "node:fs";
import { open, readFile, realpath, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { hostname } from "node:os";
import { extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Marked, Renderer, type Tokens } from "marked";
import { CheckpointStore, type DiscoveredCheckpoint } from "./checkpoint-store.js";

const DEFAULT_HOST = "127.0.0.1";
const ALL_INTERFACES_HOST = "0.0.0.0";
const DEFAULT_BASE_PORT = 43119;
const MAX_PORT_ATTEMPTS = 100;
const MAX_JSON_PREVIEW_BYTES = 32 * 1024 * 1024;
const MAX_TEXT_PREVIEW_BYTES = 2 * 1024 * 1024;

export type CheckpointViewerHost = "127.0.0.1" | "0.0.0.0";

export interface CheckpointViewerServerOptions {
  basePort?: number;
  host?: CheckpointViewerHost;
  template?: string;
  templatePath?: string;
}

interface TocEntry {
  id: string;
  text: string;
  depth: number;
}

/** One plugin-owned Viewer for all persistent Markdown checkpoints in a project. */
export class CheckpointViewerServer {
  readonly host: CheckpointViewerHost;
  private readonly basePort: number;
  private readonly templateOverride?: string;
  private readonly templatePath: string;
  private server?: Server;
  private port?: number;
  private startPromise?: Promise<void>;

  constructor(
    readonly store: CheckpointStore,
    options: CheckpointViewerServerOptions = {},
  ) {
    this.host = options.host ?? envHost();
    this.basePort = normalizeBasePort(options.basePort ?? envBasePort());
    this.templateOverride = options.template;
    this.templatePath = options.templatePath
      ?? fileURLToPath(new URL("./checkpoint-report-template.html", import.meta.url));
  }

  get origin(): string | undefined {
    if (this.port === undefined) return undefined;
    const accessHost = this.host === ALL_INTERFACES_HOST ? hostname() : this.host;
    return `http://${accessHost}:${this.port}`;
  }

  get exposedToNetwork(): boolean {
    return this.host === ALL_INTERFACES_HOST;
  }

  get latestUrl(): string | undefined {
    return this.origin ? `${this.origin}/latest` : undefined;
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

  async stop(): Promise<void> {
    await this.startPromise?.catch(() => undefined);
    const server = this.server;
    this.server = undefined;
    this.port = undefined;
    if (!server?.listening) return;
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }

  private async startListening(): Promise<void> {
    const template = this.templateOverride ?? await readFile(this.templatePath, "utf8");
    if (!template.includes("checkpoint-viewer")) {
      throw new Error("Checkpoint Viewer template is missing its viewer root marker.");
    }

    let lastError: unknown;
    for (let offset = 0; offset < MAX_PORT_ATTEMPTS; offset += 1) {
      const port = this.basePort + offset;
      if (port > 65535) break;
      const server = this.createHttpServer(template);
      try {
        await listen(server, port, this.host);
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

    const server = this.createHttpServer(template);
    try {
      await listen(server, 0, this.host);
      server.unref();
      this.server = server;
      this.port = (server.address() as AddressInfo).port;
    } catch (error) {
      server.close();
      throw new Error(`Could not bind the Checkpoint Viewer to ${this.host}.`, { cause: lastError ?? error });
    }
  }

  private createHttpServer(template: string): Server {
    return createServer((request, response) => {
      void this.handleRequest(template, request, response).catch((error) => {
        if (response.headersSent) response.destroy(error as Error);
        else send(response, 500, "text/plain; charset=utf-8", `Checkpoint Viewer error: ${String(error)}`);
      });
    });
  }

  private async handleRequest(template: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== "GET" && request.method !== "HEAD") {
      send(response, 405, "text/plain; charset=utf-8", "Method not allowed", request.method === "HEAD");
      return;
    }

    const url = new URL(request.url ?? "/", `http://${DEFAULT_HOST}`);
    if (url.pathname === "/health") {
      send(response, 200, "application/json; charset=utf-8", JSON.stringify({ ok: true }), request.method === "HEAD");
      return;
    }
    if (url.pathname === "/" || url.pathname === "/latest" || /^\/checkpoints\/[^/]+$/.test(url.pathname)) {
      sendHtml(response, template, request.method === "HEAD");
      return;
    }
    if (url.pathname === "/api/checkpoints") {
      const checkpoints = await this.store.list();
      sendJson(response, 200, checkpoints.map((item) => historyEntry(item)), request.method === "HEAD");
      return;
    }
    if (url.pathname === "/api/latest") {
      const checkpoint = await this.store.latest();
      if (!checkpoint) {
        sendJson(response, 404, { error: "No checkpoints found." }, request.method === "HEAD");
        return;
      }
      sendJson(response, 200, renderCheckpoint(this.store, checkpoint), request.method === "HEAD");
      return;
    }
    const checkpointMatch = url.pathname.match(/^\/api\/checkpoints\/([^/]+)$/);
    if (checkpointMatch) {
      let id: string;
      try {
        id = decodeURIComponent(checkpointMatch[1]);
      } catch {
        sendJson(response, 400, { error: "Malformed checkpoint id." }, request.method === "HEAD");
        return;
      }
      const checkpoint = await this.store.find(id);
      if (!checkpoint) {
        sendJson(response, 404, { error: "Checkpoint not found." }, request.method === "HEAD");
        return;
      }
      sendJson(response, 200, renderCheckpoint(this.store, checkpoint), request.method === "HEAD");
      return;
    }
    if (url.pathname.startsWith("/api/artifacts/")) {
      await this.serveArtifactPreview(url.pathname.slice("/api/artifacts/".length), response, request.method === "HEAD");
      return;
    }
    if (url.pathname.startsWith("/artifacts/")) {
      await this.serveArtifact(url.pathname.slice("/artifacts/".length), response, request.method === "HEAD");
      return;
    }
    send(response, 404, "text/plain; charset=utf-8", "Not found", request.method === "HEAD");
  }

  private async serveArtifact(encodedPath: string, response: ServerResponse, headOnly: boolean): Promise<void> {
    const resolved = await resolveArtifactPath(this.store.projectRoot, encodedPath);
    if (resolved.status === "forbidden") {
      send(response, 403, "text/plain; charset=utf-8", "Artifact path is outside the project.", headOnly);
      return;
    }
    if (resolved.status === "missing") {
      send(response, 404, "text/plain; charset=utf-8", "Artifact not found.", headOnly);
      return;
    }
    const path = resolved.path;
    let fileStat;
    try {
      fileStat = await stat(path);
    } catch {
      send(response, 404, "text/plain; charset=utf-8", "Artifact not found.", headOnly);
      return;
    }
    if (!fileStat.isFile()) {
      send(response, 404, "text/plain; charset=utf-8", "Artifact is not a file.", headOnly);
      return;
    }
    response.writeHead(200, {
      "Content-Type": mimeType(extname(path)),
      "Content-Length": fileStat.size,
      "Cache-Control": "no-cache",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cross-Origin-Resource-Policy": "same-origin",
      "X-Content-Type-Options": "nosniff",
    });
    if (headOnly) response.end();
    else createReadStream(path).pipe(response);
  }

  private async serveArtifactPreview(encodedPath: string, response: ServerResponse, headOnly: boolean): Promise<void> {
    const resolved = await resolveArtifactPath(this.store.projectRoot, encodedPath);
    if (resolved.status === "forbidden") {
      sendJson(response, 403, { error: "Artifact path is outside the project." }, headOnly);
      return;
    }
    if (resolved.status === "missing") {
      sendJson(response, 404, { error: "Artifact not found." }, headOnly);
      return;
    }
    const path = resolved.path;
    let fileStat;
    try {
      fileStat = await stat(path);
    } catch {
      sendJson(response, 404, { error: "Artifact not found." }, headOnly);
      return;
    }
    if (!fileStat.isFile()) {
      sendJson(response, 404, { error: "Artifact is not a file." }, headOnly);
      return;
    }
    const extension = extname(path).toLowerCase();
    if (extension !== ".json" && extension !== ".csv") {
      sendJson(response, 415, { error: "Preview supports JSON and CSV only." }, headOnly);
      return;
    }
    const limit = extension === ".json" ? MAX_JSON_PREVIEW_BYTES : MAX_TEXT_PREVIEW_BYTES;
    const truncated = fileStat.size > limit;
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(Math.min(fileStat.size, limit));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      sendJson(response, 200, {
        kind: extension.slice(1),
        size: fileStat.size,
        truncated,
        text: buffer.toString("utf8", 0, bytesRead),
      }, headOnly);
    } finally {
      await handle.close();
    }
  }
}

export function formatSshPortForwardCommand(
  reportUrl: string,
  sshHost = process.env.RESEARCH_LOOP_SSH_HOST?.trim() || hostname(),
): string {
  const port = new URL(reportUrl).port;
  if (!port) throw new Error(`Checkpoint Viewer URL has no port: ${reportUrl}`);
  return `ssh -N -o RemoteCommand=none -o RequestTTY=no -L ${port}:127.0.0.1:${port} ${sshHost}`;
}

function renderCheckpoint(store: CheckpointStore, checkpoint: DiscoveredCheckpoint) {
  const { html, toc } = renderMarkdown(store, checkpoint);
  return {
    metadata: checkpoint.metadata,
    markdown_path: checkpoint.relativeMarkdownPath,
    html,
    toc,
  };
}

function renderMarkdown(store: CheckpointStore, checkpoint: DiscoveredCheckpoint): { html: string; toc: TocEntry[] } {
  const protectedMath = protectMathSegments(checkpoint.markdown);
  const toc: TocEntry[] = [];
  const usedIds = new Map<string, number>();
  const renderer = new Renderer();
  renderer.html = ({ text }) => `<pre class="raw-html">${escapeHtml(text)}</pre>`;
  renderer.heading = function ({ tokens, depth }) {
    const content = this.parser.parseInline(tokens);
    const plain = stripHtml(protectedMath.restore(content));
    const base = headingSlug(plain) || "section";
    const count = (usedIds.get(base) ?? 0) + 1;
    usedIds.set(base, count);
    const id = count === 1 ? base : `${base}-${count}`;
    if (depth >= 2 && depth <= 3) toc.push({ id, text: plain, depth });
    const className = depth === 3 && /^表\s*[0-9一二三四五六七八九十百]+[\s　.:：、—-]/.test(plain)
      ? " class=\"table-title\""
      : "";
    return `<h${depth} id="${escapeAttribute(id)}"${className}>${content}</h${depth}>\n`;
  };
  const defaultCode = renderer.code.bind(renderer);
  renderer.code = (token: Tokens.Code) => {
    if ((token.lang ?? "").trim().toLowerCase() !== "checkpoint-chart") return defaultCode(token);
    try {
      const config = JSON.parse(token.text) as unknown;
      const encoded = Buffer.from(JSON.stringify(config), "utf8").toString("base64url");
      return `<figure class="checkpoint-chart" data-chart="${encoded}"></figure>\n`;
    } catch {
      return `<pre class="chart-error"><code>${escapeHtml(token.text)}</code></pre>\n`;
    }
  };
  renderer.paragraph = function ({ tokens }) {
    const content = this.parser.parseInline(tokens);
    return tokens.length === 1 && tokens[0]?.type === "image" ? `${content}\n` : `<p>${content}</p>\n`;
  };
  renderer.image = ({ href, title, text }) => {
    const target = markdownTarget(store, checkpoint, href);
    if (!target) return `<span class="broken-artifact">[无法访问图片：${escapeHtml(text)}]</span>`;
    const caption = title || text;
    return `<figure class="checkpoint-figure"><img src="${escapeAttribute(target.url)}" alt="${escapeAttribute(text)}" loading="lazy"><figcaption>${escapeHtml(caption)}</figcaption></figure>`;
  };
  renderer.link = function ({ href, title, tokens }) {
    const label = this.parser.parseInline(tokens);
    const target = markdownTarget(store, checkpoint, href);
    if (!target) return `<span class="broken-artifact">${label}</span>`;
    const titleAttribute = title ? ` title="${escapeAttribute(title)}"` : "";
    const preview = target.previewKind
      ? ` data-preview-kind="${target.previewKind}" data-preview-url="${escapeAttribute(target.previewUrl!)}"`
      : "";
    const external = target.external ? " target=\"_blank\" rel=\"noreferrer\"" : "";
    return `<a href="${escapeAttribute(target.url)}"${titleAttribute}${preview}${external}>${label}</a>`;
  };
  const marked = new Marked({ gfm: true, breaks: false, renderer });
  const rendered = String(marked.parse(protectedMath.markdown));
  return { html: protectedMath.restore(rendered), toc };
}

function protectMathSegments(markdown: string): { markdown: string; restore: (html: string) => string } {
  let marker = "RESEARCHLOOPMATHSEGMENT";
  while (markdown.includes(marker)) marker += "X";
  const codeSegments: string[] = [];
  const mathSegments: Array<{ content: string; display: boolean }> = [];
  const stashCode = (value: string) => {
    const token = `${marker}CODE${codeSegments.length}END`;
    codeSegments.push(value);
    return token;
  };
  let protectedMarkdown = markdown
    .replace(/(```|~~~)[^]*?\1/g, stashCode)
    .replace(/(`+)[^]*?\1/g, stashCode);
  const stashMath = (content: string, display: boolean) => {
    const token = `${marker}${mathSegments.length}END`;
    mathSegments.push({ content, display });
    return token;
  };
  protectedMarkdown = protectedMarkdown
    .replace(/\$\$([^]*?)\$\$/g, (_match, content: string) => stashMath(content, true))
    .replace(/\\\[([^]*?)\\\]/g, (_match, content: string) => stashMath(content, true))
    .replace(/\\\(([^]*?)\\\)/g, (_match, content: string) => stashMath(content, false))
    .replace(/(^|[^\\$])\$(?!\$|\s)([^$\n]*?\S)\$(?!\d|\$)/g, (_match, prefix: string, content: string) => {
      return `${prefix}${stashMath(content, false)}`;
    });
  codeSegments.forEach((segment, index) => {
    protectedMarkdown = protectedMarkdown.replace(`${marker}CODE${index}END`, () => segment);
  });
  return {
    markdown: protectedMarkdown,
    restore(html: string) {
      let restored = html;
      mathSegments.forEach((segment, index) => {
        const delimiter = segment.display
          ? `\\[${escapeHtml(segment.content)}\\]`
          : `\\(${escapeHtml(segment.content)}\\)`;
        restored = restored.replaceAll(`${marker}${index}END`, () => delimiter);
      });
      return restored;
    },
  };
}

function markdownTarget(
  store: CheckpointStore,
  checkpoint: DiscoveredCheckpoint,
  href: string,
): { url: string; external: boolean; previewKind?: "json" | "csv"; previewUrl?: string } | undefined {
  if (/^(?:https?:|mailto:)/i.test(href)) return { url: href, external: true };
  if (href.startsWith("#")) return { url: href, external: false };
  if (/^[a-z][a-z\d+.-]*:/i.test(href)) return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(href.split(/[?#]/, 1)[0]);
  } catch {
    return undefined;
  }
  const absolute = resolve(checkpoint.directory, decoded);
  if (!isInside(store.projectRoot, absolute)) return undefined;
  const projectPath = toPosix(relative(store.projectRoot, absolute));
  const encoded = encodeProjectPath(projectPath);
  const extension = extname(absolute).toLowerCase();
  const previewKind = extension === ".json" ? "json" : extension === ".csv" ? "csv" : undefined;
  return {
    url: `/artifacts/${encoded}`,
    external: false,
    previewKind,
    previewUrl: previewKind ? `/api/artifacts/${encoded}` : undefined,
  };
}

function historyEntry(checkpoint: DiscoveredCheckpoint) {
  return {
    ...checkpoint.metadata,
    markdown_path: checkpoint.relativeMarkdownPath,
    url: `/checkpoints/${encodeURIComponent(checkpoint.metadata.id)}`,
  };
}

async function resolveArtifactPath(
  projectRoot: string,
  encodedPath: string,
): Promise<{ status: "ok"; path: string } | { status: "forbidden" } | { status: "missing" }> {
  let decoded: string;
  try {
    decoded = encodedPath.split("/").map((part) => decodeURIComponent(part)).join("/");
  } catch {
    return { status: "forbidden" };
  }
  const lexicalPath = resolve(projectRoot, decoded);
  if (!isInside(projectRoot, lexicalPath)) return { status: "forbidden" };
  try {
    const [realProjectRoot, realArtifactPath] = await Promise.all([realpath(projectRoot), realpath(lexicalPath)]);
    return isInside(realProjectRoot, realArtifactPath)
      ? { status: "ok", path: realArtifactPath }
      : { status: "forbidden" };
  } catch {
    return { status: "missing" };
  }
}

function encodeProjectPath(path: string): string {
  return path.split("/").map((part) => encodeURIComponent(part)).join("/");
}

function headingSlug(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[^\p{Letter}\p{Number}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]*>/g, "").replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => ({
    "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&#39;": "'",
  })[entity] ?? entity).trim();
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;").replaceAll("'", "&#39;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}

function isInside(root: string, path: string): boolean {
  const normalizedRoot = resolve(root);
  const normalizedPath = resolve(path);
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}${sep}`);
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

function mimeType(extension: string): string {
  return ({
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".json": "application/json; charset=utf-8",
    ".csv": "text/csv; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".log": "text/plain; charset=utf-8",
    ".out": "text/plain; charset=utf-8",
    ".yaml": "text/yaml; charset=utf-8",
    ".yml": "text/yaml; charset=utf-8",
    ".jsonl": "application/x-ndjson; charset=utf-8",
    ".pdf": "application/pdf",
  } as Record<string, string>)[extension.toLowerCase()] ?? "application/octet-stream";
}

function envHost(): CheckpointViewerHost {
  const configured = process.env.RESEARCH_LOOP_CHECKPOINT_HOST?.trim() || DEFAULT_HOST;
  if (configured === DEFAULT_HOST || configured === ALL_INTERFACES_HOST) return configured;
  throw new Error(`RESEARCH_LOOP_CHECKPOINT_HOST must be ${DEFAULT_HOST} or ${ALL_INTERFACES_HOST}: ${configured}`);
}

function envBasePort(): number {
  const configured = Number.parseInt(process.env.RESEARCH_LOOP_CHECKPOINT_PORT ?? "", 10);
  return Number.isInteger(configured) ? configured : DEFAULT_BASE_PORT;
}

function normalizeBasePort(value: number): number {
  return Number.isInteger(value) && value >= 1024 && value <= 65535 ? value : DEFAULT_BASE_PORT;
}

function listen(server: Server, port: number, host: CheckpointViewerHost): Promise<void> {
  return new Promise((resolveListen, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolveListen();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function sendHtml(response: ServerResponse, body: string, headOnly: boolean): void {
  response.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store, max-age=0",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  response.end(headOnly ? undefined : body);
}

function sendJson(response: ServerResponse, status: number, value: unknown, headOnly: boolean): void {
  send(response, status, "application/json; charset=utf-8", JSON.stringify(value), headOnly);
}

function send(response: ServerResponse, status: number, contentType: string, body: string, headOnly = false): void {
  response.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store, max-age=0",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(headOnly ? undefined : body);
}

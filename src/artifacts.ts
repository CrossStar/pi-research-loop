import { createReadStream, type FSWatcher, watch } from "node:fs";
import { open, opendir, readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import type { ArtifactRecord } from "./types.js";

const SUPPORTED_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".svg",
  ".csv",
  ".json",
  ".html",
  ".pdf",
  ".parquet",
]);
const TABLE_EXTENSIONS = new Set([".csv", ".parquet"]);

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

const IGNORED_DIRECTORIES = new Set([".git", ".pi", "node_modules", ".venv", "venv", "__pycache__"]);
const IGNORED_FILES = new Set([
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "composer.json",
  "settings.json",
]);

export interface ArtifactPreview {
  title: string;
  text: string;
  image?: { data: string; mimeType: string };
}

export class ArtifactRadar {
  private watcher: FSWatcher | undefined;
  private stopped = true;
  private captureDepth = 0;
  private records: ArtifactRecord[];
  private pending = new Map<string, NodeJS.Timeout>();
  private pendingDatasetEmits = new Map<string, NodeJS.Timeout>();
  private pendingNewDatasets = new Set<string>();
  private datasetMembers = new Map<string, Map<string, { size: number; mtimeMs: number }>>();
  private images = new Map<string, { data: string; mimeType: string }>();

  constructor(
    private readonly cwd: string,
    initialRecords: ArtifactRecord[],
    private readonly onArtifact: (record: ArtifactRecord, isNew: boolean) => void,
  ) {
    this.records = initialRecords.map((record) => ({ ...record, kind: record.kind ?? "file" }));
  }

  start(): void {
    this.stopped = false;
    this.watcher = watch(this.cwd, { recursive: true }, (_event, filename) => {
      if (this.captureDepth === 0 || !filename) return;
      const relativePath = filename.toString();
      if (!isCandidate(relativePath)) return;
      this.queue(relativePath);
    });
    this.watcher.on("error", () => this.stop());
  }

  stop(): void {
    this.stopped = true;
    this.watcher?.close();
    this.watcher = undefined;
    for (const timer of [...this.pending.values(), ...this.pendingDatasetEmits.values()]) clearTimeout(timer);
    this.pending.clear();
    this.pendingDatasetEmits.clear();
    this.pendingNewDatasets.clear();
  }

  beginCapture(): void {
    this.captureDepth += 1;
  }

  endCapture(): void {
    setTimeout(() => {
      this.captureDepth = Math.max(0, this.captureDepth - 1);
    }, 600);
  }

  getArtifacts(): ArtifactRecord[] {
    return [...this.records].sort((a, b) => a.discoveredAt - b.discoveredAt);
  }

  getCachedImage(record: ArtifactRecord): { data: string; mimeType: string } | undefined {
    return this.images.get(cacheKey(record));
  }

  private queue(relativePath: string): void {
    const existing = this.pending.get(relativePath);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.pending.delete(relativePath);
      void this.inspect(relativePath).catch(() => undefined);
    }, 120);
    this.pending.set(relativePath, timer);
  }

  private async inspect(relativePath: string): Promise<void> {
    const absolutePath = resolve(this.cwd, relativePath);
    let fileStat;
    try {
      fileStat = await stat(absolutePath);
    } catch {
      return;
    }
    if (!fileStat.isFile()) return;

    const normalizedPath = relative(this.cwd, absolutePath).split(sep).join("/");
    const extension = extname(normalizedPath).toLowerCase();
    if (isDatasetShard(normalizedPath, extension)) {
      this.upsertDatasetShard(normalizedPath, extension, fileStat.size, fileStat.mtimeMs);
      return;
    }

    const previous = this.records.find((record) => record.kind === "file" && record.path === normalizedPath);
    if (previous && previous.mtimeMs === fileStat.mtimeMs && previous.size === fileStat.size) return;

    const record: ArtifactRecord = {
      kind: "file",
      path: normalizedPath,
      name: basename(normalizedPath),
      extension,
      size: fileStat.size,
      mtimeMs: fileStat.mtimeMs,
      discoveredAt: Date.now(),
    };

    const mimeType = IMAGE_MIME[extension];
    if (mimeType && fileStat.size <= 12 * 1024 * 1024) {
      try {
        this.images.set(cacheKey(record), {
          data: (await readFile(absolutePath)).toString("base64"),
          mimeType,
        });
      } catch {
        // The file link remains useful when a preview cannot be loaded.
      }
    }

    if (this.stopped) return;
    if (previous) {
      this.images.delete(cacheKey(previous));
      this.records[this.records.indexOf(previous)] = record;
    } else {
      this.records.push(record);
    }
    this.onArtifact(record, previous === undefined);
  }

  private upsertDatasetShard(path: string, extension: string, size: number, mtimeMs: number): void {
    if (this.stopped) return;
    const datasetPath = dirname(path).split(sep).join("/");
    const members = this.datasetMembers.get(datasetPath) ?? new Map();
    const previousMember = members.get(path);
    if (previousMember?.size === size && previousMember.mtimeMs === mtimeMs) return;
    members.set(path, { size, mtimeMs });
    this.datasetMembers.set(datasetPath, members);

    const previous = this.records.find((record) => record.kind === "dataset" && record.path === datasetPath);
    const isNew = previous === undefined;
    const sizeDelta = size - (previousMember?.size ?? 0);
    const record: ArtifactRecord = {
      kind: "dataset",
      path: datasetPath,
      name: basename(datasetPath),
      extension,
      size: Math.max(0, (previous?.size ?? 0) + sizeDelta),
      mtimeMs: Math.max(previous?.mtimeMs ?? 0, mtimeMs),
      discoveredAt: Date.now(),
      fileCount: (previous?.fileCount ?? 0) + (previousMember ? 0 : 1),
      samplePath: previous?.samplePath ?? path,
    };

    if (previous) this.records[this.records.indexOf(previous)] = record;
    else {
      this.records.push(record);
      this.pendingNewDatasets.add(datasetPath);
    }

    const pending = this.pendingDatasetEmits.get(datasetPath);
    if (pending) clearTimeout(pending);
    this.pendingDatasetEmits.set(
      datasetPath,
      setTimeout(() => {
        this.pendingDatasetEmits.delete(datasetPath);
        const firstNotification = this.pendingNewDatasets.delete(datasetPath);
        if (!this.stopped) this.onArtifact(record, firstNotification || isNew);
      }, 300),
    );
  }
}

export async function resolveArtifactRecord(cwd: string, inputPath: string): Promise<ArtifactRecord | undefined> {
  const cleanPath = inputPath.startsWith("@") ? inputPath.slice(1) : inputPath;
  const absolutePath = resolve(cwd, cleanPath);

  try {
    const fileStat = await stat(absolutePath);
    if (fileStat.isDirectory()) return scanDatasetDirectory(cwd, absolutePath, fileStat.mtimeMs);
    if (!fileStat.isFile()) return undefined;

    const extension = extname(absolutePath).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(extension)) return undefined;
    return {
      kind: "file",
      path: relative(cwd, absolutePath).split(sep).join("/"),
      name: basename(absolutePath),
      extension,
      size: fileStat.size,
      mtimeMs: fileStat.mtimeMs,
      discoveredAt: Date.now(),
    };
  } catch {
    return undefined;
  }
}

export async function loadArtifactPreview(
  cwd: string,
  record: ArtifactRecord,
  selectedColumns?: string[],
): Promise<ArtifactPreview> {
  const targetPath = record.kind === "dataset" ? record.samplePath : record.path;
  if (!targetPath) return { title: record.name, text: datasetMetadata(record) };

  const absolutePath = resolve(cwd, targetPath);
  const metadata = record.kind === "dataset"
    ? `${datasetMetadata(record)}\nSample shard: ${targetPath}`
    : `${record.path}\n${formatSize(record.size)} | ${record.extension.slice(1).toUpperCase()}`;
  const mimeType = IMAGE_MIME[record.extension];

  if (mimeType && record.kind === "file") {
    return {
      title: record.name,
      text: metadata,
      image: { data: (await readFile(absolutePath)).toString("base64"), mimeType },
    };
  }

  if (record.extension === ".csv") {
    return { title: record.name, text: `${metadata}\n\n${await previewCsv(absolutePath, selectedColumns)}` };
  }

  if (record.extension === ".json" && record.kind === "file") {
    return { title: record.name, text: `${metadata}\n\n${await previewJson(absolutePath, record.size)}` };
  }

  if (record.extension === ".svg" && record.kind === "file") {
    const content = await readFile(absolutePath, "utf8");
    return { title: record.name, text: `${metadata}\n\n${truncate(content, 4000)}` };
  }

  if (record.extension === ".parquet") {
    return {
      title: record.name,
      text: `${metadata}\n\nParquet preview requires a local pyarrow installation.`,
    };
  }

  return { title: record.name, text: metadata };
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function isCandidate(relativePath: string): boolean {
  const normalized = relativePath.split(/[\\/]+/);
  if (normalized.some((part) => IGNORED_DIRECTORIES.has(part))) return false;
  const name = normalized.at(-1)?.toLowerCase() ?? "";
  if (IGNORED_FILES.has(name) || name.startsWith("tsconfig.")) return false;
  return SUPPORTED_EXTENSIONS.has(extname(name).toLowerCase());
}

function isDatasetShard(path: string, extension: string): boolean {
  if (!TABLE_EXTENSIONS.has(extension)) return false;
  const name = basename(path);
  return /(?:^|[-_.])(?:part|shard|chunk|batch)[-_.]?\d+/i.test(name)
    || /-\d{3,}-of-\d{3,}\./i.test(name)
    || /^\d{3,}\.(?:csv|parquet)$/i.test(name);
}

async function scanDatasetDirectory(
  cwd: string,
  absoluteDirectory: string,
  directoryMtimeMs: number,
): Promise<ArtifactRecord | undefined> {
  const queue = [absoluteDirectory];
  const maxEntries = 500;
  const maxFiles = 200;
  let entriesSeen = 0;
  let capped = false;
  const files: Array<{ path: string; extension: string; size: number; mtimeMs: number }> = [];

  while (queue.length > 0 && files.length < maxFiles && entriesSeen < maxEntries) {
    const directory = queue.shift();
    if (!directory) break;
    const handle = await opendir(directory);
    for await (const entry of handle) {
      entriesSeen += 1;
      if (entriesSeen >= maxEntries) {
        capped = true;
        break;
      }
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) queue.push(resolve(directory, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      const extension = extname(entry.name).toLowerCase();
      if (!TABLE_EXTENSIONS.has(extension)) continue;
      const path = resolve(directory, entry.name);
      const fileStat = await stat(path);
      files.push({ path, extension, size: fileStat.size, mtimeMs: fileStat.mtimeMs });
      if (files.length >= maxFiles) {
        capped = true;
        break;
      }
    }
  }

  if (files.length === 0) return undefined;
  const primaryExtension = files[0]?.extension ?? ".dataset";
  const displayPath = relative(cwd, absoluteDirectory).split(sep).join("/") || ".";
  return {
    kind: "dataset",
    path: displayPath,
    name: basename(absoluteDirectory),
    extension: primaryExtension,
    size: files.reduce((total, file) => total + file.size, 0),
    mtimeMs: Math.max(directoryMtimeMs, ...files.map((file) => file.mtimeMs)),
    discoveredAt: Date.now(),
    fileCount: files.length,
    fileCountCapped: capped,
    samplePath: relative(cwd, files[0]!.path).split(sep).join("/"),
  };
}

function datasetMetadata(record: ArtifactRecord): string {
  const count = `${record.fileCountCapped ? ">=" : ""}${record.fileCount ?? 0}`;
  return `${record.path}\nDataset | ${count} ${record.extension.slice(1).toUpperCase()} files | ${formatSize(record.size)} sampled`;
}

function cacheKey(record: ArtifactRecord): string {
  return `${record.path}:${record.mtimeMs}:${record.size}`;
}

async function previewCsv(path: string, selectedColumns?: string[]): Promise<string> {
  const input = createReadStream(path);
  const lines = createInterface({ input, crlfDelay: Infinity });
  const sample: string[] = [];
  const maxLines = 10_000;
  let lineCount = 0;
  let capped = false;

  for await (const line of lines) {
    lineCount += 1;
    if (sample.length < 6) sample.push(line);
    if (lineCount >= maxLines) {
      capped = true;
      break;
    }
  }
  if (capped) input.destroy();

  const parsed = sample.map(parseCsvLine);
  const header = parsed[0] ?? [];
  const requestedIndexes = (selectedColumns ?? [])
    .map((column) => header.indexOf(column))
    .filter((index) => index >= 0);
  const indexes = (requestedIndexes.length > 0 ? requestedIndexes : header.map((_, index) => index)).slice(0, 6);
  const rows = Math.max(0, lineCount - (lineCount > 0 ? 1 : 0));
  const rowLabel = capped ? `>=${rows}` : String(rows);
  const table = parsed
    .map((fields) => indexes.map((index) => formatCell(fields[index] ?? "")).join(" | "))
    .join("\n");
  const selection = requestedIndexes.length > 0
    ? `; selected columns: ${indexes.map((index) => header[index]).join(", ")}`
    : header.length > indexes.length ? `; showing first ${indexes.length} columns` : "";
  return `Shape: ${rowLabel} rows x ${header.length} columns${capped ? " (quick scan)" : ""}${selection}\n\n${table}`;
}

async function previewJson(path: string, size: number): Promise<string> {
  if (size > 2 * 1024 * 1024) {
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(4000);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return `Large JSON; showing the beginning only.\n\n${buffer.toString("utf8", 0, bytesRead)}\n...`;
    } finally {
      await handle.close();
    }
  }

  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  let structure: string;
  if (Array.isArray(value)) structure = `Top level: array (${value.length} items)`;
  else if (value && typeof value === "object") {
    structure = `Top-level keys: ${Object.keys(value).slice(0, 20).join(", ") || "(none)"}`;
  } else structure = `Top level: ${typeof value}`;
  return `${structure}\n\n${truncate(JSON.stringify(value, null, 2), 4000)}`;
}

function parseCsvLine(line: string): string[] {
  if (line.length === 0) return [];
  const fields: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        field += '"';
        index += 1;
      } else quoted = !quoted;
    } else if (char === "," && !quoted) {
      fields.push(field);
      field = "";
    } else field += char;
  }
  fields.push(field);
  return fields;
}

function formatCell(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= 16 ? compact : `${compact.slice(0, 15)}...`;
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}\n...`;
}

import { opendir, stat } from "node:fs/promises";
import { basename, extname, relative, resolve, sep } from "node:path";
export const SUPPORTED_ARTIFACT_EXTENSIONS = new Set([
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
const IGNORED_DIRECTORIES = new Set([".git", ".pi", ".claude", "node_modules", ".venv", "venv", "__pycache__"]);
/** Resolve file or tabular dataset metadata without any harness or preview dependency. */
export async function resolveArtifactMetadata(cwd, inputPath) {
    const cleanPath = inputPath.startsWith("@") ? inputPath.slice(1) : inputPath;
    const absolutePath = resolve(cwd, cleanPath);
    try {
        const fileStat = await stat(absolutePath);
        if (fileStat.isDirectory())
            return scanDatasetDirectory(cwd, absolutePath, fileStat.mtimeMs);
        if (!fileStat.isFile())
            return undefined;
        const extension = extname(absolutePath).toLowerCase();
        if (!SUPPORTED_ARTIFACT_EXTENSIONS.has(extension))
            return undefined;
        return {
            kind: "file",
            path: normalizePath(relative(cwd, absolutePath)),
            name: basename(absolutePath),
            extension,
            size: fileStat.size,
            mtimeMs: fileStat.mtimeMs,
            discoveredAt: Date.now(),
        };
    }
    catch {
        return undefined;
    }
}
async function scanDatasetDirectory(cwd, absoluteDirectory, directoryMtimeMs) {
    const queue = [absoluteDirectory];
    const files = [];
    let entriesSeen = 0;
    let capped = false;
    while (queue.length > 0 && files.length < 200 && entriesSeen < 500) {
        const directory = queue.shift();
        if (!directory)
            break;
        const handle = await opendir(directory);
        for await (const entry of handle) {
            entriesSeen += 1;
            if (entriesSeen >= 500) {
                capped = true;
                break;
            }
            if (entry.isDirectory()) {
                if (!IGNORED_DIRECTORIES.has(entry.name))
                    queue.push(resolve(directory, entry.name));
                continue;
            }
            if (!entry.isFile())
                continue;
            const extension = extname(entry.name).toLowerCase();
            if (!TABLE_EXTENSIONS.has(extension))
                continue;
            const path = resolve(directory, entry.name);
            const fileStat = await stat(path);
            files.push({ path, extension, size: fileStat.size, mtimeMs: fileStat.mtimeMs });
            if (files.length >= 200) {
                capped = true;
                break;
            }
        }
    }
    if (files.length === 0)
        return undefined;
    const displayPath = normalizePath(relative(cwd, absoluteDirectory)) || ".";
    return {
        kind: "dataset",
        path: displayPath,
        name: basename(absoluteDirectory),
        extension: files[0]?.extension ?? ".dataset",
        size: files.reduce((total, file) => total + file.size, 0),
        mtimeMs: Math.max(directoryMtimeMs, ...files.map((file) => file.mtimeMs)),
        discoveredAt: Date.now(),
        fileCount: files.length,
        fileCountCapped: capped,
        samplePath: normalizePath(relative(cwd, files[0].path)),
    };
}
function normalizePath(path) {
    return path.split(sep).join("/");
}

import { spawnSync } from "node:child_process";
import { Image, truncateToWidth, type Component } from "@earendil-works/pi-tui";

export interface TerminalImageOptions {
  maxWidthCells: number;
  maxHeightCells: number;
  filename?: string;
  chafaFormat?: "symbols" | "sixels";
}

interface ImageTheme {
  fallbackColor: (text: string) => string;
}

let chafaAvailable: boolean | undefined;

/** Prefer the requested Chafa renderer, then fall back to Pi's native terminal-image protocols. */
export function createTerminalImage(
  data: string,
  mimeType: string,
  theme: ImageTheme,
  options: TerminalImageOptions,
): Component {
  const fallback = new Image(data, mimeType, theme, options);
  if (!hasChafa()) return fallback;
  return new ChafaImage(data, fallback, options);
}

export function buildChafaArguments(
  format: "symbols" | "sixels",
  width: number,
  height: number,
): string[] {
  return [
    `--format=${format}`,
    "--colors=full",
    `--size=${width}x${height}`,
    "-",
  ];
}

export function formatSixelLines(output: string, rows: number): string[] {
  const sixel = output.replace(/[\r\n]+$/, "");
  const reservedRows = Math.max(1, rows);
  const rowOffset = reservedRows - 1;
  const moveUp = rowOffset > 0 ? `\u001b[${rowOffset}A` : "";
  return [...Array(rowOffset).fill(""), `${moveUp}${sixel}`];
}

export function hasChafa(): boolean {
  if (chafaAvailable !== undefined) return chafaAvailable;
  const probe = spawnSync("chafa", ["--version"], {
    encoding: "utf8",
    timeout: 1500,
    windowsHide: true,
  });
  chafaAvailable = probe.status === 0 && !probe.error;
  return chafaAvailable;
}

class ChafaImage implements Component {
  private cachedWidth?: number;
  private cachedLines?: string[];
  private failed = false;

  constructor(
    private readonly data: string,
    private readonly fallback: Component,
    private readonly options: TerminalImageOptions,
  ) {}

  render(width: number): string[] {
    if (this.failed) return this.fallback.render(width);
    const targetWidth = Math.max(1, Math.min(width, this.options.maxWidthCells));
    if (this.cachedLines && this.cachedWidth === targetWidth) return this.cachedLines;

    const result = spawnSync(
      "chafa",
      buildChafaArguments(
        this.options.chafaFormat ?? "symbols",
        targetWidth,
        this.options.maxHeightCells,
      ),
      {
        input: Buffer.from(this.data, "base64"),
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
        timeout: 5000,
        windowsHide: true,
      },
    );
    if (result.status !== 0 || result.error || !result.stdout.trim()) {
      this.failed = true;
      return this.fallback.render(width);
    }

    this.cachedWidth = targetWidth;
    if (this.options.chafaFormat === "sixels") {
      this.cachedLines = formatSixelLines(result.stdout, this.options.maxHeightCells);
      return this.cachedLines;
    }
    this.cachedLines = result.stdout
      .replaceAll("\r", "")
      .split("\n")
      .filter((line, index, lines) => line.length > 0 || index < lines.length - 1)
      .map((line) => truncateToWidth(line, targetWidth, ""));
    return this.cachedLines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
    this.fallback.invalidate();
  }
}

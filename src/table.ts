export function formatTable(headers: string[], rows: string[][], maxCellWidth = 22): string {
  const normalizedHeaders = headers.map((header) => normalizeCell(header, maxCellWidth));
  const normalizedRows = rows.map((row) =>
    headers.map((_, index) => normalizeCell(row[index] ?? "", maxCellWidth)),
  );
  const widths = normalizedHeaders.map((header, index) =>
    Math.max(header.length, ...normalizedRows.map((row) => row[index]?.length ?? 0)),
  );
  const renderRow = (row: string[]) =>
    widths.map((width, index) => (row[index] ?? "").padEnd(width)).join(" | ").trimEnd();
  const separator = widths.map((width) => "-".repeat(width)).join("-+-");
  return [renderRow(normalizedHeaders), separator, ...normalizedRows.map(renderRow)].join("\n");
}

export function formatSignificant(
  value: number,
  significantDigits = 4,
  preserveTrailingZeros = false,
): string {
  if (!Number.isFinite(value)) return String(value);
  if (value === 0) return preserveTrailingZeros ? value.toPrecision(significantDigits) : "0";

  const digits = Math.min(8, Math.max(1, significantDigits));
  const magnitude = Math.floor(Math.log10(Math.abs(value)));
  if (magnitude >= digits || magnitude <= -4) {
    const formatted = value.toExponential(digits - 1);
    return preserveTrailingZeros ? formatted : trimMantissa(formatted);
  }

  const decimalPlaces = Math.max(0, digits - magnitude - 1);
  const formatted = value.toFixed(decimalPlaces);
  return preserveTrailingZeros
    ? formatted
    : formatted.replace(/\.0+$|(?<=\.[0-9]*?)0+$/g, "").replace(/\.$/, "");
}

function normalizeCell(value: string, maxWidth: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxWidth) return compact;
  return `${compact.slice(0, Math.max(1, maxWidth - 3))}...`;
}

function trimMantissa(value: string): string {
  const [mantissa, exponent] = value.split("e");
  const trimmed = (mantissa ?? value).replace(/\.0+$|(?<=\.[0-9]*?)0+$/g, "").replace(/\.$/, "");
  return exponent === undefined ? trimmed : `${trimmed}e${exponent}`;
}

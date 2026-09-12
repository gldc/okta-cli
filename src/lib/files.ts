import Papa from "papaparse";
import readXlsxFile from "read-excel-file/node";

type Row = Record<string, string | null>;

const nonEmpty = (r: Row) => Object.values(r).some((v) => v !== undefined && v !== null && String(v).trim() !== "");

export async function csvReader(filename: string): Promise<Row[]> {
  const text = await Bun.file(filename).text();
  const parsed = Papa.parse<Row>(text, { header: true, skipEmptyLines: "greedy", delimiter: "", transformHeader: (h) => h.trim() });
  return parsed.data.map((r) => {
    const out: Row = {};
    for (const [k, v] of Object.entries(r)) if (k !== "") out[k] = v ?? "";
    return out;
  }).filter(nonEmpty);
}

// Mirrors Python's None for a blank cell: read-excel-file returns null for empty cells, and we
// keep that null rather than coercing to "". Dates format as ISO 8601; other scalars via String().
export const cellValue = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
};

export async function excelReader(filename: string): Promise<Row[]> {
  const sheets = await readXlsxFile(filename);
  const data = sheets[0]?.data ?? [];
  const [header, ...body] = data;
  const keys = (header ?? []).map((c) => String(c ?? ""));
  return body.map((cells) => Object.fromEntries(keys.map((k, i) => [k, cellValue(cells[i])])) as Row).filter(nonEmpty);
}

export async function fileReader(filename: string, opts: { jumpToUser?: string; jumpToIndex?: number; limit?: number } = {}): Promise<Row[]> {
  let rows = filename.toLowerCase().endsWith(".xlsx") ? await excelReader(filename) : await csvReader(filename);
  if (opts.jumpToUser) {
    const idx = rows.findIndex((r) => r["profile.login"] === opts.jumpToUser || r.id === opts.jumpToUser);
    rows = idx >= 0 ? rows.slice(idx) : [];
  } else if (opts.jumpToIndex) rows = rows.slice(opts.jumpToIndex);
  if (opts.limit && opts.limit > 0) rows = rows.slice(0, opts.limit);
  return rows;
}

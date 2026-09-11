import Papa from "papaparse";
import { stringify as yamlStringify } from "yaml";
import { dottedKeys, getDotted, isPlainObject, nestedToFlat } from "./dotted";

export interface OutputOptions {
  json?: boolean;
  yaml?: boolean;
  csv?: boolean;
  csvDialect?: string;
  outputFields?: string | null;
  colwidth?: number;
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (isPlainObject(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}

export function toSortedJson(value: unknown): string {
  return JSON.stringify(sortKeys(value), null, 2);
}

export function toYaml(value: unknown): string {
  return yamlStringify(value, { indent: 2 });
}

function asRows(v: unknown): Record<string, unknown>[] {
  if (Array.isArray(v)) return v.filter(isPlainObject);
  return isPlainObject(v) ? [v] : [];
}

function cell(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export function toCsv(rowsIn: unknown, dialect = "excel"): string {
  const rows = asRows(rowsIn);
  const fields = [...new Set(rows.flatMap((r) => dottedKeys(r)))].sort();
  const data = rows.map((r) => { const flat = nestedToFlat(r); return fields.map((f) => cell(flat[f])); });
  return Papa.unparse({ fields, data }, {
    delimiter: dialect === "excel-tab" ? "\t" : ",",
    newline: dialect === "unix" ? "\n" : "\r\n",
  }) + (dialect === "unix" ? "\n" : "\r\n");
}

export function toTable(rowsIn: unknown, fieldsSpec: string | null | undefined, maxLen: number | undefined, warn: (msg: string) => void): string {
  const rows = asRows(rowsIn);
  if (rows.length === 0) return "";
  const fields = fieldsSpec ? fieldsSpec.split(",") : Object.keys(rows[0]!);
  const missing = fields.map(() => false);
  const widths = fields.map((f, i) => {
    const present = rows.filter((r) => getDotted(r, f) !== undefined).map((r) => cell(getDotted(r, f)).length);
    if (present.length === 0) { warn(`WARNING: field ${f} either never filled or non-existant.`); missing[i] = true; return 1; }
    const w = Math.max(...present);
    return maxLen !== undefined ? Math.min(maxLen, w) : w;
  });
  let out = "";
  for (const r of rows) {
    fields.forEach((f, i) => {
      let v = cell(getDotted(r, f));
      if (maxLen !== undefined && v.length > maxLen) v = v.slice(0, maxLen) + "...";
      out += v.padEnd(widths[i]!) + (missing[i] ? "" : "  ");
    });
    out += "\n";
  }
  return out;
}

export function formatResult(rv: unknown, opts: OutputOptions, warn: (msg: string) => void): string | undefined {
  if (rv === undefined) return undefined;
  if (typeof rv === "string") return rv;
  if (opts.json) return toSortedJson(rv);
  if (opts.yaml) return toYaml(rv);
  if (opts.csv) return toCsv(rv, opts.csvDialect ?? "excel");
  const nonEmpty = Array.isArray(rv) ? rv.length > 0 : isPlainObject(rv) && Object.keys(rv).length > 0;
  if (opts.outputFields && nonEmpty) return toTable(rv, opts.outputFields, opts.colwidth, warn);
  return toSortedJson(rv);
}

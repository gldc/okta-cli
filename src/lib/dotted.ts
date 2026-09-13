import { ExitError } from "../okta/errors";

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function setDotted(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let cur = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i]!;
    if (!isPlainObject(cur[p])) cur[p] = {};
    cur = cur[p] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value;
}

export function flatToNested(flat: Record<string, unknown>, defaults: Record<string, unknown> = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(defaults)) setDotted(out, k, v);
  for (const [k, v] of Object.entries(flat)) setDotted(out, k, v);
  return out;
}

export function nestedToFlat(nested: Record<string, unknown>, parentKey = "", sep = "."): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(nested)) {
    const key = parentKey ? `${parentKey}${sep}${k}` : k;
    if (isPlainObject(v)) Object.assign(out, nestedToFlat(v, key, sep));
    else out[key] = v;
  }
  return out;
}

export function dottedKeys(obj: Record<string, unknown>, prePath = ""): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (isPlainObject(v)) out.push(...dottedKeys(v, `${prePath}${k}.`));
    else out.push(`${prePath}${k}`);
  }
  return out;
}

export function getDotted(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split(".")) {
    if (!isPlainObject(cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

export function parseAssignments(items: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of items) {
    const idx = item.indexOf("=");
    if (idx < 0) throw new ExitError(`Expected FIELD=value, got '${item}'`);
    out[item.slice(0, idx)] = item.slice(idx + 1);
  }
  return out;
}

export function deepMerge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k] as Record<string, unknown>, v) : v;
  }
  return out;
}

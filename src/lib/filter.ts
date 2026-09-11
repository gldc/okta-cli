import { getDotted } from "./dotted";

export function filterDicts<T>(items: T[], filters: Record<string, string>, partial: boolean): T[] {
  const entries = Object.entries(filters);
  if (entries.length === 0) return items;
  const compiled = entries.map(([k, v]) => [k, new RegExp(partial ? v.toLowerCase() : `^(?:${v.toLowerCase()})$`)] as const);
  return items.filter((item) => compiled.every(([k, re]) => {
    const v = getDotted(item, k);
    return v !== undefined && v !== null && re.test(String(v).toLowerCase());
  }));
}

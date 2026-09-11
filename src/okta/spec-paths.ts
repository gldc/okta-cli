import specPaths from "./spec-paths.json";

const templates = (specPaths as string[]).map((p) => new RegExp("^" + p.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\{[^}]+\}/g, "[^/]+") + "$"));

export function knownPath(path: string): boolean {
  const full = path.startsWith("/api/") || path.startsWith("/oauth2/") || path.startsWith("/.well-known/") ? path : `/api/v1${path.startsWith("/") ? path : `/${path}`}`;
  return templates.some((re) => re.test(full));
}

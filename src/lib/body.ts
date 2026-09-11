import { readFileSync } from "node:fs";
import { ExitError } from "../okta/errors";
import { deepMerge, flatToNested, isPlainObject, parseAssignments } from "./dotted";

export function parseBody(body: string | undefined, sets: string[] = []): unknown {
  let parsed: unknown = undefined;
  if (body !== undefined) {
    const text = body.startsWith("FILE:") ? readFileSync(body.slice(5), "utf8") : body;
    try { parsed = JSON.parse(text); } catch (e) { throw new ExitError(`Body is not valid JSON: ${(e as Error).message}`); }
  }
  if (sets.length === 0) return parsed;
  const fromSets = flatToNested(parseAssignments(sets));
  return isPlainObject(parsed) ? deepMerge(parsed, fromSets) : fromSets;
}

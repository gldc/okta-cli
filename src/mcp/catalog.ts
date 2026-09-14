import type { Command } from "commander";

export interface ToolArg {
  name: string;
  key: string; // schema property name; differs from `name` when it collides with an opt attr
  required: boolean;
  variadic: boolean;
  isPath?: boolean; // a local server-filesystem path; rejected in MCP mode
}

export interface ToolOpt {
  attr: string;
  long: string;
  kind: "boolean" | "string" | "integer" | "string[]" | "body";
  negate: boolean;
  required: boolean;
  choices?: string[];
  description: string;
  default?: unknown;
  isPath?: boolean; // a local server-filesystem path; rejected in MCP mode
  // Set when a leaf declares both `--x` and `--no-x` for the same attr (e.g. users_add's
  // --activate/--no-activate): the two commander Options are merged into one boolean
  // property, and buildArgv emits `long` for true, `negatedLong` for false.
  negatedLong?: string;
}

export interface ToolDef {
  name: string;
  path: string[];
  description: string;
  args: ToolArg[];
  opts: ToolOpt[];
  hasJson: boolean;
  hasNoConfirmation: boolean;
  readOnly: boolean;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
}

export const EXCLUDED_GROUPS = new Set(["config", "version", "mcp"]);
export const EXCLUDED_OPTS = new Set(["json", "yaml", "csv", "csvDialect", "colwidth", "outputFields", "verbose", "confirmation", "help"]);

export const WRITE_VERBS = [
  "add", "addgroup", "adduser", "create", "update", "replace", "patch", "delete", "remove", "removegroup",
  "removeuser", "revoke", "activate", "deactivate", "reactivate", "suspend", "unsuspend", "unlock", "reset", "set",
  "assign", "unassign", "clear", "expire", "link", "unlink", "publish", "rotate", "generate", "import", "bulk",
  "subscribe", "unsubscribe", "reorder", "allow", "disallow", "upload", "logo", "favicon", "background", "sync",
  "execute", "run", "retry", "enable", "disable", "promote", "opt", "verify", "send", "test", "cancel", "approve",
  "deny", "reassign", "resend", "close", "reopen", "launch", "end", "start", "stop", "move", "clone", "trigger",
  "invoke", "register", "deregister", "enroll", "unenroll", "grant", "exchange", "migrate", "rename", "preview",
  "dr", "failover", "change", "forgot", "extend", "unpublish", "resolve", "summary", "refresh", "map",
];

const DESTRUCTIVE_RE = /(^|-)(delete|remove|removeuser|revoke|deactivate|suspend|clear|expire|unlink|unassign|unsubscribe|reset|cancel|deny|end|stop|unenroll|deregister)($|-)/;

// Options that always write, regardless of leaf name: a real HTTP body, a field-setter, or a
// local file/certificate upload (which also has to be rejected as a path in MCP mode, see
// FILE_PATH_OPT_LONGS below). `--delete` (theme assets) is a mutation with no --file present.
// `--show`/`--hide` (org footer) toggle a server-side setting via POST with no --body/--set
// present - the leaf name ("footer") carries no write verb, so the option itself has to force it.
const NEVER_READ_ONLY_OPT_LONGS = new Set(["--body", "--set", "--file", "--cert", "--key", "--chain", "--delete", "--show", "--hide"]);

// Options whose value is a path read from the server's filesystem; rejected outright in MCP
// mode (src/mcp/invoke.ts) rather than passed through.
export const FILE_PATH_OPT_LONGS = new Set(["--file", "--cert", "--key", "--chain"]);

export function toolName(path: string[]): string {
  return path.map((p) => p.replace(/-/g, "_")).join("_");
}

export function humanReadableArgName(arg: { name(): string; required: boolean; variadic: boolean }): string {
  const name = arg.name() + (arg.variadic ? "..." : "");
  return arg.required ? `<${name}>` : `[${name}]`;
}

export function isReadOnly(leaf: Command, path: string[]): boolean {
  const hasJson = leaf.options.some((o) => o.attributeName() === "json");
  if (!hasJson) return false;
  if (leaf.options.some((o) => NEVER_READ_ONLY_OPT_LONGS.has(o.long ?? ""))) return false;
  const leafName = path[path.length - 1] ?? "";
  const tokens = leafName.split("-");
  if (tokens.some((t) => WRITE_VERBS.includes(t))) return false;
  return true;
}

function optKind(opt: Command["options"][number]): ToolOpt["kind"] {
  if (opt.long === "--body") return "body";
  if (opt.negate) return "boolean";
  if (!opt.required && !opt.optional) return "boolean";
  const parseArgName = (opt.parseArg as { name?: string } | undefined)?.name;
  if (parseArgName === "int" || parseArgName === "limit" || parseArgName === "pageSize") return "integer";
  if (parseArgName === "collect" || parseArgName === "collectScope" || opt.variadic) return "string[]";
  return "string";
}

function schemaForOpt(opt: ToolOpt): Record<string, unknown> {
  let schema: Record<string, unknown>;
  switch (opt.kind) {
    case "boolean":
      schema = { type: "boolean" };
      break;
    case "string":
      schema = { type: "string" };
      break;
    case "integer":
      schema = { type: "integer" };
      break;
    case "string[]":
      schema = { type: "array", items: { type: "string" } };
      break;
    case "body":
      return {
        anyOf: [{ type: "object" }, { type: "array" }, { type: "string" }],
        description: `${opt.description} Pass a JSON value; FILE: paths are not allowed.`,
      };
  }
  if (opt.choices) schema.enum = opt.choices;
  if (opt.default !== undefined) schema.default = opt.default;
  schema.description = opt.isPath ? `${opt.description} Rejected in MCP mode: local file paths are not readable by a tool call.` : opt.description;
  return schema;
}

// A leaf that declares both `--x` (positive) and `--no-x` (negate) for the same attributeName
// produces two commander Options sharing one schema property; the second silently overwrote the
// first (usually losing the positive one's description, since --no-x rarely has its own). Merge
// them into a single boolean ToolOpt that remembers both flags.
function mergeNegatedPairs(opts: ToolOpt[]): ToolOpt[] {
  const byAttr = new Map<string, ToolOpt[]>();
  for (const o of opts) byAttr.set(o.attr, [...(byAttr.get(o.attr) ?? []), o]);

  const merged: ToolOpt[] = [];
  const seen = new Set<string>();
  for (const o of opts) {
    if (seen.has(o.attr)) continue;
    seen.add(o.attr);
    const group = byAttr.get(o.attr)!;
    const pos = group.find((g) => g.kind === "boolean" && !g.negate);
    const neg = group.find((g) => g.kind === "boolean" && g.negate);
    if (group.length === 2 && pos && neg) {
      merged.push({ ...pos, negatedLong: neg.long, description: pos.description || neg.description });
    } else {
      merged.push(...group);
    }
  }
  return merged;
}

function buildOpts(leaf: Command): ToolOpt[] {
  const out: ToolOpt[] = [];
  for (const opt of leaf.options) {
    const attr = opt.attributeName();
    if (EXCLUDED_OPTS.has(attr)) continue;
    const parseArgName = (opt.parseArg as { name?: string } | undefined)?.name;
    if (parseArgName === "count") continue;
    const kind = optKind(opt);
    const toolOpt: ToolOpt = {
      attr,
      long: opt.long ?? "",
      kind,
      negate: opt.negate,
      required: opt.mandatory,
      description: opt.description,
    };
    if (opt.argChoices) toolOpt.choices = opt.argChoices;
    if (FILE_PATH_OPT_LONGS.has(toolOpt.long)) toolOpt.isPath = true;
    if (opt.negate) toolOpt.default = true;
    else if (opt.defaultValue !== undefined && !(Array.isArray(opt.defaultValue) && opt.defaultValue.length === 0)) {
      toolOpt.default = opt.defaultValue;
    }
    out.push(toolOpt);
  }
  return mergeNegatedPairs(out);
}

function buildArgs(leaf: Command, opts: ToolOpt[]): ToolArg[] {
  const optAttrs = new Set(opts.map((o) => o.attr));
  return leaf.registeredArguments.map((a) => {
    const name = a.name();
    // A positional whose name collides with an option's attributeName would otherwise share one
    // schema property and one argv slot with that option (see buildArgv); disambiguate the key.
    const key = optAttrs.has(name) ? `arg_${name}` : name;
    return { name, key, required: a.required, variadic: a.variadic, isPath: name === "file" };
  });
}

function buildDescription(leaf: Command): string {
  const base = leaf.description() ?? "";
  if (leaf.registeredArguments.length === 0) return base;
  const parts = leaf.registeredArguments.map((a) => humanReadableArgName(a));
  return `${base} Positional arguments: ${parts.join(" ")}`;
}

function buildInputSchema(args: ToolArg[], opts: ToolOpt[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const arg of args) {
    const desc = arg.isPath
      ? `Positional argument ${arg.name}. Rejected in MCP mode: local file paths are not readable by a tool call.`
      : `Positional argument ${arg.name}`;
    properties[arg.key] = arg.variadic
      ? { type: "array", items: { type: "string" }, description: desc }
      : { type: "string", description: desc };
    if (arg.required) required.push(arg.key);
  }
  for (const opt of opts) {
    properties[opt.attr] = schemaForOpt(opt);
    if (opt.required) required.push(opt.attr);
  }
  const schema: Record<string, unknown> = { type: "object", properties, additionalProperties: false };
  if (required.length > 0) schema.required = required;
  return schema;
}

function walk(cmd: Command, path: string[], out: ToolDef[]): void {
  for (const sub of cmd.commands) {
    const name = sub.name();
    const subPath = [...path, name];
    if (path.length === 0 && EXCLUDED_GROUPS.has(name)) continue;
    if (sub.commands.length === 0) {
      const opts = buildOpts(sub);
      const args = buildArgs(sub, opts);
      const hasJson = sub.options.some((o) => o.attributeName() === "json");
      const hasNoConfirmation = sub.options.some((o) => o.attributeName() === "confirmation");
      const readOnly = isReadOnly(sub, subPath);
      const leafName = subPath[subPath.length - 1] ?? "";
      out.push({
        name: toolName(subPath),
        path: subPath,
        description: buildDescription(sub),
        args,
        opts,
        hasJson,
        hasNoConfirmation,
        readOnly,
        inputSchema: buildInputSchema(args, opts),
        annotations: {
          readOnlyHint: readOnly,
          destructiveHint: !readOnly && DESTRUCTIVE_RE.test(leafName),
          idempotentHint: readOnly,
          openWorldHint: true,
        },
      });
    } else {
      walk(sub, subPath, out);
    }
  }
}

export function buildCatalog(program: Command): ToolDef[] {
  const out: ToolDef[] = [];
  walk(program, [], out);
  return out;
}

export function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

export interface CatalogFilter {
  readOnly?: boolean;
  include?: string[];
  exclude?: string[];
}

export function filterCatalog(defs: ToolDef[], f: CatalogFilter): ToolDef[] {
  let out = defs;
  if (f.readOnly) out = out.filter((d) => d.readOnly);
  if (f.include && f.include.length > 0) {
    const patterns = f.include.map(globToRegExp);
    out = out.filter((d) => patterns.some((p) => p.test(d.name)));
  }
  if (f.exclude && f.exclude.length > 0) {
    const patterns = f.exclude.map(globToRegExp);
    out = out.filter((d) => !patterns.some((p) => p.test(d.name)));
  }
  return out;
}
